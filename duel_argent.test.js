'use strict';
/*
 * Le morpion et les dames branches a l'argent.
 *
 * Les regles sont verifiees a part (duel.test.js). Ici on verifie le
 * RACCORDEMENT, et surtout qu'il est bien LE MEME que celui du Connect 4 :
 * les trois jeux passent par un seul chemin d'argent, et c'est cela qu'il
 * faut prouver — sinon on aurait trois chemins qui divergeraient au premier
 * correctif.
 *
 * Le controle qui compte reste la CONSERVATION : a la fin, ce que les joueurs
 * ont plus ce que la maison a preleve doit valoir exactement ce qu'ils avaient
 * avant. Un jeton cree ou perdu se voit la, meme s'il se cache.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-duel-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const dm = require('./dames');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const sol = (g, a) => Number(g.balanceStr(a));
const total = (g) => sol(g, A) + sol(g, B);

function neuf(credit = 1000000) {
  const g = new Game();
  for (const a of [A, B]) {
    g._p(a).balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
    g._p(a).hasDeposited = true;
  }
  return g;
}

// ================================================== le morpion, de bout en bout
{
  const g = neuf();
  const avant = total(g);
  const m = g.duelCreer('mp', A, 1000, 1000);
  eq(sol(g, A), 1000000 - 1000, 'la mise part des la creation');
  eq(g.duelLobby('mp').length, 1, 'la table s affiche dans le vestibule du morpion');
  eq(g.duelLobby('p4').length, 0, 'et PAS dans celui du Connect 4');

  g.duelRejoindre(B, m.id, 1100);
  eq(sol(g, B), 1000000 - 1000, 'l adversaire paie en s asseyant');

  /* LE TRAIT EST TIRE AU SORT depuis que le createur n'ouvre plus d'office.
     Le test ne peut donc plus ecrire l'ordre des coups en dur : il fait gagner
     CELUI QUI OUVRE, quel qu'il soit, et verifie l'argent sur lui. */
  const ouvre = m.tour === 1 ? A : B;
  const suit  = ouvre === A ? B : A;
  let t = 1200;
  for (const [addr, c] of [[ouvre, 0], [suit, 3], [ouvre, 1], [suit, 4], [ouvre, 2]]) { g.duelJouer(addr, m.id, c, t); t += 100; }
  eq(m.phase, 'finie', 'la partie est finie');
  eq(m.adresseGagnante(), ouvre, 'celui qui ouvre a aligne la premiere rangee');

  const pot = 2000, rake = Math.floor(pot * cfg.MP_RAKE_BPS / 10000);
  eq(sol(g, ouvre), 1000000 - 1000 + (pot - rake), 'le gagnant ramasse le pot moins la commission');
  eq(total(g), avant - rake, 'et rien ne se perd : tout est chez les joueurs ou chez la maison');
}

// ---------------------------------------- la partie nulle rend les deux mises
/* Le morpion est nul a jeu parfait : c'est l'issue la plus frequente entre
   deux joueurs attentifs, et elle ne doit rien couter. */
{
  const g = neuf();
  const avant = total(g);
  const m = g.duelCreer('mp', A, 5000, 1000);
  g.duelRejoindre(B, m.id, 1100);
  /* Meme raison qu'au-dessus : c'est CELUI QUI OUVRE qui joue les coups
     impairs, et le tirage decide qui c'est. La suite de cases, elle, ne change
     pas — elle donne une grille pleine sans alignement. */
  const ouv = m.tour === 1 ? A : B, sui = ouv === A ? B : A;
  let t = 1200;
  [0, 1, 2, 4, 3, 5, 7, 6, 8].forEach((c, k) => { g.duelJouer(k % 2 === 0 ? ouv : sui, m.id, c, t); t += 100; });
  eq(m.gagnant, null, 'personne ne gagne');
  eq(total(g), avant, 'chacun a repris exactement sa mise');
}

// ================================================= les dames, de bout en bout
{
  const g = neuf();
  const avant = total(g);
  const m = g.duelCreer('dm', A, 20000, 1000);
  g.duelRejoindre(B, m.id, 1100);
  eq(m.phase, 'en_cours', 'la partie demarre quand l adversaire s assied');
  eq(g.duelEtat(m.id, 1100).legaux.length, 7, 'et le navigateur recoit ses sept coups possibles');

  /* On plante une position gagnee plutot que de jouer trente coups : ce qui
     est verifie ici, c'est l'ARGENT, pas les regles. */
  m.grille = new Array(dm.CASES).fill(0);
  m.grille[42] = dm.PION1; m.grille[35] = dm.PION2;
  /* LE TRAIT FAIT PARTIE DE LA POSITION. On plante la grille, on plante donc
     aussi a qui c'est de jouer — sans quoi le test dependrait du tirage au
     sort qui decide desormais qui ouvre. */
  m.tour = 1;
  g.duelJouer(A, m.id, { de: 42, vers: 28 }, 1200);
  eq(m.phase, 'finie', 'plus une piece en face : la partie est finie');
  eq(m.adresseGagnante(), A, 'et A a gagne');

  const pot = 40000, rake = Math.floor(pot * cfg.DM_RAKE_BPS / 10000);
  eq(sol(g, A), 1000000 - 20000 + (pot - rake), 'le gagnant ramasse');
  eq(total(g), avant - rake, 'la conservation tient aussi aux dames');
}

