'use strict';
/* LANCER UN TOKEN SUR SOLANA via Pump.fun (solana_pump.js, 05/10/2026).
 *
 * Intention : NON CUSTODIAL — on ne fait que preparer. metadataIpfs televerse
 * l'image + les infos et rend une metadataUri ; offreCreation demande la
 * transaction « create » serialisee (base64) a signer cote navigateur. Les refus
 * sont propres (champs manquants, adresses invalides, service muet). fetch injecte :
 * rien ne sort de la machine. */

const sp = require('./solana_pump');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const PUB = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';    /* 44 base58 (adresse Solana valide) */
const MINT = 'So11111111111111111111111111111111111111112';   /* 43 base58 (wrapped SOL mint) */

async function main() {
  console.log('-- estPubkeySol --');
  ok(sp.estPubkeySol(PUB) && sp.estPubkeySol(MINT), 'une adresse base58 valide passe');
  ok(!sp.estPubkeySol('0xabc') && !sp.estPubkeySol('short') && !sp.estPubkeySol('contains O0Il maybe but has 0'), 'adresses invalides refusees');

  console.log('\n-- metadataIpfs : multipart vers pump.fun, rend la metadataUri --');
  let vu = null;
  const fIpfs = async (u, o) => { vu = { u: String(u), method: o.method, body: o.body }; return { ok: true, status: 200, json: async () => ({ metadataUri: 'ipfs://abc123' }) }; };
  let r = await sp.metadataIpfs({ name: 'Swoge Sol', symbol: 'SSOL', description: 'the dog on solana', image: Buffer.from('PNGDATA'), imageType: 'image/png' }, { fetch: fIpfs });
  ok(r.ok && r.metadataUri === 'ipfs://abc123', 'metadataUri rendue');
  ok(vu.u === 'https://pump.fun/api/ipfs' && vu.method === 'POST' && typeof vu.body === 'object', 'POST multipart vers pump.fun/api/ipfs');

  console.log('\n-- refus propres (metadata) --');
  ok(!(await sp.metadataIpfs({ symbol: 'X', image: Buffer.from('x') }, { fetch: fIpfs })).ok, 'sans name : refuse');
  ok(!(await sp.metadataIpfs({ name: 'X', symbol: 'X' }, { fetch: fIpfs })).ok, 'sans image : refuse (Pump.fun l exige)');
  const fMuet = async () => ({ ok: false, status: 500, json: async () => ({}) });
  ok(!(await sp.metadataIpfs({ name: 'X', symbol: 'X', image: Buffer.from('x') }, { fetch: fMuet })).ok, 'IPFS muet : refuse proprement');

  console.log('\n-- offreCreation : JSON vers PumpPortal, rend la tx en base64 --');
  let vu2 = null;
  const faux = Buffer.from([1, 2, 3, 4, 5]);
  const fTrade = async (u, o) => { vu2 = { u: String(u), body: JSON.parse(o.body) }; return { ok: true, status: 200, arrayBuffer: async () => faux }; };
  r = await sp.offreCreation({ publicKey: PUB, mint: MINT, name: 'Swoge Sol', symbol: 'SSOL', uri: 'ipfs://abc123', devBuySol: 0.5 }, { fetch: fTrade });
  ok(r.ok && r.txBase64 === faux.toString('base64'), 'la transaction serialisee est rendue en base64');
  ok(vu2.u === 'https://pumpportal.fun/api/trade-local' && vu2.body.action === 'create' && vu2.body.pool === 'pump', 'POST create pool=pump vers trade-local');
  ok(vu2.body.publicKey === PUB && vu2.body.mint === MINT && vu2.body.tokenMetadata.uri === 'ipfs://abc123', 'le corps porte le wallet, le mint et l uri');
  ok(vu2.body.amount === 0.5 && vu2.body.denominatedInSol === 'true', 'l achat initial (dev buy) en SOL est transmis');

  console.log('\n-- refus propres (offre) --');
  ok(!(await sp.offreCreation({ publicKey: '0xnope', mint: MINT, name: 'a', symbol: 'b', uri: 'u' }, { fetch: fTrade })).ok, 'wallet non-Solana : refuse');
  ok(!(await sp.offreCreation({ publicKey: PUB, mint: 'bad', name: 'a', symbol: 'b', uri: 'u' }, { fetch: fTrade })).ok, 'mint invalide : refuse');
  const fErr = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
  const e = await sp.offreCreation({ publicKey: PUB, mint: MINT, name: 'a', symbol: 'b', uri: 'u' }, { fetch: fErr });
  ok(!e.ok && /400/.test(e.raison), 'un refus PumpPortal remonte le code');
  const fVide = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(0) });
  ok(!(await sp.offreCreation({ publicKey: PUB, mint: MINT, name: 'a', symbol: 'b', uri: 'u' }, { fetch: fVide })).ok, 'transaction vide : refuse (on ne fait pas signer du vide)');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
