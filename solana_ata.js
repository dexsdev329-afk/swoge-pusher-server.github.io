'use strict';
/* ==========================================================================
 * LE COMPTE USDC ASSOCIE D'UNE ADRESSE SOLANA (ATA), SANS DEPENDANCE
 *
 * Mesure du 27 septembre 2026 : l'adresse de reception du proprietaire
 * (X402_SOLANA_PAYTO) n'avait AUCUN compte USDC (getTokenAccountsByOwner :
 * []). Un paiement x402 sur Solana est un TransferChecked vers le compte
 * associe de payTo (scheme_exact_svm.md §1.1) ; le schema ne laisse pas le
 * payeur le creer (chemin 1 : budget, budget, TransferChecked, memo/Lighthouse
 * seulement). Tant qu'il n'existe pas, tout paiement echoue : on ne propose
 * pas Solana.
 *
 * Derivation (programme ATA) : trouver la plus grande graine b (255 → 0) telle
 * que sha256(owner ‖ programme jeton ‖ mint ‖ b ‖ programme ATA ‖
 * « ProgramDerivedAddress ») ne soit PAS un point de la courbe ed25519.
 * Verifie contre @solana/web3.js 1.99.0 (PublicKey.findProgramAddressSync) et
 * @solana/spl-token (getAssociatedTokenAddressSync) : solana_ata.test.js.
 * ======================================================================== */
const crypto = require('crypto');
const { utils: { base58 } } = require('ethers');

const PROGRAMME_JETON = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PROGRAMME_ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const P = (1n << 255n) - 19n;
const puiss = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; };
const D = (-121665n * puiss(121666n, P - 2n)) % P + P;          /* -121665/121666 mod p */
const RACINE_M1 = puiss(2n, (P - 1n) / 4n);                     /* sqrt(-1) mod p */

/** 32 octets : un point valide de ed25519 (decompression RFC 8032 §5.1.3) ? */
function surLaCourbe(o) {
  if (!o || o.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? o[i] & 0x7f : o[i]);
  const signe = o[31] >> 7;
  if (y >= P) return false;
  const y2 = y * y % P;
  const u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;
  const v3 = v * v % P * v % P, v7 = v3 * v3 % P * v % P;
  let x = u * v3 % P * puiss(u * v7 % P, (P - 5n) / 8n) % P;
  const vx2 = v * x % P * x % P;
  if (vx2 === u) { /* bon */ }
  else if (vx2 === (P - u) % P) x = x * RACINE_M1 % P;
  else return false;
  if (x === 0n && signe === 1) return false;
  return true;
}

function octets(adr) {
  const b = Buffer.from(base58.decode(adr));
  if (b.length !== 32) throw new Error('not a 32-byte Solana address: ' + adr);
  return b;
}

/** Adresse derivee d'un programme : [adresse base58, graine]. */
function trouvePda(graines, programme) {
  const prog = octets(programme);
  for (let b = 255; b >= 0; b--) {
    const h = crypto.createHash('sha256');
    for (const g of graines) h.update(g);
    h.update(Buffer.from([b])); h.update(prog); h.update('ProgramDerivedAddress');
    const o = h.digest();
    if (!surLaCourbe(o)) return [base58.encode(o), b];
  }
  throw new Error('no program address found');
}

/** Le compte associe (programme jeton classique) de `proprietaire` pour `mint`. */
function ata(proprietaire, mint) {
  return trouvePda([octets(proprietaire), octets(PROGRAMME_JETON), octets(mint)], PROGRAMME_ATA)[0];
}

module.exports = { ata, trouvePda, surLaCourbe, PROGRAMME_JETON, PROGRAMME_ATA };
