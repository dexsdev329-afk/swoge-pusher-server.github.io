'use strict';
/* LE CRÉATEUR SE SERT LUI-MÊME (agent_createur.js, 05/10/2026).
 *
 * Intention : un créateur attache l'agent de SON jeton sans clé admin, et
 * PERSONNE d'autre ne le peut. La preuve tient en deux temps, revérifiés côté
 * serveur à chaque fois : (1) le portefeuille signe un message lié au jeton et
 * horodaté, le serveur récupère le signataire ; (2) le serveur lit sur la
 * chaîne qui a créé le jeton, et n'attache que si le signataire EST ce
 * créateur. Tout le reste refuse (fail-closed).
 *
 * Hors-ligne : la signature ethers est locale (aucun réseau) ; le créateur
 * on-chain est un bouchon injecté. */

const ethers = require('ethers');
const ac = require('./agent_createur');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* Deux portefeuilles : l'un est le vrai créateur, l'autre un imposteur. */
const createur = ethers.Wallet.createRandom();
const imposteur = ethers.Wallet.createRandom();
const TOKEN = '0xABa8408EB41A1FFa092D3101c404937785a3B16D';  /* casse mélangée exprès */

/* Les deps réelles côté serveur : récupération ethers, et lecture on-chain (bouchon). */
const recupere = (msg, sig) => ethers.utils.verifyMessage(msg, sig);
const POOL = '0x4e3e90b3352dcd8aef04ae8afa90d62743452584';
const onchainEst = (adr) => async (token) => (token && token.toLowerCase() === TOKEN.toLowerCase()) ? { creator: adr, pool: POOL } : null;

async function signe(wallet, token, ts, action) {
  return wallet.signMessage(ac.message(token, ts, action));
}

