'use strict';
/* ==================================================================
 * PAYER UN SERVICE x402 (v2) — LE CLIENT PARTAGE (28 septembre 2026)
 * ==================================================================
 *
 * Sorti d'auto_inscription.js (27/09), a l'identique, pour servir aussi a
 * l'agent qui embauche d'autres services (embauche.js) : un portefeuille
 * DEDIE (cle EVM → USDC sur Base, autorisation EIP-3009 ; cle Solana → USDC
 * sur Solana, la transaction du client de reference, x402_solana.js), et la
 * signature d'une offre `accepts[i]` d'un 402 v2. Aucune regle metier ici :
 * qui on paie, combien au plus, c'est l'appelant qui le verifie AVANT.
 * La cle ne sort jamais : ni journal, ni reponse — l'adresse seule.
 * ================================================================== */
const crypto = require('crypto');
const { ethers } = require('ethers');
/* x402_solana.js vise le navigateur (crypto.subtle, btoa) : Node 18 (le Dockerfile) n'a pas `crypto` en global. */
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
const Sol = require('./x402_solana');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RESEAU_BASE = 'eip155:8453';
const RESEAU_SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const DOMAINE = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE };
const TYPES_3009 = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const de64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

/** Un portefeuille depuis une cle privee : { type, address, … } ou null (jamais la cle dans un message). */
function portefeuille(cle) {
  const c = String(cle || '').trim();
  if (!c) return null;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(c)) {
    try { const w = new ethers.Wallet(/^0x/.test(c) ? c : '0x' + c); return { type: 'evm', address: w.address, w }; } catch (e) { return null; }
  }
  /* Solana : 64 octets (graine ‖ cle publique) en base58 ou en tableau JSON, ou la graine seule (32). */
  let o = null;
  try {
    if (/^\[[\d,\s]+\]$/.test(c)) o = Buffer.from(JSON.parse(c));
    else if (/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(c)) o = Buffer.from(ethers.utils.base58.decode(c));
  } catch (e) { o = null; }
  if (!o || (o.length !== 64 && o.length !== 32)) return null;
  try {
    const cle = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, o.slice(0, 32)]), format: 'der', type: 'pkcs8' });
    const pub = crypto.createPublicKey(cle).export({ format: 'der', type: 'spki' }).slice(-32);
    if (o.length === 64 && !pub.equals(o.slice(32))) return null;           /* la moitie publique doit etre la bonne */
    return { type: 'solana', address: ethers.utils.base58.encode(pub), signe: (msg) => crypto.sign(null, Buffer.from(msg), cle) };
  } catch (e) { return null; }
}

/** Le reseau et l'USDC qu'un portefeuille sait payer. */
const reseauDe = (w) => (w && w.type === 'solana' ? { network: RESEAU_SOLANA, asset: USDC_SOLANA } : { network: RESEAU_BASE, asset: USDC_BASE });
/** L'offre d'un 402 que ce portefeuille peut payer (exact, son reseau, USDC), ou null. */
function offrePour(w, accepts) {
  const r = reseauDe(w);
  return (accepts || []).find((a) => a && (a.scheme || 'exact') === 'exact' && a.network === r.network
    && (w.type === 'solana' ? a.asset === r.asset : String(a.asset).toLowerCase() === r.asset.toLowerCase())) || null;
}

/* ---- x402 v1 (specs/x402-specification-v1.md et specs/transports-v1/http.md du depot
   coinbase/x402, lus le 28/09/2026) : le 402 porte ses offres dans le CORPS JSON
   ({ x402Version: 1, error, accepts }), le montant s'appelle `maxAmountRequired`, les
   reseaux ont des noms (« base », « solana »), le paiement part dans l'en-tete
   X-PAYMENT (base64 de { x402Version: 1, scheme, network, payload }) et le recu revient
   dans X-PAYMENT-RESPONSE. Le `payload` est le meme qu'en v2 (EIP-3009 ; transaction
   Solana). On ramene chaque offre v1 a la forme v2 (`amount`, reseau CAIP-2) en gardant
   l'originale dans `v1`, pour que tout le reste — choix de l'offre, plafonds, signature
   — soit le meme code. ---- */
