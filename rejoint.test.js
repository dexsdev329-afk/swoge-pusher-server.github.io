'use strict';
/*
 * REJOINDRE UN AMI DANS LE MONDE DE COMBAT.
 *
 * Un bouton qui teleporte est surtout une liste de choses qu'il ne doit PAS
 * faire. Chacune protege quelque chose de different, et aucune n'est
 * rattrapable une fois la porte ouverte :
 *
 * 1. PAS D'AMITIE, PAS DE SAUT. Sans ce verrou, n'importe qui se pose a cote
 *    de n'importe qui : on traverse la carte gratuitement, et l'anneau de lave
 *    — le plus dur du jeu — s'atteint au niveau trois en cliquant un nom.
 * 2. PAS LE MEME MONDE, PAS DE SAUT. On ne se teleporte pas DANS un donjon :
 *    il s'ouvre en abattant Optimus, et y entrer par la liste des amis rendrait
 *    cette porte decorative. Le refus compare les deux SIMULATIONS — pas un
 *    drapeau qu'on pourrait oublier de poser quelque part.
 * 3. ON ARRIVE A COTE, PAS DESSUS. Deux personnages exactement superposes ne
 *    se distinguent plus, et celui qui saute masque celui qu'il rejoint.
 * 4. L'AMITIE EST VERIFIEE DANS LES DEUX SENS. Une liste reparee a la main ou
 *    une restauration partielle pourrait n'en garder qu'un cote, et un saut
 *    qui marche dans un sens et pas dans l'autre se lit comme une panne.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/rejoint-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Game } = require('./game');
const { Realm } = require('./realm');
const M = require('./monde');
const P = require('./personnages');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; console.log('  ok   ' + m); };

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const C = '0x' + 'c3'.repeat(20);
const FICHE = { skin: 'andy', nom: 'X', famille: 'lame',
                degats: P.DEGATS_ARME.commun,
                stats: { hp: 900, mp: 300, att: 40, def: 20 } };

function alea(g) { let s = g >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ================== 1. L AMITIE, DANS LES DEUX SENS
console.log('\n-- qui est un ami --');
{
  const g = new Game();
  for (const a of [A, B]) { const p = g._p(a); p.amis = []; }
  eq(g.sontAmis(A, B), false, 'deux inconnus ne sont pas amis');
  g._p(A).amis.push(B.toLowerCase());
  eq(g.sontAmis(A, B), false,
     'une liste qui ne porte QU UN cote ne suffit pas : ce serait une panne a sens unique');
  g._p(B).amis.push(A.toLowerCase());
  eq(g.sontAmis(A, B), true, 'les deux cotes, et c est un ami');
  eq(g.sontAmis(A, A), false, 'on n est pas son propre ami');
  eq(g.sontAmis(A, C), false, 'et un compte qui n existe pas non plus');
}

/* ---- LE MEME REFUS QUE LE SERVEUR, ECRIT ICI UNE FOIS ----
 * server.js tient la route ; cet essai rejoue sa DECISION sur les memes
 * objets. Ce qu'on verifie, c'est la regle — « meme simulation, amitie des
 * deux cotes, on arrive a cote » — et elle ne depend d'aucune socket. */
function saut(g, R, moiAddr, cibleAddr) {
  if (!g.sontAmis(moiAddr, cibleAddr)) return 'pas-ami';
  const moi = R.joueurs.get(moiAddr), lui = R.joueurs.get(cibleAddr);
  if (!moi || !lui) return 'pas-la';
  const a = 0.7, d = M.PORTAIL.rayon;
  let x = lui.x + Math.cos(a) * d, y = lui.y + Math.sin(a) * d;
  if (M.bloque(R.obstacles, x, y, 22)) { x = lui.x; y = lui.y; }
  moi.x = x; moi.y = y;
  return null;
}