// ------------------------------ une seule partie a la fois, TOUS JEUX CONFONDUS
/* C'est le point ou trois jeux separes se seraient trompes : un joueur qui
   engage sa mise au morpion ne doit pas pouvoir engager la meme aux dames. */
{
  const g = neuf(1000);
  g.duelCreer('mp', A, 500, 1000);
  jete(() => g.duelCreer('dm', A, 500, 1100), /already have a match/,
       'une partie de morpion en cours empeche d ouvrir une table de dames');
  eq(sol(g, A), 500, 'et la deuxieme mise n a jamais quitte le solde');
}

// ---------------------------------------- la revanche garde le meme jeu
{
  const g = neuf();
  const m = g.duelCreer('dm', A, 1000, 1000);
  g.duelRejoindre(B, m.id, 1100);
  g.duelAbandonner(B, m.id, 1200);
  const r = g.duelRevanche(A, m.id, 2000, 1300);
  eq(r.jeu, 'dm', 'la revanche d une partie de dames est une partie de dames');
  eq(r.reserve, B, 'elle est reservee a l adversaire');
  eq(g.duelInvitations(B, 1400, 'dm').length, 1, 'qui la voit arriver');
  eq(g.duelLobby('dm').length, 0, 'et elle ne traine pas dans le vestibule public');
}

// -------------------------------------- le temps ecoule paie quand meme
{
  const g = neuf();
  const avant = total(g);
  const m = g.duelCreer('mp', A, 3000, 1000);
  g.duelRejoindre(B, m.id, 1100);
  /* Qui a la main est TIRE AU SORT : on releve le tirage avant le tick,
     puisque c'est lui qui designe le perdant. */
  const devait = m.tour;
  const evs = g.duelTick(1100 + cfg.MP_COUP_MS + 1);
  eq(evs.length, 1, 'la partie tombe au temps');
  eq(m.gagnant, devait === 1 ? 2 : 1, 'celui qui devait jouer perd');
  const rake = Math.floor(6000 * cfg.MP_RAKE_BPS / 10000);
  eq(total(g), avant - rake, 'et le pot est bien verse, commission comprise');
}

// ------------------------- une table sans preneur rend la mise, tous jeux
{
  const g = neuf();
  const avant = total(g);
  const m1 = g.duelCreer('mp', A, 4000, 1000);
  const m2 = g.duelCreer('dm', B, 7000, 1000);
  eq(total(g), avant - 11000, 'les deux mises sont parties');
  g.duelTick(1000 + Math.max(cfg.MP_ATTENTE_MS, cfg.DM_ATTENTE_MS) + 1);
  eq(m1.phase, 'finie', 'la table de morpion a expire');
  eq(m2.phase, 'finie', 'celle de dames aussi');
  eq(total(g), avant, 'et TOUT est revenu : une table sans preneur ne coute rien');
}

// ------------------------------- on ne paie pas deux fois le meme gagnant
/* Un abandon suivi d'un tick, ou deux abandons : le reglement ne doit tomber
   qu'une seule fois. C'est la faute qui cree de l'argent a partir de rien. */
{
  const g = neuf();
  const avant = total(g);
  const m = g.duelCreer('dm', A, 10000, 1000);
  g.duelRejoindre(B, m.id, 1100);
  g.duelAbandonner(B, m.id, 1200);
  const apres = total(g);
  g.duelTick(1200 + cfg.DM_COUP_MS + 1);
  jete(() => g.duelAbandonner(B, m.id, 1300), /not running/, 'on n abandonne pas deux fois');
  eq(total(g), apres, 'et le solde n a pas bouge d un jeton apres le premier reglement');
  eq(avant - apres, Math.floor(20000 * cfg.DM_RAKE_BPS / 10000), 'seule la commission manque');
}

// ------------------- une partie interrompue par un REDEMARRAGE rend les mises
/*
 * CE QUI POUVAIT ARRIVER : les parties ne sont pas sauvegardees avec l'etat.
 * Les mises, elles, avaient bel et bien quitte les soldes et etaient ecrites
 * sur le disque. Un redemarrage au milieu d'une partie faisait donc
 * disparaitre la table AVEC l'argent — deux mises perdues, sans trace.
 */
{
  const g = neuf();
  const avant = total(g);
  const m = g.duelCreer('dm', A, 50000, 1000);
  g.duelRejoindre(B, m.id, 1100);
  eq(total(g), avant - 100000, 'les deux mises sont engagees');

  const g2 = new Game();
  g2.hydrate(g.serialize());
  eq(Number(g2.balanceStr(A)) + Number(g2.balanceStr(B)), avant,
     'apres redemarrage, les deux mises sont RENDUES — rien ne disparait avec la table');
  eq(g2.duelMienne(A), null, 'et plus personne n est retenu dans une partie fantome');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`duel_argent.test.js : ${n} verifications OK`);
});
