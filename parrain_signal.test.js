'use strict';
/*
 * « Ton filleul te rapporte » — le signal, pas le calcul.
 *
 * Les gains de parrainage murissent en silence : rien n'a jamais prevenu le
 * parrain, et l'onglet « Invite » se consultait une fois puis s'oubliait. Le
 * moteur pose maintenant une note quand un filleul OUVRE le seau du jour.
 *
 * Ce qui compte ici tient en une phrase : UNE note par filleul et par JOUR.
 * Une note par manche noierait tout le reste des qu'un filleul joue vraiment
 * — et un signal qu'on coupe ne signale plus rien.
 *
 * On verifie aussi ce qui NE doit rien produire : un filleul qui gagne, un
 * filleul sans parrain, un compte qui n'a jamais depose. Un signal qui part
 * pour rien coute la confiance du seul rappel qu'on ait.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-signal-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

const A = '0x' + 'a'.repeat(40);   // le parrain
const B = '0x' + 'b'.repeat(40);   // le filleul
const C = '0x' + 'c'.repeat(40);   // un joueur sans parrain

let rates = 0;
function ok(c, quoi) { console.log((c ? '  ok   ' : '  RATE ') + quoi); if (!c) rates++; }
function eq(a, b, quoi) { ok(a === b, quoi + (a === b ? '' : '  (attendu ' + b + ', obtenu ' + a + ')')); }

function neuf() {
  const g = new Game();
  for (const a of [A, B, C]) {
    const p = g._p(a);
    p.balance = ethers.utils.parseUnits('100000', cfg.DECIMALS);
    p.hasDeposited = true;
  }
  return g;
}
const manche = (g, a, mise, rendu, jeu) => g._manche(g._p(a), jeu || 'plinko', mise, rendu);
/* Reculer le seau du jour d'un cran : c'est la seule facon de faire passer
   minuit sans attendre minuit. */
const demain = (g, f) => { for (const x of (g._p(f).attente || [])) x[0] -= 1; };

console.log('\nLe signal « ton filleul te rapporte ».\n');

// ---------------------------------------------------------- une note, une seule
let g = neuf();
g.lieParrain(B, A);
eq(g.gainsParrainRecents().length, 0, 'au depart, rien a signaler');

manche(g, B, 1000, 0);
let n = g.gainsParrainRecents();
eq(n.length, 1, 'le filleul perd : UNE note part');
eq(n[0].parrain, A, 'et elle est adressee au parrain');

eq(g.gainsParrainRecents().length, 0, 'la lire la vide — on ne la renvoie pas deux fois');

// ------------------------------------------- le meme jour ne re-signale pas
manche(g, B, 1000, 0);
manche(g, B, 1000, 0);
manche(g, B, 5000, 0);
eq(g.gainsParrainRecents().length, 0,
   'trois manches de plus le MEME JOUR : aucune note de plus');

// ---------------------------------------------------- le lendemain, une seule
demain(g, B);
manche(g, B, 1000, 0);
eq(g.gainsParrainRecents().length, 1, 'le lendemain, une note et une seule');

// ------------------------------------------------ ce qui ne doit rien produire
g = neuf();
g.lieParrain(B, A);
manche(g, B, 1000, 2000);                       // le filleul GAGNE
eq(g.gainsParrainRecents().length, 0, 'un filleul qui gagne ne signale rien');

g = neuf();
manche(g, C, 1000, 0);                          // aucun parrain
eq(g.gainsParrainRecents().length, 0, 'un joueur sans parrain ne signale rien');

g = neuf();
g._p(B).hasDeposited = false;                   // n'a jamais depose
g.lieParrain(B, A);
manche(g, B, 1000, 0);
eq(g.gainsParrainRecents().length, 0, 'un filleul qui n a jamais depose ne signale rien');

// ------------------------------------------------- deux filleuls, deux notes
g = neuf();
g.lieParrain(B, A);
g.lieParrain(C, A);
manche(g, B, 1000, 0);
manche(g, C, 1000, 0);
n = g.gainsParrainRecents();
eq(n.length, 2, 'deux filleuls qui demarrent le meme jour : deux notes');
eq(n.every((x) => x.parrain === A), true, 'toutes les deux pour le meme parrain');

console.log(rates ? '\n' + rates + ' verification(s) ratee(s)\n'
                  : '\nparrain_signal.test.js : tout passe.\n');
process.exit(rates ? 1 : 0);