const RESEAUX_V1 = { base: RESEAU_BASE, solana: RESEAU_SOLANA };
function offreV1(a) {
  if (!a || !RESEAUX_V1[a.network]) return null;
  return Object.assign({}, a, { network: RESEAUX_V1[a.network], amount: String(a.maxAmountRequired), v1: a });
}
/** Le 402 lu dans une reponse : v2 (en-tete PAYMENT-REQUIRED, sinon corps) ou v1 (corps). null s'il n'y en a pas. */
async function lit402(r) {
  const h = r.headers.get('payment-required');
  if (h) { try { const q = de64(h); if (q && Array.isArray(q.accepts)) return Object.assign({ x402Version: 2 }, q); } catch (e) { /* on essaie le corps */ } }
  try {
    const q = await r.json();
    if (q && Number(q.x402Version) === 2 && Array.isArray(q.accepts)) return q;
    if (q && Number(q.x402Version) === 1 && Array.isArray(q.accepts)) return { x402Version: 1, accepts: q.accepts.map(offreV1).filter(Boolean) };
  } catch (e) { /* pas de JSON */ }
  return null;
}

/**
 * Signe une offre. Rend { payload } ou { erreur }. `o.blockhash()` (Solana) : { ok, blockhash }.
 */
async function signe(w, acc, o) {
  o = o || {};
  if (w.type === 'solana') {
    if (!acc.extra || !acc.extra.feePayer) return { erreur: 'no feePayer in the Solana offer' };
    const bh = o.blockhash ? await o.blockhash() : null;
    if (!bh || !bh.ok) return { erreur: 'no recent Solana blockhash' + (bh && bh.raison ? ' (' + bh.raison + ')' : '') };
    const t = await Sol.construit(acc, { payeur: w.address, blockhash: bh.blockhash });
    const octets = Buffer.from(t.octets);
    w.signe(octets.slice(1 + 128)).copy(octets, 1 + 64);            /* le payeur est le 2e signataire, apres le feePayer */
    return { payload: { transaction: octets.toString('base64') } };
  }
  const s = Math.floor((o.maintenant ? o.maintenant() : Date.now()) / 1000);
  const auth = { from: w.address, to: acc.payTo, value: String(acc.amount), validAfter: String(s - 600),
    validBefore: String(s + Math.max(30, (Number(acc.maxTimeoutSeconds) || 120) - 20)), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
  const signature = await w.w._signTypedData(Object.assign({}, DOMAINE, acc.extra && acc.extra.name ? { name: acc.extra.name, version: acc.extra.version } : {}), TYPES_3009, auth);
  return { payload: { signature, authorization: auth } };
}

/** L'en-tete PAYMENT-SIGNATURE d'un paiement signe (v2). */
const entete = (req, acc, payload) => b64({ x402Version: 2, resource: req.resource, accepted: acc, payload, extensions: req.extensions });
/** L'en-tete a envoyer : { nom: valeur }, selon la version du 402. */
function enteteDe(req, acc, payload) {
  if (Number(req.x402Version) === 1) return { 'x-payment': b64({ x402Version: 1, scheme: 'exact', network: (acc.v1 || acc).network, payload }) };
  return { 'payment-signature': entete(req, acc, payload) };
}
/** La transaction reglee, lue dans PAYMENT-RESPONSE (v2) ou X-PAYMENT-RESPONSE (v1), ou null. */
function txDe(r) {
  for (const n of ['payment-response', 'x-payment-response']) {
    try { const rep = r.headers.get(n); if (rep) { const t = de64(rep).transaction; if (t) return t; } } catch (e) { /* suivant */ }
  }
  return null;
}

module.exports = { portefeuille, reseauDe, offrePour, lit402, signe, entete, enteteDe, txDe, offreV1, RESEAUX_V1, b64, de64,
  USDC_BASE, USDC_SOLANA, RESEAU_BASE, RESEAU_SOLANA, DOMAINE, TYPES_3009 };
