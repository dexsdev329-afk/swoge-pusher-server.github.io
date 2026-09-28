'use strict';
/* hasard.js : engagement, tirage unique, verification ; l'algorithme publie refait les memes nombres. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const H = require('./hasard');
const casino = require('./casino');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'hasard-'));
let horloge = Date.UTC(2026, 8, 28, 21, 0);
const mk = () => H.cree({ dossier: dos, maintenant: () => horloge, shoe: casino.shoe });
const X = mk();

console.log('\n-- engager, puis tirer une fois --');
const c = X.engage();
ok(c.ok && /^[0-9a-f]{24}$/.test(c.commitment_id) && /^[0-9a-f]{64}$/.test(c.server_seed_hash) && c.algorithm === H.ALGO && !('server_seed' in c), 'l engagement publie l empreinte, jamais la graine');
const t = X.tire({ commitment_id: c.commitment_id, client_seed: 'agent-42', count: 5, min: 1, max: 6 });
ok(t.ok && t.numbers.length === 5 && t.numbers.every((x) => x >= 1 && x <= 6) && H.empreinte(t.server_seed) === c.server_seed_hash, 'le tirage revele la graine, dont l empreinte est celle promise');
const t2 = X.tire({ commitment_id: c.commitment_id, client_seed: 'autre-graine', count: 5, min: 1, max: 6 });
ok(t2.already_drawn && JSON.stringify(t2.numbers) === JSON.stringify(t.numbers) && t2.client_seed === 'agent-42', 'un deuxieme tirage rend l original : on ne rejoue pas une graine connue');
ok(mk().tire({ commitment_id: c.commitment_id }).numbers.join() === t.numbers.join(), 'relu apres un redemarrage : le meme tirage');

console.log('\n-- l algorithme publie refait les memes nombres --');
const recette = new Function('require', H.recette.split(' // ')[0] + '; return draw;')(require);
ok(JSON.stringify(recette(t.server_seed, 'agent-42', 5, 1, 6)) === JSON.stringify(t.numbers), 'le code de verify_code, execute tel quel, donne les memes nombres');
const v = X.verifie({ server_seed: t.server_seed, server_seed_hash: c.server_seed_hash, client_seed: 'agent-42', count: 5, min: 1, max: 6, numbers: t.numbers });
ok(v.hash_matches === true && v.numbers_match === true, 'fair_verify : empreinte et nombres confirmes');
ok(X.verifie({ server_seed: t.server_seed, server_seed_hash: '00'.repeat(32), client_seed: 'agent-42', count: 5, min: 1, max: 6, numbers: t.numbers.map((x) => (x % 6) + 1) }).hash_matches === false
   && X.verifie({ server_seed: t.server_seed, client_seed: 'agent-42', count: 5, min: 1, max: 6, numbers: t.numbers.map((x) => (x % 6) + 1) }).numbers_match === false, 'une empreinte ou des nombres faux : dit faux');

console.log('\n-- sans biais --');
const grand = H.nombres('a'.repeat(64), 'x', 60000, 1, 6);
const comptes = [1, 2, 3, 4, 5, 6].map((k) => grand.filter((x) => x === k).length);
const chi2 = comptes.reduce((s, o) => s + (o - 10000) ** 2 / 10000, 0);
ok(chi2 < 20.5, 'un de a 6 sur 60 000 tirages : chi2 = ' + chi2.toFixed(2) + ' (< 20,5, seuil 0,1 % a 5 degres)');
const bord = H.nombres('b'.repeat(64), 'y', 2000, 0, 2 ** 31);
ok(bord.every((x) => x >= 0 && x <= 2 ** 31) && Math.max(...bord) > 2 ** 30, 'une etendue a 2^31 + 1 : rejet correct, bornes tenues');
ok(H.nombres('s', 'c', 3, 7, 7).join() === '7,7,7', 'min = max : toujours min');

console.log('\n-- le sabot du casino SWOGE --');
const sab = X.verifie({ scheme: 'swoge-casino-shoe', server_seed: 'seed-casino', client_seed: 'joueur', nonce: 3 });
ok(sab.ok && sab.deck.join() === casino.shoe('seed-casino', 'joueur', 3).join() && sab.cards.length === 52 && new Set(sab.cards).size === 52 && /^[2-9TJQKA][cdhs]$/.test(sab.cards[0]),
   'le sabot recalcule est celui de casino.js, en 52 cartes distinctes');

console.log('\n-- les refus --');
ok(!X.tire({ commitment_id: 'inconnu', client_seed: 'a' }).ok, 'un engagement inconnu : refuse');
const c2 = X.engage();
ok(/client_seed/.test(X.tire({ commitment_id: c2.commitment_id, client_seed: '' }).erreur) && /client_seed/.test(X.tire({ commitment_id: c2.commitment_id, client_seed: 'é' }).erreur), 'graine client vide ou non ASCII : refusee');
ok(/count/.test(X.tire({ commitment_id: c2.commitment_id, client_seed: 'a', count: 101 }).erreur) && /min and max/.test(X.tire({ commitment_id: c2.commitment_id, client_seed: 'a', min: 5, max: 2 }).erreur),
   'plus de 100 nombres, ou min > max : refuse');
ok(X.tire({ commitment_id: c2.commitment_id, client_seed: 'a' }).ok, 'un refus ne consomme pas l engagement');
const c3 = X.engage();
horloge += H.TTL_MS + 1;
ok(/expired/.test(X.tire({ commitment_id: c3.commitment_id, client_seed: 'a' }).erreur), 'apres 7 jours : expire');
ok(!JSON.stringify(X.etat()).includes(t.server_seed), 'l etat public ne montre aucune graine');

fs.rmSync(dos, { recursive: true, force: true });
console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
