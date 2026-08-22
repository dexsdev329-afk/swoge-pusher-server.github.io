'use strict';
/*
 * LE MARCHE PREVIENT LE VENDEUR.
 *
 * C'est le seul comptoir du jeu ou deux joueurs echangent des $SWOGE reels
 * contre un bien, et c'etait le seul sans aucun signal : `marcheAchete`
 * deplacait l'argent et deposait l'objet, mais la reponse partait vers la
 * socket qui avait CLIQUE — l'acheteur, et lui seul. Le vendeur n'obtenait
 * qu'un compteur d'envois non lus. Sa page continuait d'afficher l'ancien
 * solde et son annonce comme si elle courait toujours.
 *
 * Le hall du Puissance 4, celui des duels, la reserve de staking et le bandeau
 * des gains sont tous diffuses. La seule table ou l'on echange de l'argent,
 * non.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE VENDEUR L'APPREND, SANS RIEN AVOIR DEMANDE. Le message arrive sur sa
 *    socket au moment de la vente.
 * 2. AVEC LE NET, PAS LE PRIX AFFICHE. C'est ce qui arrive sur son solde ; un
 *    ecart inexplique entre le prix demande et la somme recue se lit comme un
 *    vol.
 * 3. ET SON SOLDE ARRIVE AVEC. Le lui faire redemander laisserait un chiffre
 *    faux a l'ecran entre les deux.
 * 4. TOUT LE MONDE APPREND QUE LA LIGNE EST PARTIE. Le commentaire des routes
 *    du marche le promet depuis toujours — « la page doit le voir tout de
 *    suite au lieu de proposer un bouton mort » — et le seul retour
 *    reellement implemente etait l'erreur APRES le clic sur le bouton mort.
 * 5. UNE LIGNE QUI NE SE VIDE PAS RESTE, avec un exemplaire de moins.
 */
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };
const pres = (a, b, m) => { assert.ok(Math.abs(a - b) < 1e-6, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/marchesignal-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify(){}, notifyPhoto(){}, sendDocument(){}, chatEstPublic(){return true;}, enabled(){return true;} } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const { Game } = require('./game');
  let moteur = null; const _p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };
  require('./server');
  const B = require('./boutique');
  const cfg = require('./config');
  await new Promise((r) => setTimeout(r, 900));

  const ouvre = () => new Promise((res, rej) => {
    const s = new WebSocket('ws://127.0.0.1:' + port);
    s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    s.on('open', () => res(s)); s.on('error', rej);
  });
  const attend = (s, type, ms) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function tour() {
      const m = s.recus.filter((x) => x.type === type).pop();
      if (m) return res(m);
      if (Date.now() - t0 > (ms || 6000)) return rej(new Error('pas de ' + type));
      setTimeout(tour, 25);
    })();
  });
  const connecte = async (w) => {
    const s = await ouvre();
    const h = await attend(s, 'hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend(s, 'auth');
    return s;
  };
  const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);

  const wv = ethers.Wallet.createRandom();          // le vendeur
  const wa = ethers.Wallet.createRandom();          // l'acheteur
  const wt = ethers.Wallet.createRandom();          // un temoin, qui regarde
  const sv = await connecte(wv);
  const sa = await connecte(wa);
  const st = await connecte(wt);

  /* On demande l'objet au CATALOGUE : un identifiant ecrit a la main testerait
     une forme que le jeu ne produit jamais. */
  const OBJ = B.itemsDeSaison(2)[0];
  const PRIX = 40000;
  for (const [w, sock] of [[wv, sv], [wa, sa], [wt, st]]) {
    const p = moteur._p(w.address);
    p.hasDeposited = true;
    p.balance = WEI(1000000);
  }
  moteur._p(wv.address).objets = { [OBJ.id]: 2 };

  console.log('\n-- on met deux exemplaires en vente --');
  sv.send(JSON.stringify({ type: 'marketSell', item: OBJ.id, price: PRIX, qty: 2 }));
  const pose = await attend(sv, 'market');
  ok(pose.fait && pose.fait.id !== undefined, 'l annonce est posee');
  const idAnnonce = pose.fait.id;
  /* Le temoin OUVRE la vitrine : il a donc la ligne a l'ecran, et c'est lui
     qui doit la voir maigrir puis disparaitre. */
  st.send(JSON.stringify({ type: 'market' }));
  const vueT = await attend(st, 'market');
  ok((vueT.annonces || []).some((x) => x.id === idAnnonce), 'le temoin la voit dans sa vitrine');

  console.log('\n-- le premier achat : le vendeur l apprend --');
  sv.recus.length = 0; st.recus.length = 0;
  const soldeAvant = Number(moteur.balanceStr(wv.address));
  sa.send(JSON.stringify({ type: 'marketBuy', id: idAnnonce }));
  await attend(sa, 'market');

  const vendu = await attend(sv, 'marketSold');
  ok(!!vendu.vente, 'le vendeur recoit un message qu il n a pas demande');
  eq(vendu.vente.id, idAnnonce, 'il porte l annonce concernee');
  eq(vendu.vente.acheteur, wa.address.toLowerCase(), 'et le nom de qui a paye');
  eq(vendu.vente.annonce.item.nom, OBJ.nom, 'l objet est nomme, pas juste son identifiant');

  /* LE NET, pas le prix affiche. Les frais viennent de la CONFIGURATION : les
     recopier ici ferait passer l'essai le jour ou la maison change sa part. */
  const fraisAttendus = PRIX * cfg.MARCHE_FRAIS_BPS / 10000;
  pres(vendu.vente.frais, fraisAttendus, `les frais de la maison sont dits (${fraisAttendus})`);
  pres(vendu.vente.net, PRIX - fraisAttendus, 'et le net est ce qui arrive vraiment sur le solde');
  pres(Number(moteur.balanceStr(wv.address)) - soldeAvant, vendu.vente.net,
       'ce que le solde a REELLEMENT gagne vaut ce chiffre-la');
  ok(vendu.balance != null, 'le solde arrive avec, plutot que d etre a redemander');
  pres(Number(vendu.balance), Number(moteur.balanceStr(wv.address)), 'et c est le bon');

  console.log('\n-- une ligne qui ne se vide pas RESTE --');
  eq(vendu.vente.reste, 1, 'il reste un exemplaire en ligne');
  const parti1 = await attend(st, 'marketGone');
  eq(parti1.id, idAnnonce, 'le temoin apprend que la ligne a bouge');
  eq(parti1.reste, 1, 'avec ce qu il en reste — sa vitrine la garde, en moins gros');

  console.log('\n-- le second achat la ferme --');
  sv.recus.length = 0; st.recus.length = 0;
  sa.send(JSON.stringify({ type: 'marketBuy', id: idAnnonce }));
  await attend(sa, 'market');
  const vendu2 = await attend(sv, 'marketSold');
  eq(vendu2.vente.reste, 0, 'plus rien en ligne');
  const parti2 = await attend(st, 'marketGone');
  eq(parti2.reste, 0, 'et le temoin apprend qu elle est fermee — au lieu de garder un bouton mort');

  console.log('\n-- un animal se vend pareil --');
  {
    /* Le meme chemin, avec un familier : c'est la que la description d'une
       annonce n'a pas d'objet de boutique, et qu'une deuxieme forme de message
       se serait trompee. */
    const pv = moteur._p(wv.address);
    pv.sacOeufs = { feu: 1 }; pv.sacCases = null;
    moteur.ouvreOeuf(wv.address, 'feu');
    sv.recus.length = 0;
    sv.send(JSON.stringify({ type: 'marketSell', fam: 'feu', price: 12000 }));
    const p2 = await attend(sv, 'market');
    ok(p2.fait && p2.fait.id !== undefined, 'le familier est en vitrine');
    sv.recus.length = 0;
    sa.send(JSON.stringify({ type: 'marketBuy', id: p2.fait.id }));
    await attend(sa, 'market');
    const v3 = await attend(sv, 'marketSold');
    ok(/Lv /.test(v3.vente.annonce.item.nom),
       `l animal est nomme avec son niveau (${v3.vente.annonce.item.nom})`);
    pres(v3.vente.net, 12000 - 12000 * cfg.MARCHE_FRAIS_BPS / 10000,
         'et le net suit la meme regle que pour un objet');
  }

  console.log('\n-- et l acheteur, lui, ne recoit pas SON propre signal --');
  {
    /* Le message est adresse au VENDEUR. L'envoyer a tout le monde ferait
       annoncer « vendu » a celui qui vient d'acheter. */
    eq(sa.recus.filter((x) => x.type === 'marketSold').length, 0,
       'aucun « vendu » n a ete envoye a l acheteur');
  }

  for (const s of [sv, sa, st]) { try { s.close(); } catch (e) {} }
  console.log(`\nmarche_signal.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.log('  RATE ' + (e && e.message)); process.exit(1); });
