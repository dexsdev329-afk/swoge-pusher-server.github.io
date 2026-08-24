'use strict';
/*
 * LES CARTES, SUR UN VRAI SERVEUR ET AVEC DEUX COMPTES.
 *
 * ---- POURQUOI LE MODULE NE SUFFIT PAS ----
 *
 * `cartes.test.js` prouve que `game.js` refuse une ecriture qui ne vient pas
 * du proprietaire. Il ne prouve rien de la ROUTE : c'est elle qui choisit
 * quelle adresse presenter, et tout tient a cette ligne. Une route qui passerait
 * `m.addr` au lieu de `ws.addr` laisserait n'importe qui ecrire chez n'importe
 * qui, et les essais de module resteraient verts — ils recevraient toujours la
 * bonne adresse, puisque c'est l'essai qui la donne.
 *
 * On monte donc le serveur, on ouvre DEUX sockets authentifiees a deux
 * adresses differentes, et on regarde ce qui traverse le fil.
 *
 * ---- COMMENT ON S'AUTHENTIFIE SANS PORTEFEUILLE ----
 *
 * La connexion normale demande une signature. Mais la reprise de session
 * accepte un jeton, et le secret qui le signe se fixe par l'environnement. On
 * le pose donc avant de charger le serveur, et l'on frappe ses propres jetons.
 * Ce n'est pas un contournement : c'est le meme chemin que celui d'une page qui
 * change d'onglet, avec le meme controle au bout.
 */
const assert = require('assert');
const fs = require('fs');
const WebSocket = require('ws');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const SECRET = 'secret-de-test-des-cartes';
process.env.DATA_DIR = fs.mkdtempSync('/tmp/cartes-srv-');
process.env.RPC_URL = '';
process.env.SESSION_SECRET = SECRET;
process.env.PORT = String(9800 + (process.pid % 150));
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {},
  chatEstPublic() { return true; }, enabled() { return true; } } };

const session = require('./session');
const cfg = require('./config');
require('./server');

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const dort = (ms) => new Promise((r) => setTimeout(r, ms));

const ouvre = () => new Promise((res, rej) => {
  const s = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
  s.recus = [];
  s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
  s.on('open', () => res(s)); s.on('error', rej);
});
const dernier = (s, t) => [...s.recus].reverse().find((m) => m.type === t);
/* On ATTEND la reponse plutot que de dormir un temps fixe : un sommeil trop
   court rend l'essai capricieux, un sommeil trop long le rend interminable. */
const attend = async (s, t, ms) => {
  const avant = s.recus.filter((m) => m.type === t).length;
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (s.recus.filter((m) => m.type === t).length > avant) return dernier(s, t);
    await dort(25);
  }
  return null;
};
const entre = async (adresse) => {
  const s = await ouvre();
  s.send(JSON.stringify({ type: 'resume', token: session.emettre(SECRET, adresse, 600) }));
  await attend(s, 'hello', 4000);
  return s;
};
const carteDe = (nom) => ({ nom, cote: 12, cases: [
  { c: 1, l: 1, s: 'grass' }, { c: 2, l: 1, s: 'dirt', o: 'boxe' },
] });

