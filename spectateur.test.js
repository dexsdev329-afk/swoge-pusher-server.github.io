'use strict';
/*
 * Regarder un duel en direct — au niveau du serveur.
 *
 * Deux choses se verifient ici, et une seule est nouvelle.
 *
 * La nouvelle : un spectateur recoit l'etat de la partie a chaque coup, sans
 * y jouer et sans y avoir mise. Ce qui compte alors n'est pas qu'il recoive,
 * c'est ce qu'il NE recoit PAS — ni solde, ni reglement. Un solde pousse a
 * quelqu'un qui regarde s'afficherait a la place du sien.
 *
 * L'ancienne : s'asseoir a une table de Connect 4. `duelRejoindre` rend
 * `{ partie, retirees }` depuis que le morpion et les dames partagent ce
 * chemin, mais `p4Join` lisait la reponse comme si elle etait la partie. Les
 * deux mises partaient, la table demarrait, puis la diffusion jetait : deux
 * joueurs payes, aucun plateau. Ce test-la echoue sur l'ancien code.
 */
const assert = require('assert');

process.env.PORT = String(8900 + (process.pid % 90));
process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/spectateur-test-');
process.env.RPC_URL = '';
process.env.DEV_FAUCET = '1';

const WebSocket = require('ws');
const { ethers } = require('ethers');
require('./server');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (ws, o) => ws.send(JSON.stringify(o));
const dernier = (recu, t) => [...recu].reverse().find((m) => m.type === t);
const tous = (recu, t) => recu.filter((m) => m.type === t);

function ouvrir() {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    const recu = [];
    ws.on('message', (d) => { try { recu.push(JSON.parse(d)); } catch (e) {} });
    ws.on('error', rej);
    ws.on('open', () => res({ ws, recu }));
  });
}
/* Un joueur : il se connecte, se credite, et a de quoi miser. */
async function joueur() {
  const w = ethers.Wallet.createRandom();
  const c = await ouvrir();
  await dors(200);
  const msg = `SWOGE Pusher login\nnonce: ${dernier(c.recu, 'hello').loginNonce}`;
  env(c.ws, { type: 'login', message: msg, signature: await w.signMessage(msg) });
  await dors(250);
  for (let i = 0; i < 3; i++) env(c.ws, { type: 'devCredit' });
  await dors(250);
  c.addr = w.address.toLowerCase();
  return c;
}

