'use strict';
/*
 * Pierre-Feuille-Bandit : sept manches, une relance entre chacune.
 *
 * ---- ce qui est different de tous les autres duels ----
 *
 * LA MISE MONTE PENDANT LA PARTIE. Les trois autres duels debitent une fois,
 * a l'entree, et ne touchent plus a rien : leur comptabilite est vraie par
 * construction. Ici de l'argent bouge a chaque relance suivie, et c'est
 * exactement la ou une erreur ne se voit pas — un joueur debite deux fois, ou
 * pas du tout, ne s'en apercoit qu'au moment de retirer.
 *
 * Ce fichier verifie donc, en priorite :
 *
 *   • que ce qui SORT des soldes egale ce qui est engage, a chaque instant ;
 *   • qu'une relance que l'un des deux ne peut pas payer n'existe pas — pas
 *     « echoue proprement » : n'existe pas, la partie continue sans elle ;
 *   • que le pot final vaut deux fois l'engagement final, rake compris ;
 *   • que le plafond de relances tient. Sans lui, deux joueurs qui se
 *     repondent montent jusqu'a la ruine sur un jeu ou personne ne controle
 *     rien.
 *
 * Et, comme au Dernier Chiffre : le coup adverse ne descend pas dans la page.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const pf = require('./pierre_feuille_bandit');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const sol = (g, a) => Number(g.balanceStr(a));

function table(mise) {
  const p = new pf.Partie({ id: 'x', mise: mise || 100, createur: A, now: 1000, coupMs: 20000 });
  p.rejoindre(B, 1000);
  return p;
}
const j = (p, addr, c) => p.jouer(addr, c, 1000);
/** Une manche : A joue `a`, B joue `b`. */
const manche = (p, a, b) => { j(p, A, a); j(p, B, b); };

// ================================ qui bat qui, et le compte des points
{
  const p = table();
  manche(p, 'p', 'c');
  eq(p.points[1], 1, 'pierre casse ciseaux');
  eq(p.points[2], 0, 'et l autre ne marque pas');
  eq(p.historique.length, 1, 'la manche est archivee');
  eq(p.historique[0].vainqueur, 1, 'avec son vainqueur');

  /* Apres une manche gagnee, LE PERDANT peut relancer. */
  eq(p.etape, pf.RELANCE, 'la fenetre de relance s ouvre');
  eq(p.relanceur, 2, 'et elle appartient a celui qui vient de perdre');
  j(p, B, 'n');                       // il passe
  eq(p.etape, pf.COUPS_PHASE, 'il passe, on repart sur les coups');

  manche(p, 'f', 'f');
  eq(p.points[1], 1, 'une manche nulle ne marque pour personne');
  eq(p.etape, pf.COUPS_PHASE, 'et n ouvre AUCUNE relance : il ne s est rien passe');
}

// ================================ quatre manches gagnent, et on s arrete la
{
  const p = table();
  for (let i = 0; i < 4; i++) {
    manche(p, 'p', 'c');
    if (p.phase === pf.EN_COURS && p.etape === pf.RELANCE) j(p, B, 'n');
  }
  eq(p.gagnant, 1, 'quatre manches suffisent');
  eq(p.raison, 'quatre manches', 'et on le dit');
  eq(p.manche, 4, 'la partie s arrete DES qu elle est jouee, sans faire payer une relance de plus');
  jete(() => manche(p, 'p', 'c'), /not running/, 'et plus rien ne se joue apres');
}

// ================================ sept manches, puis les points
{
  const p = table();
  /* 3 a 3 et une nulle : personne n atteint quatre. */
  const suite = [['p','c'],['c','p'],['p','c'],['c','p'],['p','c'],['c','p'],['f','f']];
  for (const [a, b] of suite) {
    manche(p, a, b);
    if (p.phase === pf.EN_COURS && p.etape === pf.RELANCE) j(p, p.relanceur === 1 ? A : B, 'n');
  }
  eq(p.phase, pf.FINIE, 'sept manches jouees, la partie est finie');
  eq(p.gagnant, null, 'trois partout : nulle');
  eq(p.raison, 'a egalite', 'aux points, a egalite');
}

