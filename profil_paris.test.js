'use strict';
/*
 * Les deux onglets « Open bets » et « Settled bets » du panneau de profil,
 * AU NIVEAU DU SERVEUR — c'est-a-dire par la socket, comme la page les
 * demande.
 *
 * Pourquoi un test a part plutot qu'une ligne de plus dans paris.test.js :
 * ce qui est en jeu ici n'est pas le calcul d'un pari, c'est un CONTRAT DE
 * MESSAGE. La page envoie `{type:'history', kind:'bo'}` et attend en retour
 * un `history` de meme `kind`, dont chaque element porte `k:'pa'`. Si le
 * `kind` ne revient pas a l'identique, la page jette la reponse en silence —
 * elle a une garde exactement pour ca, « une reponse d'un onglet qu'on a
 * quitte » — et l'onglet reste sur « Loading… » pour toujours. Aucun calcul
 * n'est faux : rien ne s'affiche, et rien ne le dit.
 *
 * Le second point est plus sourd. Les paris ne sont PAS servis depuis le
 * journal, contrairement aux depots, aux retraits et aux manches. Un pari
 * change d'etat apres avoir ete ecrit — pose vendredi, gagne samedi — et un
 * journal ne se reecrit pas : la ligne « pose » dirait « en cours » pour
 * toujours. Ils viennent donc du moteur. Ce test verifie que le passage de
 * l'un a l'autre se voit bien par la socket.
 */
const assert = require('assert');

process.env.PORT = String(9100 + (process.pid % 90));
process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/profil-paris-test-');
process.env.RPC_URL = '';
process.env.DEV_FAUCET = '1';
process.env.ADMIN_KEY = 'cle-de-banc-essai-0123456789';

const WebSocket = require('ws');
const { ethers } = require('ethers');
const paris = require('./paris');
require('./server');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (ws, o) => ws.send(JSON.stringify(o));
const dernier = (recu, t) => [...recu].reverse().find((m) => m.type === t);

function ouvrir() {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    const recu = [];
    ws.on('message', (d) => { try { recu.push(JSON.parse(d)); } catch (e) {} });
    ws.on('error', rej);
    ws.on('open', () => res({ ws, recu }));
  });
}
async function joueur() {
  const w = ethers.Wallet.createRandom();
  const c = await ouvrir();
  await dors(250);
  const msg = `SWOGE Pusher login\nnonce: ${dernier(c.recu, 'hello').loginNonce}`;
  env(c.ws, { type: 'login', message: msg, signature: await w.signMessage(msg) });
  await dors(300);
  for (let i = 0; i < 3; i++) env(c.ws, { type: 'devCredit' });
  await dors(300);
  c.addr = w.address.toLowerCase();
  return c;
}
/* Demander un onglet et attendre SA reponse — pas celle d'un autre. */
async function onglet(c, kind, extra) {
  const avant = c.recu.length;
  env(c.ws, Object.assign({ type: 'history', kind, limit: 25 }, extra || {}));
  for (let i = 0; i < 40; i++) {
    await dors(50);
    const r = c.recu.slice(avant).find((m) => m.type === 'history' && m.kind === kind);
    if (r) return r;
  }
  throw new Error('pas de reponse history pour ' + kind);
}

async function regle(match, resultat) {
  const url = 'http://127.0.0.1:' + process.env.PORT + '/paris/regle?match=' +
              encodeURIComponent(match) + '&resultat=' + encodeURIComponent(resultat);
  const rep = await fetch(url, { headers: { 'x-admin-key': process.env.ADMIN_KEY } });
  const j = await rep.json();
  if (j.error) throw new Error('reglement refuse : ' + j.error);
  return j;
}