(async () => {
  // ============================================ Connect 4 : s'asseoir
  {
    const A = await joueur(), B = await joueur();
    env(A.ws, { type: 'p4Create', bet: 1000 });
    await dors(250);
    const table = dernier(A.recu, 'p4Match');
    ok(table && table.match, 'une table de Connect 4 s ouvre');

    env(B.ws, { type: 'p4Join', id: table.match.id });
    await dors(400);

    /* Le controle qui echoue sur l'ancien code : les deux joueurs doivent
       APPRENDRE que la partie a commence. L'argent, lui, etait deja parti. */
    ok(!dernier(B.recu, 'error'), 'aucune erreur en s asseyant',
       dernier(B.recu, 'error'));
    const vuA = dernier(A.recu, 'p4Match');
    const vuB = dernier(B.recu, 'p4Match');
    eq(vuA.match.phase, 'en_cours', 'le createur voit la partie demarrer');
    ok(vuB && vuB.match.phase === 'en_cours', 'et celui qui rejoint aussi');
    eq(vuA.match.joueurs.length, 2, 'a deux');

    /* Le Connect 4 a son PROPRE chemin de diffusion. Il apparaissait bien
       dans la liste des parties en cours, mais le plateau du spectateur se
       figeait a l'instant ou il commencait a regarder. */
    const V = await ouvrir();
    await dors(200);
    env(V.ws, { type: 'duelWatch', id: table.match.id });
    await dors(250);
    eq(dernier(V.recu, 'duelWatch').match.grille.length, 42,
       'un visiteur recoit le plateau du Connect 4, quarante-deux cases');
    env(A.ws, { type: 'p4Play', id: table.match.id, col: 3 });
    await dors(300);
    const suite = dernier(V.recu, 'duelWatch');
    eq(suite.match.grille.filter((c) => c !== 0).length, 1,
       'et le coup du Connect 4 lui parvient aussi');
    eq(suite.balance, undefined, 'sans solde, la non plus');

    V.ws.close(); A.ws.close(); B.ws.close();
  }

  // ============================================ le spectateur
  {
    const A = await joueur(), B = await joueur();
    env(A.ws, { type: 'duelCreate', jeu: 'mp', bet: 1000 });
    await dors(250);
    const id = dernier(A.recu, 'duelMatch').match.id;
    env(B.ws, { type: 'duelJoin', id });
    await dors(350);

    /* Un VISITEUR : jamais connecte, aucun solde. Regarder est public. */
    const V = await ouvrir();
    await dors(200);
    const accueil = dernier(V.recu, 'hello');
    ok(Array.isArray(accueil.duelsEnCours), 'l accueil porte les parties en cours');
    const vue = accueil.duelsEnCours.find((m) => m.id === id);
    ok(vue, 'la partie qui se joue y figure');
    eq(vue.joueurs.length, 2, 'avec ses deux joueurs');
    ok(vue.joueurs[0].nom && vue.joueurs[0].niveau !== undefined,
       'et leur profil public, nom et niveau');

    env(V.ws, { type: 'duelWatch', id });
    await dors(250);
    const p0 = dernier(V.recu, 'duelWatch');
    ok(p0 && p0.match, 'le visiteur recoit le plateau sans etre connecte');
    eq(p0.match.grille.length, 9, 'un morpion : neuf cases');
    eq(p0.balance, undefined, 'et AUCUN solde ne lui est pousse');

    env(A.ws, { type: 'duelPlay', id, coup: 0 });
    await dors(300);
    const p1 = dernier(V.recu, 'duelWatch');
    eq(p1.match.grille[0], 1, 'le coup lui arrive sans qu il demande rien');
    eq(p1.fini, false, 'la partie n est pas finie');
    eq(p1.balance, undefined, 'toujours aucun solde');
    eq(p1.reglement, undefined, 'et aucun reglement : ce n est pas son argent');

    // 0,1,2 pour A ; 3,4 pour B
    env(B.ws, { type: 'duelPlay', id, coup: 3 }); await dors(200);
    env(A.ws, { type: 'duelPlay', id, coup: 1 }); await dors(200);
    env(B.ws, { type: 'duelPlay', id, coup: 4 }); await dors(200);
    /* On compte les vestibules recus AVANT le coup gagnant : ce qui doit
       arriver ensuite est un rafraichissement que PERSONNE n'a demande. */
    const vestibulesAvant = tous(V.recu, 'duelsTous').length;
    env(A.ws, { type: 'duelPlay', id, coup: 2 }); await dors(350);

    const pf = dernier(V.recu, 'duelWatch');
    eq(pf.match.gagnant, 1, 'la victoire lui parvient');
    eq(pf.fini, true, 'et elle est annoncee comme finale');
    eq(pf.match.ligne.length, 3, 'avec la ligne gagnante');
    eq(pf.balance, undefined, 'sans solde, jusqu au bout');
    ok(!tous(V.recu, 'duelWatch').some((m) => m.reglement),
       'aucun reglement ne lui a jamais ete envoye');
    /* Il n'a pas de compte : rien du chemin de l'argent ne doit l'avoir
       effleure, meme sous un autre nom de message. */
    ok(!dernier(V.recu, 'balance'), 'et aucun message de solde du tout');

    /* Une partie terminee doit SORTIR de la liste des parties en cours, et
       sortir toute seule : personne ne redemande le vestibule, et une partie
       deja jouee qu'on propose de regarder fait mentir la bulle. */
    const vestibules = tous(V.recu, 'duelsTous');
    ok(vestibules.length > vestibulesAvant,
       'la fin de la partie rafraichit le vestibule sans qu on demande rien',
       [vestibulesAvant, vestibules.length]);
    ok(!vestibules[vestibules.length - 1].enCours.some((m) => m.id === id),
       'et la partie finie n y figure plus',
       vestibules[vestibules.length - 1].enCours);

    /* On se met a regarder une partie DEJA jouee : elle reste consultable
       quelques minutes, et il faut le dire, pas annoncer « en cours ». */
    const T = await ouvrir();
    await dors(200);
    env(T.ws, { type: 'duelWatch', id });
    await dors(250);
    const tard = dernier(T.recu, 'duelWatch');
    ok(tard && tard.match, 'une partie finie reste consultable');
    eq(tard.fini, true, 'et elle est annoncee finie des le premier envoi');
    T.ws.close();

    // --- on cesse de regarder : plus rien n arrive ---
    env(V.ws, { type: 'duelUnwatch' });
    await dors(150);
    const avant = tous(V.recu, 'duelWatch').length;
    env(A.ws, { type: 'duelRematch', id, bet: 1000 });
    await dors(300);
    eq(tous(V.recu, 'duelWatch').length, avant, 'apres avoir ferme, plus rien ne vient');

    // --- une partie qui n existe pas ---
    env(V.ws, { type: 'duelWatch', id: 'mp4-inexistant' });
    await dors(200);
    ok(/over/.test((dernier(V.recu, 'error') || {}).error || ''),
       'et regarder une partie qui n existe pas est refuse proprement');

    V.ws.close(); A.ws.close(); B.ws.close();
  }

  console.log(`spectateur.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