// ============================ LA RELANCE, ET L ARGENT QUI BOUGE
{
  const g = new Game();
  g._p(A).balance = W(10000); g._p(B).balance = W(10000);
  const p = g.duelCreer('pf', A, 100, Date.now());
  g.duelRejoindre(B, p.id, Date.now());

  eq(sol(g, A), 9900, 'A a pose sa mise a la creation');
  eq(sol(g, B), 9900, 'B a pose la sienne en s asseyant');
  eq(p.mise, 100, 'l engagement vaut la mise de depart');

  g.duelJouer(A, p.id, 'p', Date.now());
  g.duelJouer(B, p.id, 'c', Date.now());     // A gagne la manche
  eq(p.etape, pf.RELANCE, 'B peut relancer');

  g.duelJouer(B, p.id, 'r', Date.now());     // il relance
  eq(p.etape, pf.SUIVRE, 'A doit suivre ou se coucher');
  eq(sol(g, A), 9900, 'RIEN n est preleve tant que la relance n est pas suivie');
  eq(sol(g, B), 9900, 'ni chez celui qui l a offerte');

  g.duelJouer(A, p.id, 's', Date.now());     // il suit
  eq(p.mise, 200, 'l engagement monte de la mise de DEPART, pas du double');
  eq(sol(g, A), 9800, 'et les DEUX sont preleves…');
  eq(sol(g, B), 9800, '…du meme montant');
  eq(p.aDebiter.length, 0, 'la file de prelevement est videe tout de suite');
  eq(p.etape, pf.COUPS_PHASE, 'on repart sur les coups');
}

// ============ une relance que l un des deux ne peut pas payer N EXISTE PAS
{
  const g = new Game();
  g._p(A).balance = W(150); g._p(B).balance = W(10000);
  const p = g.duelCreer('pf', A, 100, Date.now());
  g.duelRejoindre(B, p.id, Date.now());
  eq(sol(g, A), 50, 'A n a plus que 50 apres sa mise');

  g.duelJouer(A, p.id, 'p', Date.now());
  g.duelJouer(B, p.id, 'c', Date.now());
  g.duelJouer(B, p.id, 'r', Date.now());     // B relance de 100
  jete(() => g.duelJouer(A, p.id, 's', Date.now()), /cannot cover the raise/,
       'A ne peut pas suivre : la relance est refusee AVANT d exister');
  eq(p.mise, 100, 'l engagement n a pas bouge');
  eq(sol(g, A), 50, 'et aucun solde n a ete touche');
  eq(p.etape, pf.SUIVRE, 'la partie attend toujours sa reponse — il peut encore se coucher');

  g.duelJouer(A, p.id, 'x', Date.now());
  eq(p.gagnant, 2, 'se coucher donne la partie a celui qui a relance');
  eq(p.raison, 'couche', 'et on le dit');
}

// ================================ LE PLAFOND DE RELANCES TIENT
{
  const g = new Game();
  g._p(A).balance = W(100000); g._p(B).balance = W(100000);
  const p = g.duelCreer('pf', A, 100, Date.now());
  g.duelRejoindre(B, p.id, Date.now());

  let relancesFaites = 0;
  for (let m = 0; m < 6 && p.phase === pf.EN_COURS; m++) {
    /* On alterne les vainqueurs pour que personne n atteigne quatre trop
       vite, et le perdant relance a chaque fois. */
    if (m % 2 === 0) { g.duelJouer(A, p.id, 'p', Date.now()); g.duelJouer(B, p.id, 'c', Date.now()); }
    else { g.duelJouer(A, p.id, 'c', Date.now()); g.duelJouer(B, p.id, 'p', Date.now()); }
    if (p.phase !== pf.EN_COURS) break;
    if (p.etape === pf.RELANCE) {
      const qui = p.relanceur === 1 ? A : B;
      g.duelJouer(qui, p.id, 'r', Date.now());
      g.duelJouer(p.relanceur === 1 ? B : A, p.id, 's', Date.now());
      relancesFaites++;
    }
  }
  eq(p.relances, pf.RELANCES_MAX, `au plus ${pf.RELANCES_MAX} relances, jamais plus`);
  eq(p.mise, 100 * (1 + pf.RELANCES_MAX), 'donc au plus quatre fois la mise de depart');
  eq(sol(g, A), 100000 - p.mise, 'A a paye exactement ce qui est engage');
  eq(sol(g, B), 100000 - p.mise, 'B aussi');
}

