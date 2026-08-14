'use strict';
/*
 * Le prix d'un nom unique.
 *
 * ---- pourquoi un nom se paie ----
 *
 * Un nom public est UNIQUE sur toute la plateforme : le prendre, c'est le
 * retirer a tous les autres, pour toujours. Gratuit, cette rarete se fait
 * ramasser par le premier qui passe — cent comptes jetables prennent cent bons
 * noms en une soiree, et plus personne ne peut s'appeler comme il veut.
 *
 * ---- ce qui est verifie ----
 *
 * Qu'on paie UNE FOIS et pas a chaque changement (facturer une faute de frappe
 * mille jetons ferait garder le nom fautif), que le montant est BRULE et non
 * encaisse, que personne n'est facture retroactivement, que le refus ne coute
 * pas un jeton, et que le paiement survit au redemarrage — sinon le joueur
 * repaie a chaque deploiement.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-nom-'));
process.env.DATA_DIR = bac;
process.env.NAME_PRICE = '1000';
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const adr = (i) => '0x' + i.toString(16).padStart(40, '0');
const riche = (g, i, s) => { const p = g._p(adr(i)); p.addr = adr(i); p.balance = WEI(s); p.hasDeposited = true; return adr(i); };
const f = (w) => Number(ethers.utils.formatUnits(w, cfg.DECIMALS));

// ============================== le prix est annonce AVANT la saisie
{
  const g = new Game();
  const a = riche(g, 1, 5000);
  const p = g.prixNom(a);
  eq(p.prix, 1000, 'le prix est annonce');
  eq(p.du, 1000, 'et il est du, puisque le joueur n a pas encore de nom');
  eq(p.brule, true, 'et il sera brule, pas encaisse');
  eq(p.solde, 5000, 'avec le solde, pour que la page sache si c est payable');
}

// ============================== on paie, et c'est BRULE
{
  const g = new Game();
  const a = riche(g, 1, 5000);
  const avantBrule = f(g.aBruler());

  g.setPublicName(a, 'Le Costaud');
  eq(g.balanceStr(a), '4000.0', 'mille jetons quittent le solde');
  eq(f(g.aBruler()) - avantBrule, 1000, 'ET ILS VONT AU TAS A BRULER, pas dans une poche');
  eq(g.comptes().brule, 1000, 'les comptes du mois le comptent comme un brulage');
  eq(g.profilPublic(a).name, 'Le Costaud', 'et le nom est pose');
}

// ============================== UNE SEULE FOIS dans sa vie
/* Facturer chaque changement ferait payer mille jetons une faute de frappe, et
   le joueur garderait le nom fautif plutot que de repayer — exactement le
   contraire de ce qu'on cherche. */
{
  const g = new Game();
  const a = riche(g, 1, 5000);
  g.setPublicName(a, 'Premier Nom');
  eq(g.balanceStr(a), '4000.0', 'la premiere fois, on paie');
  g.setPublicName(a, 'Deuxieme Nom');
  eq(g.balanceStr(a), '4000.0', 'LA DEUXIEME FOIS, C EST GRATUIT');
  g.setPublicName(a, 'Troisieme Nom');
  eq(g.balanceStr(a), '4000.0', 'et la troisieme aussi');
  eq(g.prixNom(a).du, 0, 'et la page l annonce : plus rien a payer');
}

// ============================== le refus ne coute pas un jeton
{
  const g = new Game();
  const a = riche(g, 1, 500);
  jete(() => g.setPublicName(a, 'Trop Pauvre'), /costs 1000 \$SWOGE/,
       'sans les moyens, le nom est refuse');
  eq(g.balanceStr(a), '500.0', 'ET LE SOLDE EST INTACT');
  eq(g.profilPublic(a).name, adr(1).slice(0, 6), 'le nom n a pas bouge non plus');
  eq(f(g.aBruler()), 0, 'et rien n est parti au brulage');

  /* Le message porte le CHIFFRE : « pas assez » tout seul fait ecrire au
     support, « il faut 1000, vous avez 500 » fait deposer. */
  jete(() => g.setPublicName(a, 'Trop Pauvre'), /you have 500/, 'et il dit ce qu il manque');
}