(async () => {
  paris.charge();
  const ouv = paris.ouverts(Date.now());
  if (ouv.length < 3) {
    /* Le catalogue est date. Quand tous les coups d'envoi sont passes, on ne
       peut plus poser un seul pari : le test n'a plus de matiere. On le dit
       au lieu de rendre un faux vert. */
    console.log('profil_paris.test.js : IGNORE — moins de 3 matchs ouverts au calendrier');
    process.exit(0);
  }

  const a = await joueur();

  // ---- un onglet vide repond quand meme, et repond POUR SON ONGLET
  {
    const r = await onglet(a, 'bo');
    eq(r.kind, 'bo', 'la reponse porte le kind demande');
    eq(r.items.length, 0, 'sans pari, la liste est vide');
    eq(r.more, false, 'et il n y a rien de plus a charger');
    eq(r.summary.mot, 'bet', 'le sous-titre compte des « bets », pas des « events »');
    eq(r.summary.lignes, 0, 'zero pour l instant');
  }

  // ---- un simple et un combine
  env(a.ws, { type: 'parie', match: ouv[0].id, choix: ouv[0].issues[0], mise: 1000 });
  await dors(250);
  env(a.ws, { type: 'parie', mise: 500, selections:
    [{ match: ouv[1].id, choix: ouv[1].issues[0] },
     { match: ouv[2].id, choix: ouv[2].issues[0] }] });
  await dors(350);
  ok(!a.recu.some((m) => m.type === 'error'), 'les deux paris sont acceptes');

  {
    const r = await onglet(a, 'bo');
    eq(r.items.length, 2, 'les deux paris sont en cours');
    ok(r.items.every((x) => x.k === 'pa'),
       'chaque element porte k:pa — c est ce qui declenche l affichage « pari »');
    ok(r.items.every((x) => x.regle === false), 'aucun n est solde');
    eq(r.summary.lignes, 2, 'le sous-titre en compte deux');
    /* Ce que la page dessine, jambe par jambe. */
    const c2 = r.items.find((x) => x.jambes.length === 2);
    ok(c2, 'le combine est bien la');
    ok(c2.jambes.every((j) => j.domicile && j.domicile !== '?'),
       'chaque jambe porte le nom de sa rencontre');
    ok(c2.jambes.every((j) => Array.isArray(j.issues) && j.issues.length >= 2),
       'et ses issues, dont la page tire « Home / Draw / Away »');
    ok(c2.cote > 1 && c2.rapport > c2.mise, 'la cote et le retour possible sont annonces');
  }
  {
    const r = await onglet(a, 'bs');
    eq(r.items.length, 0, 'rien n est encore solde');
  }

  // ---- on regle le simple : il change d'onglet
  /* On regle par la ROUTE D ADMIN, pas en tripotant le moteur : c est le
     chemin reel, et c est lui qui doit se voir dans le profil. */
  const r = await regle(ouv[0].id, ouv[0].issues[0]);
  eq(r.gagnants, 1, 'un gagnant paye');
  await dors(250);

  {
    const o = await onglet(a, 'bo');
    eq(o.items.length, 1, 'le simple regle a quitte les paris en cours');
    const s = await onglet(a, 'bs');
    eq(s.items.length, 1, 'et il est arrive chez les paris finis');
    eq(s.items[0].gagne, true, 'gagne');
    eq(s.items[0].k, 'pa', 'toujours marque comme un pari');
    eq(s.summary.mot, 'bet', 'et le sous-titre parle toujours de « bets »');
  }

  // ---- la pagination : un RANG, pas une position de fichier
  {
    const r1 = await onglet(a, 'bo', { limit: 1 });
    eq(r1.items.length, 1, 'une page d une ligne en rend une');
    eq(r1.cursor, 1, 'le curseur avance d un rang');
    eq(r1.more, false, 'et il ne reste rien apres');
    const r0 = await onglet(a, 'bo', { cursor: 5 });
    eq(r0.items.length, 0, 'passe la fin, la page est vide');
  }

  // ---- un onglet inconnu ne doit pas passer par le chemin des paris
  {
    const r = await onglet(a, 'dep');
    eq(r.kind, 'dep', 'les autres onglets repondent comme avant');
    ok(r.summary && r.summary.mot === undefined,
       'et leur sous-titre reste un compte d evenements');
  }

  a.ws.close();
  console.log(`profil_paris.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
