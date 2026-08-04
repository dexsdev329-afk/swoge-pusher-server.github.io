'use strict';
// Central config. Everything overridable via environment variables so the same
// code runs locally (defaults) and on Railway (env vars).
module.exports = {
  PORT: parseInt(process.env.PORT || '8080', 10),

  // ---- Chain ----
  RPC_URL: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  CHAIN_ID: parseInt(process.env.CHAIN_ID || '4663', 10),
  SWOGE_TOKEN: process.env.SWOGE_TOKEN || '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817',
  VAULT_ADDRESS: process.env.VAULT_ADDRESS || '', // set after deploying SwogePusherVault
  // Backend signer key = the `signer` set in the Vault. Authorizes withdrawals.
  // NEVER commit a real key. Set SIGNER_PRIVATE_KEY on Railway.
  SIGNER_PRIVATE_KEY: process.env.SIGNER_PRIVATE_KEY || '',
  DEPOSIT_POLL_MS: parseInt(process.env.DEPOSIT_POLL_MS || '6000', 10),

  // ---- Economy ----
  DECIMALS: 18,
  DROP_COST: process.env.DROP_COST || '1',         // $SWOGE per coin dropped
  MIN_WITHDRAW: process.env.MIN_WITHDRAW || '50',  // must match Vault.minWithdraw
  VOUCHER_TTL_SEC: parseInt(process.env.VOUCHER_TTL_SEC || '3600', 10),

  // ---- Provably-fair pool (coin values in whole $SWOGE) ----
  // Same spirit as the client pool: mostly 0 (empty), a few prizes. ~80% RTP
  // is approached via these values + the physics dynamics (tunable).
  POOL: (function () {
    const add = (arr, n, v) => { for (let i = 0; i < n; i++) arr.push(v); return arr; };
    let p = [];
    add(p, 1, 500); add(p, 5, 100); add(p, 20, 25);
    add(p, 100, 5); add(p, 500, 2); add(p, 2000, 1);
    add(p, 3624, 0);
    return p; // 6250 entries, sum 5000 → 0.80 avg
  })(),

  // ---- Physics / table (server units) ----
  TABLE: {
    width: 11,        // X extent of the shelf
    depth: 18,        // Z extent
    frontEdgeZ: 8,    // coins pushed beyond this Z fall off the front = WIN
    pusherTravel: 3,  // how far the pusher slides in Z
    pusherSpeed: 1.2, // slides/sec factor
    coinRadius: 0.7,
    coinThickness: 0.35,
    dropY: 6,
    stepHz: 60,       // physics steps per second
    maxCoins: 400,    // hard cap to protect CPU/bandwidth
  },
  BROADCAST_HZ: parseInt(process.env.BROADCAST_HZ || '20', 10),
};