// ============================== un nom pris reste pris, et sans frais
{
  const g = new Game();
  const a = riche(g, 1, 5000), b = riche(g, 2, 5000);
  g.setPublicName(a, 'Le Costaud');
  jete(() => g.setPublicName(b, 'le costaud'), /taken/,
       'la casse ne suffit pas a prendre le nom d un autre');
  jete(() => g.setPublicName(b, 'Lé Costaud'), /taken/, 'les accents non plus');
  eq(g.balanceStr(b), '5000.0', 'et un nom refuse ne coute rien');
}

// ============================== personne n'est facture retroactivement
/* Ils sont une quinzaine a avoir deja un nom. Les faire payer pour un nom
   qu'ils ont depuis des semaines serait incomprehensible. */
{
  process.env.NAME_PRICE = '0';
  for (const m of ['./config', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
  const { Game: G0 } = require('./game');
  const avant = new G0();
  const p = avant._p(adr(1)); p.addr = adr(1); p.balance = WEI(5000);
  avant.setPublicName(adr(1), 'Ancien Joueur');           // gratuit, avant le prix
  const etat = JSON.parse(JSON.stringify(avant.serialize()));

  process.env.NAME_PRICE = '1000';
  for (const m of ['./config', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
  const { Game: G1 } = require('./game');
  const g = new G1(); g.hydrate(etat);
  eq(g.prixNom(adr(1)).du, 0, 'celui qui avait deja un nom ne doit rien');
  g.setPublicName(adr(1), 'Nouveau Nom');
  eq(g.balanceStr(adr(1)), '5000.0', 'ET IL PEUT ENCORE EN CHANGER, GRATUITEMENT');

  /* Mais un joueur NEUF, lui, paie. */
  const q = g._p(adr(9)); q.addr = adr(9); q.balance = WEI(5000);
  g.setPublicName(adr(9), 'Arrive Apres');
  eq(g.balanceStr(adr(9)), '4000.0', 'tandis qu un joueur arrive apres paie bien');
}

// ============================== le paiement survit au redemarrage
/* Sans ca, le joueur repaierait mille jetons a chaque deploiement, et personne
   ne comprendrait pourquoi. */
{
  for (const m of ['./config', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
  const { Game: G } = require('./game');
  const g = new G();
  const a = riche(g, 1, 5000);
  g.setPublicName(a, 'Le Costaud');
  const g2 = new G(); g2.hydrate(g.serialize());
  eq(g2.prixNom(a).du, 0, 'apres un redemarrage, il ne doit plus rien');
  g2.setPublicName(a, 'Autre Nom');
  eq(g2.balanceStr(a), '4000.0', 'ET IL NE REPAIE PAS');
}

// ============================== rien ne se cree, rien ne se perd
{
  for (const m of ['./config', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
  const { Game: G } = require('./game');
  const g = new G();
  const a = riche(g, 1, 5000);
  const av = g.owedBreakdown();
  const total = f(av.balances) + f(g.aBruler());
  g.setPublicName(a, 'Le Costaud');
  const ap = g.owedBreakdown();
  eq(Number((f(ap.balances) + f(g.aBruler())).toFixed(6)), Number(total.toFixed(6)),
     'AU JETON PRES : ce qui quitte le solde arrive au tas a bruler, rien ne disparait');
  ok(f(ap.balances) < f(av.balances), 'le du aux joueurs a bien baisse');
}

// ============================== a prix nul, tout redevient gratuit
{
  process.env.NAME_PRICE = '0';
  for (const m of ['./config', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
  const { Game: G } = require('./game');
  const g = new G();
  const a = riche(g, 1, 500);
  eq(g.prixNom(a).du, 0, 'a prix nul, rien n est du');
  g.setPublicName(a, 'Gratuit');
  eq(g.balanceStr(a), '500.0', 'et le nom ne coute rien');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`nom.test.js : ${n} verifications OK`);
});
