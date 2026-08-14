'use strict';
/*
 * TOUS les jeux se reglent — verifie par leur VRAIE porte d'entree.
 *
 * ---- le defaut, et pourquoi il a survecu a un test ----
 *
 * Le Coin Pusher et le poker ne passaient par aucun point de reglage. Ils ne
 * comptaient donc ni pour le classement du mois, ni pour le revenu de la
 * maison, ni pour la mesure d'usage. Le jeu qui donne son nom au serveur etait
 * invisible aux trois.
 *
 * Un test existait pourtant, et il passait : il appelait `_manche(p, 'pusher',
 * …)` DIRECTEMENT. Il prouvait que le point de reglage sait compter, pas que
 * le jeu y arrive. C'est la difference entre verifier le code et verifier que
 * le code est branche — et c'est toujours la seconde qui manque.
 *
 * Ici, RIEN n'appelle `_manche`. On lache de vraies pieces avec drop() et
 * win(), on joue de vraies mains par la salle de poker, et on regarde les
 * compteurs. Un jeu qu'on debrancherait demain ferait tomber ce fichier.
 *
 * ---- ce qui est verifie ----
 *
 *   • le volume du MOIS bouge (c'est lui qui classe) ;
 *   • le REVENU de la maison bouge, et vaut mises − rendus ;
 *   • l'USAGE du jour voit le jeu, avec le bon nombre de manches ;
 *   • une piece qui tombe n'invente PAS une seconde partie ;
 *   • au poker, mises − rendus vaut exactement le rake, sans qu'on l'ait
 *     declare nulle part.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jour = () => new Date().toISOString().slice(0, 10);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);

function joueur(g, a, solde) {
  const p = g._p(a); p.addr = a; p.balance = W(solde); return p;
}
const ligne = (g, jeu) => g.usageJour(jour()).find((x) => x.jeu === jeu);

// ======================================================= LE COIN PUSHER
{
  const g = new Game();
  const A = '0x' + 'a7'.repeat(20);
  const p = joueur(g, A, 100000);

  const CHUTES = 300;
  let paye = 0, gagne = 0;
  for (let i = 0; i < CHUTES; i++) {
    const r = g.drop(A);                       // la vraie porte d'entree
    if (r && r.value > 0) { g.win(A, r.value); paye++; gagne += r.value; }
  }
  ok(paye > 0, `${paye} chutes sur ${CHUTES} ont paye — de quoi verifier les deux sens`);

  const cout = Number(cfg.DROP_COST) || 1;
  const mise = CHUTES * cout;

  // -- le classement
  eq(g._p(A).moisMise, mise,
     'le volume du MOIS compte chaque chute — c est lui qui classe');

  // -- la comptabilite
  const c = g.comptes();
  eq(c.mises, mise, 'la comptabilite voit les mises du pusher');
  eq(c.rendus, gagne, 'et ce qui a ete rendu');
  eq(Number((c.mises - c.rendus).toFixed(6)), Number(c.revenu.toFixed(6)),
     'le revenu de la maison vaut mises − rendus, sans declaration separee');
  ok(c.revenu !== 0, 'et il n est plus a zero, comme il l etait avant');

  // -- la mesure d usage
  const u = ligne(g, 'pusher');
  ok(u, 'le pusher apparait enfin dans la mesure d usage du jour');
  eq(u.manches, CHUTES,
     'avec UNE manche par chute : une piece qui tombe n invente pas une seconde partie');
  eq(u.joueurs, 1, 'et son joueur');
  eq(u.mise, mise, 'ses mises');
  eq(u.rendu, gagne, 'et ses rendus');

  // -- l historique reste lisible
  const j = g._p(A).jeux.pusher;
  eq(j.n, CHUTES, 'la fiche par jeu compte aussi une manche par chute');
}

// ============================================= LE POKER, PAR LA SALLE
{
  const { PokerRoom } = require('./poker_room');
  const g = new Game();
  const A = '0x' + 'b8'.repeat(20), B = '0x' + 'c9'.repeat(20);
  joueur(g, A, 1000000); joueur(g, B, 1000000);

  const salle = new PokerRoom(g, { rakeBps: 500 });
  ok(salle, 'la salle demarre');

  /* On ne rejoue pas une main entiere ici : le moteur de poker a son propre
     fichier de tests. Ce qu'on verifie, c'est le BRANCHEMENT — que l'evenement
     de fin de main atteigne bien le point de reglage. On lui donne donc une
     fin de main telle que la table l'emet. */
  const t = [...salle.tables.keys()][0];
  ok(t != null, 'la salle a au moins une table');
  salle.seatOf.set(A, { tableId: t, seat: 0 });
  salle.seatOf.set(B, { tableId: t, seat: 1 });

  const table = salle.tables.get(t);
  table.drainEvents = () => ([{
    type: 'handEnd', rake: 10,
    contrib: { 0: 100, 1: 100 },
    results: [{ seat: 0, amount: 190 }],
    addrs: { 0: A, 1: B },
  }]);
  salle._drain(t, Date.now());

  eq(g._p(A).moisMise, 100, 'le gagnant a mise 100 et ca compte pour le classement');
  eq(g._p(B).moisMise, 100, 'le perdant aussi — c est le VOLUME qui classe, pas le gain');

  const c = g.comptes();
  eq(c.mises, 200, 'la comptabilite voit les deux mises');
  eq(c.rendus, 190, 'et ce qui est reparti au gagnant');
  eq(Number((c.mises - c.rendus).toFixed(6)), 10,
     'mises − rendus vaut EXACTEMENT le rake, sans qu on l ait declare');

  const u = ligne(g, 'poker');
  ok(u, 'le poker apparait dans la mesure d usage');
  eq(u.manches, 2, 'une manche par joueur engage sur la main');
  eq(u.joueurs, 2, 'et deux joueurs distincts');
}

// ============ un gagnant de PLUSIEURS pots ne fabrique pas de revenu
/* Pot principal + pot lateral : ne compter que le premier ferait apparaitre
   du revenu que la maison n'a jamais encaisse. */
{
  const { PokerRoom } = require('./poker_room');
  const g = new Game();
  const A = '0x' + 'd0'.repeat(20), B = '0x' + 'e1'.repeat(20);
  joueur(g, A, 1000000); joueur(g, B, 1000000);
  const salle = new PokerRoom(g, { rakeBps: 0 });
  const t = [...salle.tables.keys()][0];
  salle.seatOf.set(A, { tableId: t, seat: 0 });
  salle.tables.get(t).drainEvents = () => ([{
    type: 'handEnd', rake: 0,
    contrib: { 0: 300, 1: 100 },
    results: [{ seat: 0, amount: 200 }, { seat: 0, amount: 200 }],  // deux pots
    addrs: { 0: A, 1: B },
  }]);
  salle._drain(t, Date.now());

  const c = g.comptes();
  eq(c.rendus, 400, 'les DEUX pots du meme gagnant sont comptes');
  eq(Number((c.mises - c.rendus).toFixed(6)), 0,
     'sans rake, la maison ne garde rien — et surtout pas 200 imaginaires');
}

console.log(`reglement.test.js : ${n} verifications OK`);
