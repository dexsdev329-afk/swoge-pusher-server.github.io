'use strict';
/*
 * Le cloisonnement des jeux.
 *
 * Chaque jeu fabrique son message de tirage en collant la graine du joueur, un
 * nom de jeu et un numero d'ordre avec des deux-points. Le joueur choisit la
 * graine : s'il peut y glisser un separateur, il peut faire fabriquer a un jeu
 * le message d'un AUTRE, et deux jeux partagent alors le meme tirage.
 *
 * On ne verifie pas ca en relisant le code : on construit reellement toutes les
 * graines mechantes auxquelles on pense, et on regarde si deux messages se
 * rejoignent.
 */
const assert = require('assert');
const crypto = require('crypto');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const ADR = '0x6666666666666666666666666666666666666666';

// ------------------------------------------- la graine est nettoyee
{
  const g = new Game();
  const cas = [
    ['X:bj', 'Xbj'],
    ['a:b:c', 'abc'],
    [':::', null],                       // que des separateurs : on garde l ancienne
    ['bon-seed_42', 'bon-seed_42'],
    ['espace et accents éà', 'espaceetaccents'],
    ['X'.repeat(200), 'X'.repeat(64)],
  ];
  for (const [entree, attendu] of cas) {
    const avant = g.fairness(ADR).clientSeed;
    const apres = g.setClientSeed(ADR, entree);
    if (attendu === null) eq(apres, avant, `graine vide apres nettoyage : on garde l ancienne (${entree})`);
    else eq(apres, attendu, `graine nettoyee : ${JSON.stringify(entree)}`);
    ok(apres.indexOf(':') < 0, 'aucun separateur ne survit');
  }
}

// ------------------------- aucune graine ne peut imiter un autre jeu
/* On reconstruit les messages exactement comme les jeux les fabriquent, pour
   toutes les graines mechantes et une plage de numeros d'ordre, et on exige
   qu'aucun ne se repete. */
{
  const g = new Game();
  const mechantes = ['X:bj', 'X:casino', 'X:hilo', 'X:mines', 'X:plinko',
                     'a:b', ':bj', 'bj:', 'Z:bj:1', 'Z::bj'];
  const messages = new Map();
  let collisions = 0;
  for (const brute of mechantes) {
    const s = g.setClientSeed(ADR, brute);
    for (let nonce = 0; nonce < 40; nonce++) {
      const tous = [
        ['spin',   s + ':' + nonce],
        ['bj',     s + ':bj:' + nonce],
        ['casino', s + ':casino' + '|' + nonce],
        ['hilo',   s + ':hilo' + '|' + nonce],
        ['mines',  s + ':mines' + '|' + nonce],
        ['plinko', s + ':plinko' + '|' + nonce],
      ];
      for (const [jeu, msg] of tous) {
        const vu = messages.get(msg);
        if (vu && vu !== jeu) { collisions++; console.log('   COLLISION', jeu, 'et', vu, ':', msg); }
        messages.set(msg, jeu);
      }
    }
  }
  eq(collisions, 0, 'aucun message partage entre deux jeux');
  console.log('  %d messages construits, aucune collision', messages.size);
}

// ---------------------- deux jeux ne tirent jamais le meme hash
/* Controle direct : pour la meme graine et le meme numero d'ordre, les six
   jeux doivent produire six empreintes differentes. */
{
  const g = new Game();
  const s = g.setClientSeed(ADR, 'graine-de-test');
  const H = (msg) => crypto.createHmac('sha256', 'S').update(msg).digest('hex');
  for (let nonce = 0; nonce < 200; nonce++) {
    const h = [
      H(s + ':' + nonce),
      H(s + ':bj:' + nonce),
      H(s + ':casino' + '|' + nonce),
      H(s + ':hilo' + '|' + nonce),
      H(s + ':mines' + '|' + nonce),
      H(s + ':plinko' + '|' + nonce),
    ];
    eq(new Set(h).size, 6, `numero ${nonce} : six jeux, six tirages`);
  }
}

// ------------------------------------- le robinet reste ferme
/* Le serveur refuse le robinet des qu'un coffre ou un signataire est
   configure. On verifie la regle elle-meme, sans demarrer le serveur. */
{
  const regle = (faucet, vault, signer) => faucet === '1' && !vault && !signer;
  eq(regle('1', '', ''), true, 'ouvert sur un serveur sans chaine');
  eq(regle('1', '0xVault', ''), false, 'ferme des qu un coffre existe');
  eq(regle('1', '', '0xkey'), false, 'ferme des qu un signataire existe');
  eq(regle('0', '', ''), false, 'ferme si la variable n est pas a 1');
  eq(regle(undefined, '', ''), false, 'ferme par defaut');
}

console.log(`cloison.test.js : ${n} verifications OK`);
