'use strict';
/*
 * LE VERROU BIOMÉTRIQUE, DE BOUT EN BOUT (routes /wallet/passkey/*), sur le VRAI
 * serveur. On ne peut pas simuler un authentificateur WebAuthn ici (ca demande
 * un vrai appareil), donc on verifie les GARDES de la route — celles qui
 * protegent, justement, avant toute crypto :
 *   1. /etat : une adresse neuve n'a pas de passkey ;
 *   2. une adresse invalide : 400 ;
 *   3. l'inscription ne commence QUE depuis une origine autorisee ;
 *   4. verifier une inscription SANS la signature du portefeuille : 401
 *      (la preuve de propriete passe AVANT la verification WebAuthn) ;
 *   5. avec une VRAIE signature mais une fausse reponse WebAuthn : on d
 *      depasse la garde de propriete (plus de 401) et c'est la verification
 *      WebAuthn qui refuse (400) — l'ordre des gardes est le bon ;
 *   6. deverrouiller sans passkey enregistre : 404.
 * La verification WebAuthn elle-meme est couverte par wallet_passkey.test.js.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const ethers = require('ethers');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/passkey-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0'; process.env.AGENT_HORLOGE = '0';
process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801';
process.env.PASSKEY_RP_ID = 'test.swoge';
process.env.PASSKEY_ORIGINES = 'https://test.swoge,https://autre.swoge';

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });

(async () => {
  const port = await libre();
  process.env.PORT = String(port);
  require('./server');
  await new Promise((r) => setTimeout(r, 400));

  const post = (p, body) => new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (rs) => { let b = ''; rs.on('data', (c) => b += c); rs.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: rs.statusCode, j }); }); });
    rq.on('error', () => resolve({ status: 0, j: null })); rq.end(data);
  });

  const w = ethers.Wallet.createRandom();
  const addr = w.address;
  const ORIG = 'https://test.swoge';

  console.log('-- 1. etat et garde d adresse --');
  let r = await post('/wallet/passkey/etat', { addr });
  ok(r.status === 200 && r.j && r.j.ok && r.j.actif === false, 'une adresse neuve : pas de passkey (actif=false)');
  r = await post('/wallet/passkey/etat', { addr: 'pas une adresse' });
  ok(r.status === 400, 'une adresse invalide : 400');

  console.log('\n-- 2. l inscription ne commence que depuis une origine autorisee --');
  r = await post('/wallet/passkey/inscription/options', { addr, origine: 'https://pirate.example' });
  ok(r.status === 400 && /origin/i.test(r.j.raison || ''), 'origine inconnue : 400, aucune option emise');
  r = await post('/wallet/passkey/inscription/options', { addr, origine: ORIG });
  ok(r.status === 200 && r.j.ok && r.j.options && r.j.options.challenge && /nonce:/.test(r.j.aSigner) && r.j.aSigner.indexOf(addr.toLowerCase()) >= 0,
     'origine autorisee : options WebAuthn + un message a signer qui porte l adresse et un nonce');
  const aSigner = r.j.aSigner;

  console.log('\n-- 3. la preuve de propriete passe AVANT la verification WebAuthn --');
  r = await post('/wallet/passkey/inscription/verifie', { addr, origine: ORIG, reponse: { id: 'x' }, sig: '0xdead' });
  ok(r.status === 401, 'une signature bidon : 401 (on ne verifie pas le WebAuthn d un inconnu)');
  /* On redemande un nonce (le precedent a ete consomme par la tentative ratee). */
  r = await post('/wallet/passkey/inscription/options', { addr, origine: ORIG });
  const vraiSig = await w.signMessage(r.j.aSigner);
  r = await post('/wallet/passkey/inscription/verifie', { addr, origine: ORIG, reponse: { id: 'bidon' }, sig: vraiSig });
  ok(r.status === 400 && r.status !== 401, 'VRAIE signature, fausse reponse WebAuthn : la propriete passe, c est le WebAuthn qui refuse (400, pas 401)');
  /* Le mauvais signataire (une autre cle) est refuse meme avec un nonce frais. */
  r = await post('/wallet/passkey/inscription/options', { addr, origine: ORIG });
  const autre = ethers.Wallet.createRandom();
  const sigAutre = await autre.signMessage(r.j.aSigner);
  r = await post('/wallet/passkey/inscription/verifie', { addr, origine: ORIG, reponse: { id: 'x' }, sig: sigAutre });
  ok(r.status === 401, 'une signature d UNE AUTRE cle : 401 (elle ne prouve pas cette adresse)');

  console.log('\n-- 4. deverrouiller sans passkey enregistre --');
  r = await post('/wallet/passkey/auth/options', { addr, origine: ORIG });
  ok(r.status === 404, 'pas de passkey pour cette adresse : 404');
  r = await post('/wallet/passkey/auth/verifie', { addr, origine: ORIG, reponse: { id: 'rien' } });
  ok(r.status === 404, 'deverrouillage d un passkey inconnu : 404');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