async function main() {
  console.log('-- le message est déterministe et lie jeton + instant --');
  const ts = Date.now();
  const m1 = ac.message(TOKEN, ts), m2 = ac.message(TOKEN.toLowerCase(), ts);
  ok(m1 === m2, 'la casse du jeton ne change pas le message (adresse en minuscules)');
  ok(m1.includes(TOKEN.toLowerCase()), 'le message cite l adresse du jeton');
  ok(m1.includes('Timestamp: ' + ts), 'le message porte l horodatage');
  ok(/moves no funds and grants no spending power/.test(m1), 'le message dit qu il ne déplace aucun fonds');

  console.log('\n-- le vrai créateur attache son agent --');
  let r = await ac.verifie({ token: TOKEN, ts, signature: await signe(createur, TOKEN, ts) },
    { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(r.ok, 'signature du créateur + créateur on-chain concordant → ok');
  ok(r.createur === createur.address.toLowerCase(), 'le créateur rendu est en minuscules, prêt pour le registre');
  ok(r.pool === POOL, 'le pool rendu vient de la chaîne (pas de la requête)');

  console.log('\n-- un créateur on-chain rendu comme simple adresse marche aussi (rétro-compat) --');
  r = await ac.verifie({ token: TOKEN, ts, signature: await signe(createur, TOKEN, ts) },
    { recupere, createurOnchain: async () => createur.address, maintenant: () => ts });
  ok(r.ok && r.createur === createur.address.toLowerCase() && r.pool === null, 'adresse nue acceptée, pool null');

  console.log('\n-- un imposteur est refusé même avec une signature valide --');
  /* L imposteur signe un message bien formé, mais il n est PAS le créateur on-chain. */
  r = await ac.verifie({ token: TOKEN, ts, signature: await signe(imposteur, TOKEN, ts) },
    { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(!r.ok && r.code === 403, 'signature d un autre portefeuille → 403 (pas le créateur)');

  console.log('\n-- une signature pour un AUTRE jeton ne vaut pas ici --');
  const autre = '0x1111111111111111111111111111111111111111';
  r = await ac.verifie({ token: TOKEN, ts, signature: await signe(createur, autre, ts) },
    { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(!r.ok && r.code === 403, 'signature liée à un autre jeton → le signataire récupéré ne matche pas');

  console.log('\n-- jeton jamais lancé par un launchpad SWOGE --');
  r = await ac.verifie({ token: TOKEN, ts, signature: await signe(createur, TOKEN, ts) },
    { recupere, createurOnchain: async () => null, maintenant: () => ts });
  ok(!r.ok && r.code === 404, 'aucun créateur on-chain → 404');

  console.log('\n-- la lecture on-chain en panne refuse (ne devine pas) --');
  r = await ac.verifie({ token: TOKEN, ts, signature: await signe(createur, TOKEN, ts) },
    { recupere, createurOnchain: async () => { throw new Error('rpc down'); }, maintenant: () => ts });
  ok(!r.ok && r.code === 503, 'RPC injoignable → 503, jamais « dans le doute, oui »');

  console.log('\n-- la fenêtre temporelle est bornée des deux côtés --');
  const sig = await signe(createur, TOKEN, ts);
  r = await ac.verifie({ token: TOKEN, ts, signature: sig },
    { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts + ac.FENETRE_MS + 1000 });
  ok(!r.ok && r.code === 400, 'signature trop vieille → expirée');
  r = await ac.verifie({ token: TOKEN, ts, signature: sig },
    { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts - ac.FENETRE_MS - 1000 });
  ok(!r.ok && r.code === 400, 'signature venue du futur → refusée');

  console.log('\n-- entrées malformées --');
  r = await ac.verifie({ token: 'pas-une-adresse', ts, signature: sig }, { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(!r.ok && r.code === 400, 'jeton non-adresse → 400');
  r = await ac.verifie({ token: TOKEN, ts, signature: '0xdeadbeef' }, { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(!r.ok && r.code === 400, 'signature mal formée → 400 (pas de récupération)');
  r = await ac.verifie({ token: TOKEN, signature: sig }, { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(!r.ok && r.code === 400, 'horodatage absent → 400');
  /* Une signature valide mais pour un AUTRE instant : le message ne correspond pas. */
  r = await ac.verifie({ token: TOKEN, ts: ts, signature: await signe(createur, TOKEN, ts - 1), },
    { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(!r.ok && r.code === 403, 'signature pour un autre horodatage → signataire récupéré faux → refus');

  console.log('\n-- le GESTE entre dans la signature (une signature ne vaut que pour SON geste) --');
  ok(ac.message(TOKEN, ts, 'pause') !== ac.message(TOKEN, ts, 'configure'), 'le message depend du geste');
  ok(/Action: configure/.test(ac.message(TOKEN, ts)), 'sans geste precise, defaut = configure');
  ok(ac.message(TOKEN, ts, 'inconnu') === ac.message(TOKEN, ts, 'configure'), 'un geste inconnu retombe sur configure');
  /* Une signature faite pour « pause » ne doit pas autoriser « configure ». */
  r = await ac.verifie({ token: TOKEN, ts, action: 'configure', signature: await signe(createur, TOKEN, ts, 'pause') },
    { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(!r.ok && r.code === 403, 'signature pour « pause » presentee comme « configure » → signataire faux → refus');
  /* La meme signature, pour SON geste, passe. */
  r = await ac.verifie({ token: TOKEN, ts, action: 'pause', signature: await signe(createur, TOKEN, ts, 'pause') },
    { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts });
  ok(r.ok, 'signature pour « pause » presentee comme « pause » → ok');

  console.log('\n-- rejeu : une signature deja vue ne resert pas --');
  const sigR = await signe(createur, TOKEN, ts, 'configure');
  const vues = new Set();
  const depsR = { recupere, createurOnchain: onchainEst(createur.address), maintenant: () => ts,
    dejaVu: (s) => vues.has(s) };
  r = await ac.verifie({ token: TOKEN, ts, action: 'configure', signature: sigR }, depsR);
  ok(r.ok, 'premiere presentation : acceptee');
  vues.add(sigR);
  r = await ac.verifie({ token: TOKEN, ts, action: 'configure', signature: sigR }, depsR);
  ok(!r.ok && r.code === 409, 'deuxieme presentation de la meme signature : 409 (rejeu refuse)');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
