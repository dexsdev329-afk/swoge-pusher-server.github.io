'use strict';
// Central config. Everything overridable via environment variables so the same
// code runs locally (defaults) and on Railway (env vars).
// env() trims whitespace/newlines — pasting a key/address with a trailing
// line break into Railway is a classic footgun, so we scrub it here.
var env = function (name, def) { var v = process.env[name]; return (v === undefined ? def : String(v).trim()); };

module.exports = {
  PORT: parseInt(env('PORT', '8080'), 10),

  // Where the persistent game state (balances etc.) is written. On Railway,
  // mount a VOLUME at this path so it survives redeploys/restarts.
  DATA_DIR: env('DATA_DIR', './data'),
  SAVE_MS: parseInt(env('SAVE_MS', '10000'), 10),

  // ---- Chain ----
  RPC_URL: env('RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: parseInt(env('CHAIN_ID', '4663'), 10),
  SWOGE_TOKEN: env('SWOGE_TOKEN', '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817'),
  VAULT_ADDRESS: env('VAULT_ADDRESS', ''), // set after deploying SwogePusherVault
  // One-time recovery: on the FIRST run (no saved state), scan Deposit events
  // from this block instead of the chain tip, so deposits made before
  // persistence existed are re-credited. Set it once to the Vault's deploy
  // block, then leave it — seenTx dedupes and the contract caps withdrawals.
  SCAN_FROM_BLOCK: parseInt(env('SCAN_FROM_BLOCK', '0'), 10),
  // Backend signer key = the `signer` set in the Vault. Authorizes withdrawals.
  // NEVER commit a real key. Set SIGNER_PRIVATE_KEY on Railway.
  SIGNER_PRIVATE_KEY: env('SIGNER_PRIVATE_KEY', ''),
  DEPOSIT_POLL_MS: parseInt(env('DEPOSIT_POLL_MS', '6000'), 10),

  // ---- Economy ----
  DECIMALS: 18,
  DROP_COST: env('DROP_COST', '1'),         // $SWOGE per coin dropped
  MIN_WITHDRAW: env('MIN_WITHDRAW', '50'),  // must match Vault.minWithdraw
  VOUCHER_TTL_SEC: parseInt(env('VOUCHER_TTL_SEC', '3600'), 10),

  // ---- Progressive jackpot ----
  // A slice of each drop (RAKE_PCT % of DROP_COST, taken from the house edge)
  // grows a shared pot. Every drop has a 1-in-ODDS provably-fair chance to win
  // the whole pot, which then resets to SEED. Average pot at win ≈ SEED +
  // rake×ODDS (defaults ≈ 100k, up to 1M+ on a long dry streak).
  JACKPOT_SEED: env('JACKPOT_SEED', '10000'),
  JACKPOT_RAKE_PCT: parseFloat(env('JACKPOT_RAKE_PCT', '3')),   // % of each drop → pot
  JACKPOT_ODDS: parseInt(env('JACKPOT_ODDS', '3000000'), 10),   // 1-in-N per drop
  LEADERBOARD_SIZE: parseInt(env('LEADERBOARD_SIZE', '10'), 10),

  // ---- Daily quests ----
  // Anti-Sybil: total rewards (50) < house edge on the wagering required to
  // finish them (~300 drops → ~60 edge), AND claiming needs a real deposit.
  // So farming with throwaway wallets costs more than it pays.
  QUESTS: [
    { id: 'daily',   label: 'Daily bonus',      metric: 'free',  target: 0,   reward: parseInt(env('Q_DAILY',  '5'),  10) },
    { id: 'drop100', label: 'Drop 100 coins',   metric: 'drops', target: 100, reward: parseInt(env('Q_DROP100', '10'), 10) },
    { id: 'drop300', label: 'Drop 300 coins',   metric: 'drops', target: 300, reward: parseInt(env('Q_DROP300', '25'), 10) },
    { id: 'win3',    label: 'Win 3 prizes',     metric: 'wins',  target: 3,   reward: parseInt(env('Q_WIN3',    '15'), 10) },
  ],
  QUEST_REQUIRE_DEPOSIT: env('QUEST_REQUIRE_DEPOSIT', '1') === '1',

  // ---- Staking (yield on staked $SWOGE, claimable anytime) ----
  // Paid FROM the vault — fund it (ownerDeposit) or it drains. Tunable APR.
  STAKE_APR_BPS: parseInt(env('STAKE_APR_BPS', '5000'), 10), // 5000 = 50% APR

  // ---- Provably-fair prize table (weighted tiers) ----
  // [value, weight] out of PRIZE_TOTAL (10,000,000). A weighted table (instead
  // of a flat array) lets us express very rare big lots cleanly AND keep the
  // exact same provably-fair HMAC selection.
  //
  // Design: ~47.5% of coins show a WIN (lots of small ones = good feel), a
  // ladder up to a 1-in-10M "gros lot". Average value ≈ 1.043 $SWOGE/drop.
  // Real RTP = avg × collection-rate(≈0.77 on this table) ≈ 80%.
  PRIZES: [
    [0,      5246000],  // 52.46%  miss
    [1,      2900000],  // 29.0%
    [2,      1240000],  // 12.4%
    [5,       480000],  // 4.80%
    [10,       95000],  // 0.95%
    [25,       28000],  // 0.28%
    [50,        7500],  // 0.075%
    [100,       2600],  // 0.026%   (~1 in 3,846)
    [250,        700],  // ~1 in 14,286
    [500,        160],  // ~1 in 62,500
    [1000,        35],  // ~1 in 285,714
    [5000,         4],  // ~1 in 2,500,000
    [50000,        1],  // ~1 in 10,000,000  ← the "gros lot"
  ],
  PRIZE_TOTAL: 10000000,

  // ---- Physics / table (server units) ----
  TABLE: {
    width: 11,         // X extent of the shelf
    depth: 13,         // Z extent — SHORTER so coins actually reach the front
    frontEdgeZ: 4.5,   // coins pushed beyond this Z fall off the front = WIN
    pusherTravel: 7.5, // long stroke: retracts fully to the back wall, pushes near the front
    pusherSpeed: 1.7,  // faster, stronger stroke (user: too slow / not pushing hard enough)
    coinRadius: 0.7,
    coinThickness: 0.35,
    dropY: 6,
    stepHz: 60,       // physics steps per second
    maxCoins: 220,    // hard cap — keeps the server sim fast = smoother playback
  },
  BROADCAST_HZ: parseInt(env('BROADCAST_HZ', '30'), 10), // 30 snapshots/sec = smoother
};
