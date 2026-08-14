'use strict';
/*
 * Ce qu'on peut se dire a la table.
 *
 * L'interet de la fonctionnalite tient entierement dans ce qu'elle REFUSE. Une
 * liste fermee n'a de valeur que si elle est fermee cote SERVEUR : si le seul
 * gardien est la page, il suffit d'ouvrir la console pour envoyer ce qu'on
 * veut, et on a rouvert exactement la surface qu'on croyait avoir fermee. On
 * essaie donc reellement de passer a travers.
 *
 * Le reste protege la table : on ne parle pas a une table ou l'on n'est pas
 * assis, on ne parle pas a une partie finie, et on ne repete pas la meme
 * phrase quinze fois d'affilee.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), C = '0x' + 'cc'.repeat(20);

function table(g, jeu) {
  for (const a of [A, B, C]) g._p(a).balance = ethers.utils.parseUnits('100000', cfg.DECIMALS);
  const m = g.duelCreer(jeu || 'mp', A, 1000, 1000);
  g.duelRejoindre(B, m.id, 2000);
  return m;
}

// ================================================= ce qui ne passe pas
{
  const g = new Game();
  const m = table(g);
  let t = 10000;

  /* Le controle qui porte tout le reste : rien qui ne figure pas dans la
     liste ne doit passer, quelle que soit la forme envoyee. */
  const tentatives = [
    'tu es nul', '<script>alert(1)</script>', '', null, undefined, 0, 42,
    'GG', ' gg', 'gg ', 'hi\n', '__proto__', 'constructor', 'toString',
    { toString: () => 'gg' }, ['gg'],
  ];
  for (const x of tentatives)
    jete(() => g.duelDire(A, m.id, x, t += 5000), /unknown phrase/,
         `refuse ${JSON.stringify(x) || String(x)}`);

  /* Et ce qui passe rend le TEXTE tel qu'il est ecrit dans la configuration,
     pas ce que le client a envoye : c'est la meme garantie, vue de l'autre
     cote. */
  const dit = g.duelDire(A, m.id, 'gg', t += 5000);
  eq(dit.texte, cfg.PHRASES.find((p) => p[0] === 'gg')[2],
     'le texte rendu est celui du serveur');
  ok(dit.emote, 'et il vient avec son emote');
}

// ----------------------------------------- on ne parle qu a sa propre table
{
  const g = new Game();
  const m = table(g);
  jete(() => g.duelDire(C, m.id, 'gg', 20000), /not at this table/,
       'un tiers ne parle pas a une table ou il n est pas assis');
  jete(() => g.duelDire(A, 'mp-nexiste-pas', 'gg', 20000), /match not found/,
       'ni a une table qui n existe pas');
}

// --------------------------------------- ni avant, ni apres la partie
{
  const g = new Game();
  for (const a of [A, B]) g._p(a).balance = ethers.utils.parseUnits('100000', cfg.DECIMALS);
  const m = g.duelCreer('mp', A, 1000, 1000);
  jete(() => g.duelDire(A, m.id, 'gl', 1500), /not running/,
       'une table qui attend encore un adversaire est muette');
  g.duelRejoindre(B, m.id, 2000);
  ok(g.duelDire(A, m.id, 'gl', 3000), 'des que la partie tourne, on peut parler');
  g.duelAbandonner(A, m.id, 4000);
  jete(() => g.duelDire(A, m.id, 'gg', 20000), /not running/,
       'et une fois finie, elle redevient muette');
}

// ----------------------------------------------- on ne peut pas marteler
{
  const g = new Game();
  const m = table(g);
  g.duelDire(A, m.id, 'nice', 10000);
  jete(() => g.duelDire(A, m.id, 'nice', 10000 + cfg.PHRASE_PAUSE_MS - 1), /slow down/,
       'deux phrases collees sont refusees');
  ok(g.duelDire(A, m.id, 'nice', 10000 + cfg.PHRASE_PAUSE_MS), 'la pause passee, on peut reparler');
  /* La pause est PAR JOUEUR : celle de l'un ne doit pas bailonner l'autre. */
  ok(g.duelDire(B, m.id, 'wow', 10000 + cfg.PHRASE_PAUSE_MS),
     'et la pause de l un ne fait pas taire l autre');
}

// ------------------------------------------------------- le plafond
{
  const g = new Game();
  const m = table(g);
  let t = 10000;
  for (let i = 0; i < cfg.PHRASE_MAX; i++) {
    const d = g.duelDire(A, m.id, 'gg', t += cfg.PHRASE_PAUSE_MS);
    eq(d.reste, cfg.PHRASE_MAX - i - 1, `il reste ${cfg.PHRASE_MAX - i - 1} phrases`);
  }
  /* Passe le plafond, le refus doit dire QUOI : « ralentissez » relance le
     joueur toutes les trois secondes pour rien. */
  jete(() => g.duelDire(A, m.id, 'gg', t += 60000), /said enough/,
       'le plafond atteint, on se tait — et on sait pourquoi');
  ok(g.duelDire(B, m.id, 'gg', t += cfg.PHRASE_PAUSE_MS),
     'le plafond est par joueur, pas par table');
}

// ------------------------------------- chaque phrase de la liste fonctionne
/* Un bouton affiche que le serveur refuserait serait pire que pas de bouton :
   le joueur clique, rien ne se passe, et il ne sait pas pourquoi. */
{
  const g = new Game();
  let t = 10000;
  for (const [id, emote, texte] of cfg.PHRASES) {
    const m = table(g, 'mp');
    const d = g.duelDire(A, m.id, id, t += cfg.PHRASE_PAUSE_MS);
    eq(d.id, id, `« ${texte} » passe`);
    ok(emote && texte, `« ${id} » a bien un emote et un texte`);
    g.duelAbandonner(A, m.id, t += 1000);
  }
  eq(new Set(cfg.PHRASES.map((p) => p[0])).size, cfg.PHRASES.length,
     'aucun identifiant en double dans la liste');
}

// ------------------------------------ les trois duels parlent la meme langue
{
  for (const jeu of ['p4', 'mp', 'dm']) {
    const g = new Game();
    const m = table(g, jeu);
    const d = g.duelDire(B, m.id, 'hi', 10000);
    eq(d.joueur, 2, `${jeu} : celui qui s est assis est le joueur 2`);
  }
}

console.log(`phrases.test.js : ${n} verifications OK`);