(async () => {
  await dort(900);

  console.log('-- deux comptes entrent --');
  const sa = await entre(A);
  const sb = await entre(B);
  ok(!!dernier(sa, 'hello') || !!dernier(sa, 'state'), 'le premier compte est connecte');
  ok(!!dernier(sb, 'hello') || !!dernier(sb, 'state'), 'le second aussi');

  console.log('\n-- A dessine --');
  sa.send(JSON.stringify({ type: 'carteEnregistre', carte: carteDe('Chez A') }));
  const cree = await attend(sa, 'carte');
  ok(cree && cree.enregistre && cree.enregistre.id, 'A cree sa carte et recoit son numero');
  const ID = cree.enregistre.id;
  ok(Array.isArray(cree.liste), 'la reponse porte la galerie a jour');

  console.log('\n-- B regarde --');
  sb.send(JSON.stringify({ type: 'carteListe' }));
  const vue = await attend(sb, 'cartes');
  ok(vue && Array.isArray(vue.liste), 'B recoit la galerie');
  const dansLaVue = vue.liste.find((k) => k.id === ID);
  ok(!!dansLaVue, 'la carte de A y figure — tout le monde voit');
  eq(dansLaVue.mienne, false, 'et elle n est pas marquee comme sienne');

  sb.send(JSON.stringify({ type: 'carteLit', id: ID }));
  const lue = await attend(sb, 'carte');
  ok(lue && lue.carte && Array.isArray(lue.carte.cases), 'B peut la LIRE en entier — visiter n est pas modifier');
  eq(lue.carte.cases.length, 2, 'avec ses deux cases');
  eq(lue.carte.mienne, false, 'et le fil le lui dit');

  console.log('\n-- B essaie d ecrire dessus --');
  /* ---- ON GLISSE L'ADRESSE DE A DANS LE MESSAGE ----
   * C'est exactement ce que ferait quelqu'un qui ouvre une console : le
   * message dit ce qu'il veut. La route doit s'en moquer et n'ecouter que la
   * socket. Verifie en cassant volontairement la route — en lui faisant
   * preferer `m.addr`, B a ecrit chez A et cet essai est tombe ici meme. */
  sb.send(JSON.stringify({ type: 'carteEnregistre', id: ID, addr: A, carte: carteDe('Vole par B') }));
  const vol = await attend(sb, 'carte');
  ok(vol && typeof vol.error === 'string',
     'une adresse falsifiee dans le message ne change rien — refuse : ' + (vol && vol.error));
  ok(!vol.enregistre, 'et rien n est enregistre');

  sb.send(JSON.stringify({ type: 'carteSupprime', id: ID }));
  const sup = await attend(sb, 'carte');
  ok(sup && typeof sup.error === 'string', 'la suppression aussi : ' + (sup && sup.error));

  /* ---- ET LA CARTE DE A EST INTACTE ----
   * Le refus ne suffit pas : une route peut refuser APRES avoir ecrit. On
   * relit donc par le fil, du cote de A. */
  sa.send(JSON.stringify({ type: 'carteLit', id: ID }));
  const apres = await attend(sa, 'carte');
  eq(apres.carte.nom, 'Chez A', 'la carte de A porte toujours son nom');
  eq(apres.carte.mienne, true, 'et A la reconnait comme sienne');

  console.log('\n-- A, lui, la modifie --');
  sa.send(JSON.stringify({ type: 'carteEnregistre', id: ID, carte: carteDe('Chez A, revu') }));
  const revu = await attend(sa, 'carte');
  eq(revu.enregistre.id, ID, 'le meme numero : il modifie, il ne recree pas');
  eq(revu.enregistre.nom, 'Chez A, revu', 'et le nom a change');

  console.log('\n-- une socket qui n a pas donne son nom --');
  const muet = await ouvre();
  muet.send(JSON.stringify({ type: 'carteEnregistre', carte: carteDe('Anonyme') }));
  await dort(400);
  ok(!dernier(muet, 'carte'), 'aucune reponse : la route se tait pour qui n est pas entre');
  sb.send(JSON.stringify({ type: 'carteListe' }));
  const encore = await attend(sb, 'cartes');
  eq(encore.liste.length, 1, 'et rien n a ete cree');

  console.log('\n-- ce que le reglement refuse --');
  const trop = [];
  for (let i = 0; i <= cfg.CARTE_CASES; i++) trop.push({ c: 0, l: 0, s: 'grass' });
  sa.send(JSON.stringify({ type: 'carteEnregistre', carte: { nom: 'Trop', cote: 12, cases: trop } }));
  const refus = await attend(sa, 'carte');
  ok(refus && typeof refus.error === 'string', 'un envoi au-dela du plafond est refuse : ' + (refus && refus.error));

  for (const s of [sa, sb, muet]) { try { s.close(); } catch (e) {} }
  console.log(`\ncartes_serveur.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.log('  RATE ' + (e && e.message)); process.exit(1); });
