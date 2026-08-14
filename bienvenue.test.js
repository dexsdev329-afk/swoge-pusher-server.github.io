'use strict';
/*
 * Le credit d'essai : ce qu'un arrivant peut REELLEMENT ouvrir avec.
 *
 * ---- le defaut que ce fichier existe pour empecher ----
 *
 * Le bonus de bienvenue valait moins que la mise minimum du casino. Un
 * arrivant recevait donc de quoi regarder : les boutons Mines, Hi-Lo, Hold'em
 * et Three Card etaient la, cliquables, et refusaient la mise. Personne ne
 * l'avait vu parce que les deux nombres vivent a deux cents lignes d'ecart
 * dans la configuration et que rien ne les comparait.
 *
 * Ce n'est pas un reglage d'equilibrage — c'est une porte fermee sur la
 * premiere minute du produit, et c'est le seul moment ou l'on ne recoit
 * jamais de plainte : celui qui ne peut rien jouer s'en va sans le dire.
 *
 * ---- pourquoi on peut se le permettre ----
 *
 * Le credit est donne sans depot : il faut donc qu'il ne puisse pas SORTIR.
 * Il ne le peut pas, et ce fichier verrouille les trois seules sorties :
 *
 *   • le retrait demande MIN_WITHDRAW, cent fois le credit ;
 *   • le virement vers un complice demande un depot ET TRANSFER_MIN ;
 *   • les quetes, qui paient en jetons, demandent un depot.
 *
 * Un compte jetable peut donc jouer le credit, et rien d'autre. Le jour ou
 * l'une de ces trois portes s'ouvre, ce test tombe — c'est tout son emploi.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const sol = (g, a) => Number(g.balanceStr(a));

// ============================ le credit ouvre vraiment une table de casino
{
  const g = new Game();
  const donne = g.grantWelcome(A);
  eq(donne, cfg.WELCOME_BONUS, 'le credit verse est celui annonce');
  eq(sol(g, A), cfg.WELCOME_BONUS, 'et il est sur le solde');

  ok(cfg.WELCOME_BONUS >= cfg.CASINO_MIN_BET,
     `le credit (${cfg.WELCOME_BONUS}) atteint la mise minimum du casino ` +
     `(${cfg.CASINO_MIN_BET}) — sinon les jeux sont cliquables et refusent la mise`);

  /* La preuve par le jeu, pas par la comparaison de deux nombres : on ouvre
     une vraie partie avec le seul credit d'essai. */
  const partie = g.minesStart(A, cfg.CASINO_MIN_BET, 3);
  ok(partie, 'un arrivant ouvre une grille de Mines avec son credit, sans avoir depose');
  eq(sol(g, A), cfg.WELCOME_BONUS - cfg.CASINO_MIN_BET, 'la mise est debitee du credit');
}

// ============================ il en reste pour plus d'une manche
/* Une manche unique ne se distingue pas d'un ecran de chargement : le joueur
   perd, et il n'a rien appris du jeu. On demande de quoi ESSAYER. */
{
  const MANCHES_MIN = 5;
  ok(cfg.WELCOME_BONUS >= cfg.CASINO_MIN_BET * MANCHES_MIN,
     `le credit paie au moins ${MANCHES_MIN} manches de casino ` +
     `(${cfg.WELCOME_BONUS} pour ${cfg.CASINO_MIN_BET} la manche)`);
}

// ============================ il ne se verse qu'une fois
{
  const g = new Game();
  eq(g.grantWelcome(A), cfg.WELCOME_BONUS, 'premiere connexion : verse');
  eq(g.grantWelcome(A), 0, 'seconde connexion : rien');
  eq(sol(g, A), cfg.WELCOME_BONUS, 'le solde n a pas double');
}

// ================================================== LE CREDIT NE SORT PAS
/* Trois portes, une par sortie possible. C'est ce qui autorise a donner le
   credit sans exiger de depot. */
{
  // -- porte 1 : le retrait
  /* Le minimum BAISSE avec le palier : on borne donc le credit par le plus
     bas minimum atteignable, pas par MIN_WITHDRAW, qui n'est que celui du
     debut. C'est la comparaison honnete. */
  const planchier = Math.max(2000, Number(cfg.MIN_WITHDRAW) / 5);
  ok(planchier > cfg.WELCOME_BONUS,
     `le retrait minimum le plus bas du jeu (${planchier}) reste hors de portee ` +
     `du credit (${cfg.WELCOME_BONUS}) : un compte jetable ne peut rien encaisser`);
  {
    const g = new Game();
    g.grantWelcome(A);
    jete(() => g.requestWithdraw(A, String(cfg.WELCOME_BONUS)), /below minimum withdraw/,
         'et le retrait du credit entier est refuse en clair');
  }

  // -- porte 2 : le virement vers un complice
  ok(cfg.TRANSFER_REQUIRE_DEPOSIT,
     'un virement demande un depot prealable — sans quoi dix comptes jetables ' +
     'rassembleraient dix credits sur un onzieme');
  ok(Number(cfg.TRANSFER_MIN) > cfg.WELCOME_BONUS,
     `et le virement minimum (${cfg.TRANSFER_MIN}) depasse le credit de toute facon`);
  {
    const g = new Game();
    g.grantWelcome(A);
    jete(() => g.transfere(A, B, String(cfg.WELCOME_BONUS)), /deposit once/,
         'le virement est refuse tant qu on n a pas depose');
  }

  // -- porte 3 : les quetes, qui paient en jetons
  ok(cfg.QUEST_REQUIRE_DEPOSIT,
     'les quetes demandent un depot : le credit ne sert pas d amorce a une ferme');
}

// ================== une ferme de comptes jetables ne gonfle pas l'etat
/* La fiche d'un compte qui n'a fait QUE recevoir le credit doit rester
   « vide » au sens de l'elagage. Sans ca, monter le credit inviterait a
   fabriquer des fiches que la sauvegarde traine ensuite pour toujours. */
{
  const g = new Game();
  g.grantWelcome(A);
  ok(Game.estVide(g._p(A)),
     'un compte qui n a fait que recevoir le credit reste elaguable');

  g.minesStart(A, cfg.CASINO_MIN_BET, 3);
  ok(!Game.estVide(g._p(A)),
     'des qu il joue, il compte — c est le fait de JOUER qui cree la fiche, pas le credit');
}

console.log(`bienvenue.test.js : ${n} verifications OK`);
