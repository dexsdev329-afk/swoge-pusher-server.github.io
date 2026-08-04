'use strict';
// Central config. Everything overridable via environment variables so the same
// code runs locally (defaults) and on Railway (env vars).
// env() trims whitespace/newlines — pasting a key/address with a trailing
// line break into Railway is a classic footgun, so we scrub it here.
var env = function (name, def) { var v = process.env[name]; return (v === undefined ? def : String(v).trim()); };

module.exports = {
  PORT: parseInt(env('PORT', '8080'), 10),

  // ---- Chain ----
  RPC_URL: env('RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: parseInt(env('CHAIN_ID', '4663'), 10),
  SWOGE_TOKEN: env('SWOGE_TOKEN', '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817'),
  VAULT_ADDRESS: env('VAULT_ADDRESS', ''), // set after deploying SwogePusherVault
  // Backend signer key = the `signer` set in the Vault. Authorizes withdrawals.
  // NEVER commit a real key. Set SIGNER_PRIVATE_KEY on Railway.
  SIGNER_PRIVATE_KEY: env('SIGNER_PRIVATE_KEY', ''),
  DEPOSIT_POLL_MS: parseInt(env('DEPOSIT_POLL_MS', '6000'), 10),

  // ---- Economy ----
  DECIMALS: 18,
  DROP_COST: env('DROP_COST', '1'),         // $SWOGE per coin dropped
  MIN_WITHDRAW: env('MIN_WITHDRAW', '50'),  // must match Vault.minWithdraw
  VOUCHER_TTL_SEC: parseInt(env('VOUCHER_TTL_SEC', '3600'), 10),

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
    frontEdgeZ: 6,    // coins pushed beyond this Z fall off the front = WIN
    pusherTravel: 8,   // long stroke: retracts fully to the back, pushes far forward
    pusherSpeed: 1.0,  // visible push; the forward tilt does the gentle flow
    coinRadius: 0.7,
    coinThickness: 0.35,
    dropY: 6,
    stepHz: 60,       // physics steps per second
    maxCoins: 220,    // hard cap — keeps the server sim fast = smoother playback
  },
  BROADCAST_HZ: parseInt(env('BROADCAST_HZ', '30'), 10), // 30 snapshots/sec = smoother
};