// ================== 2. DEUX AMIS DANS LE MEME MONDE
console.log('\n-- dans le meme monde --');
{
  const g = new Game();
  g._p(A).amis = [B.toLowerCase()]; g._p(B).amis = [A.toLowerCase()];
  const R = new Realm({ alea: alea(2) });
  R.rejoint(A, FICHE); R.rejoint(B, FICHE);
  const lui = R.joueurs.get(B.toLowerCase());
  lui.x = M.CENTRE.x + 2000; lui.y = M.CENTRE.y + 1500;
  const moi = R.joueurs.get(A.toLowerCase());
  moi.x = 200; moi.y = 200;
  const loin = Math.hypot(moi.x - lui.x, moi.y - lui.y);
  eq(saut(g, R, A.toLowerCase(), B.toLowerCase()), null, 'le saut est accepte');
  const d = Math.hypot(moi.x - lui.x, moi.y - lui.y);
  ok(d < loin, `on a traverse la carte (${Math.round(loin)} -> ${Math.round(d)} unites)`);
  /* A COTE, PAS DESSUS : deux personnages superposes ne se distinguent plus. */
  ok(d > 0, `et on arrive A COTE de lui, pas dessus (${Math.round(d)} unites)`);
  ok(d <= M.PORTAIL.rayon + 1, `mais bien a portee de voix (${Math.round(d)})`);
  ok(!M.bloque(R.obstacles, moi.x, moi.y, 22), 'et jamais dans un rocher');
}

// ================== 3. UN INCONNU : REFUSE
console.log('\n-- un inconnu --');
{
  const g = new Game();
  g._p(A).amis = []; g._p(C).amis = [];
  const R = new Realm({ alea: alea(3) });
  R.rejoint(A, FICHE); R.rejoint(C, FICHE);
  const moi = R.joueurs.get(A.toLowerCase());
  const avant = { x: moi.x, y: moi.y };
  eq(saut(g, R, A.toLowerCase(), C.toLowerCase()), 'pas-ami',
     'sans amitie, le saut est refuse');
  ok(moi.x === avant.x && moi.y === avant.y, 'et on n a pas bouge d une unite');
}

// ================== 4. IL EST DANS UN DONJON : REFUSE
console.log('\n-- il est dans un donjon --');
{
  const g = new Game();
  g._p(A).amis = [B.toLowerCase()]; g._p(B).amis = [A.toLowerCase()];
  const ouvert = new Realm({ alea: alea(4) });
  const donjon = new Realm({ alea: alea(4), plan: M.planDeDonjon('forge', alea(4)),
                             tireObjet: () => ({ item: 1, cle: 'x', nom: 'X', rarete: 'relique' }) });
  ouvert.rejoint(A, FICHE);
  donjon.rejoint(B, FICHE);
  const moi = ouvert.joueurs.get(A.toLowerCase());
  const avant = { x: moi.x, y: moi.y };
  /* Amis, et pourtant refuse : c'est la SIMULATION qui tranche. On ne se
     teleporte pas dans un donjon — il s'ouvre en abattant Optimus, et y
     entrer par la liste des amis rendrait cette porte decorative. */
  eq(saut(g, ouvert, A.toLowerCase(), B.toLowerCase()), 'pas-la',
     'un ami dans un donjon n est pas joignable');
  ok(moi.x === avant.x && moi.y === avant.y, 'et on reste ou l on etait');
  eq(ouvert.joueurs.has(B.toLowerCase()), false,
     'il n est meme pas dans notre simulation — le refus est STRUCTUREL, pas un drapeau');

  /* Et dans le MEME donjon, ca remarche : c'est bien le monde qui decide, pas
     le fait que ce soit un donjon. */
  donjon.rejoint(A, FICHE);
  eq(saut(g, donjon, A.toLowerCase(), B.toLowerCase()), null,
     'mais dans le MEME donjon, on le rejoint');
}

// ================== 5. LE DRAPEAU « AMI » EST UNE RELATION
console.log('\n-- vert pour l un, gris pour l autre --');
{
  const g = new Game();
  g._p(A).amis = [B.toLowerCase()]; g._p(B).amis = [A.toLowerCase()];
  g._p(C).amis = [];
  /* Le meme joueur B est un coequipier pour A et un inconnu pour C, dans le
     meme instantane. C'est pour ca que le drapeau se pose par SPECTATEUR et
     ne peut pas vivre dans realm.js, qui ne connait aucun compte. */
  eq(g.sontAmis(A, B), true, 'B est un coequipier pour A');
  eq(g.sontAmis(C, B), false, 'et un inconnu pour C, au meme moment');
}

console.log(`\nrejoint.test.js — ${n} verifications, 0 echec(s)`);