// ============ LE POT FINAL VAUT L ENGAGEMENT FINAL, DES DEUX COTES
{
  const g = new Game();
  g._p(A).balance = W(100000); g._p(B).balance = W(100000);
  const avant = sol(g, A) + sol(g, B);
  const p = g.duelCreer('pf', A, 1000, Date.now());
  g.duelRejoindre(B, p.id, Date.now());

  g.duelJouer(A, p.id, 'p', Date.now()); g.duelJouer(B, p.id, 'c', Date.now());
  g.duelJouer(B, p.id, 'r', Date.now()); g.duelJouer(A, p.id, 's', Date.now());
  eq(p.mise, 2000, 'chacun a engage 2000');

  for (let i = 0; i < 3 && p.phase === pf.EN_COURS; i++) {
    g.duelJouer(A, p.id, 'p', Date.now()); g.duelJouer(B, p.id, 'c', Date.now());
    if (p.phase === pf.EN_COURS && p.etape === pf.RELANCE) g.duelJouer(B, p.id, 'n', Date.now());
  }
  eq(p.gagnant, 1, 'A gagne la partie');

  const apres = sol(g, A) + sol(g, B);
  const rake = 2 * p.mise * (cfg.PF_RAKE_BPS / 10000);
  ok(Math.abs((avant - apres) - rake) < 0.001,
     `ce qui a disparu des deux soldes vaut EXACTEMENT la commission ` +
     `(${(avant - apres).toFixed(2)} contre ${rake.toFixed(2)} attendus)`);
  eq(sol(g, B), 100000 - p.mise, 'le perdant a perdu son engagement, ni plus ni moins');
  eq(Math.round(sol(g, A)), Math.round(100000 - p.mise + 2 * p.mise - rake),
     'et le gagnant encaisse le pot moins la commission');
}

// ================================ LE COUP ADVERSE NE SORT PAS
{
  const p = table();
  j(p, A, 'p');
  const vuParB = p.etat(1000, B);
  eq(vuParB.choix[1], null, 'B ne voit pas le coup de A');
  eq(vuParB.verrouille[1], true, 'seulement qu il a joue');
  const spectateur = p.etat(1000);
  eq(spectateur.choix[1], null, 'un spectateur non plus, ni un appel sans destinataire');

  j(p, B, 'c');
  const apres = p.etat(1000, B);
  eq(apres.choix[1], null, 'la manche resolue, les choix courants sont remis a zero');
  eq(apres.historique[0][1], 'p',
     'mais l HISTORIQUE est public — lire les habitudes de l adversaire EST le jeu');
  eq(apres.historique[0][2], 'c', 'les deux coups y sont');
}

// ================================ ce qui est refuse
{
  const p = table();
  jete(() => j(p, A, 'z'), /rock, paper or scissors/, 'un coup inconnu');
  jete(() => j(p, '0x' + 'cc'.repeat(20), 'p'), /not in this match/, 'un inconnu a la table');
  j(p, A, 'p');
  jete(() => j(p, A, 'f'), /already locked/, 'ON NE SE RAVISE PAS');
  j(p, B, 'c');
  jete(() => j(p, A, 'r'), /not yours to make/, 'la relance appartient au perdant de la manche');
  jete(() => j(p, B, 'z'), /raise or pass/, 'et elle se relance ou se passe, rien d autre');
  j(p, B, 'r');
  jete(() => j(p, B, 's'), /waiting for the other/, 'on ne suit pas sa propre relance');
  jete(() => j(p, A, 'z'), /call or fold/, 'on suit ou on se couche');
}

// ============ se taire ne vaut jamais mieux que jouer
{
  const p = table();
  j(p, A, 'p');
  p.tick(999999999);
  eq(p.gagnant, 1, 'celui qui a joue gagne contre celui qui s est tu');

  const q = table();
  q.tick(999999999);
  eq(q.gagnant, null, 'personne n a joue : rien ne s est passe, les mises reviennent');

  /* Sur une relance en attente, le silence vaut PASSER, pas se coucher : une
     connexion qui tombe ne doit pas couter la partie. */
  const r = table();
  manche(r, 'p', 'c');
  eq(r.etape, pf.RELANCE, 'la relance est ouverte');
  r.tick(999999999);
  eq(r.phase, pf.EN_COURS, 'le temps qui passe ne termine pas la partie…');
  eq(r.etape, pf.COUPS_PHASE, '…il fait seulement passer la relance');
}

console.log(`bandit.test.js : ${n} verifications OK`);
