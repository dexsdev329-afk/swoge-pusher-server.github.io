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

  // Password for the private /admin dashboard + /stats (?key=…). Empty = open
  // (fine for local dev; ALWAYS set it in production).
  ADMIN_KEY: env('ADMIN_KEY', ''),

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

  // ---- New-player welcome bonus (wager-locked) ----
  // A brand-new player gets WELCOME_BONUS $SWOGE to try the game. Once they've
  // actually WAGERED at least once (skin in the game — stops throwaway farming),
  // they can claim an extra WELCOME_CLAIM reward, one time.
  WELCOME_BONUS: parseFloat(env('WELCOME_BONUS', '1')),   // demo credit granted on first login
  WELCOME_CLAIM: parseFloat(env('WELCOME_CLAIM', '5')),   // extra reward, unlocked after wagering

  // ---- 7-day consecutive login streak ----
  // One claim per UTC day; a skipped day resets the streak to day 1. Reward
  // escalates J1→J7, then wraps back to J1. Comma-separated wei-free amounts.
  STREAK_REWARDS: env('STREAK_REWARDS', '1,2,3,5,7,10,15')
    .split(',').map(function (x) { return parseFloat(x.trim()) || 0; }),

  // ---- Rewarded video ads (Adsgram) ----
  // Adsgram calls REWARD_URL (server-to-server) when a user finishes a video.
  // We credit AD_REWARD $SWOGE, capped at AD_DAILY_CAP/day with a cooldown so a
  // single user can't spam. ADSGRAM_KEY guards the endpoint (must be non-empty
  // in production, else the endpoint is disabled).
  AD_REWARD: parseFloat(env('AD_REWARD', '10')),               // $SWOGE per finished video
  AD_DAILY_CAP: parseInt(env('AD_DAILY_CAP', '5'), 10),        // max rewarded videos / day / player
  AD_COOLDOWN_SEC: parseInt(env('AD_COOLDOWN_SEC', '30'), 10), // min seconds between two rewards
  ADSGRAM_KEY: env('ADSGRAM_KEY', ''),                         // shared secret in the Reward URL
  ADSGRAM_BLOCK_ID: env('ADSGRAM_BLOCK_ID', '41851'),          // Adsgram UnitID (sent to the client)

  // ---- Staking (yield on staked $SWOGE, claimable anytime) ----
  // Paid FROM the vault — fund it (ownerDeposit) or it drains. 100% APR is a
  // BIG liability (you owe double after a year), so keep the vault funded.
  STAKE_APR_BPS: parseInt(env('STAKE_APR_BPS', '10000'), 10),        // 10000 = 100% APR
  STAKE_LOCK_DAYS: parseInt(env('STAKE_LOCK_DAYS', '365'), 10),      // soft-lock length
  STAKE_EARLY_PENALTY_BPS: parseInt(env('STAKE_EARLY_PENALTY_BPS', '5000'), 10), // 5000 = lose 50% of principal if you exit before the lock ends

  // ---- Telegram notifications (deposits / big wins / stakes) ----
  // Accepts either TG_* or the TELEGRAM_* names your other bots already use.
  TG_BOT_TOKEN: env('TG_BOT_TOKEN', '') || env('TELEGRAM_BOT_TOKEN', ''),   // BotFather token
  TG_CHAT_ID: env('TG_CHAT_ID', '') || env('TELEGRAM_CHAT_ID', ''),         // channel/group id (e.g. -100123…) or @channel
  EXPLORER: env('EXPLORER', 'https://robinhoodchain.blockscout.com'),
  NOTIFY_DEPOSIT_MIN: parseFloat(env('NOTIFY_DEPOSIT_MIN', '0')),  // notify deposits ≥ this
  DEPOSIT_IMAGE: env('DEPOSIT_IMAGE', 'https://i.ibb.co/jkCkzPpM/Chat-GPT-Image-5-ao-t-2026-15-41-22.png'), // image shown on deposit notifs ('' = none)
  STAKE_IMAGE: env('STAKE_IMAGE', 'https://i.ibb.co/4gKk59sQ/Chat-GPT-Image-5-ao-t-2026-15-53-47.png'),     // image shown on stake notifs ('' = none)
  NOTIFY_WIN_MIN: parseInt(env('NOTIFY_WIN_MIN', '500'), 10),      // notify single-coin wins ≥ this
  NOTIFY_STAKE_MIN: parseFloat(env('NOTIFY_STAKE_MIN', '100')),    // notify stakes ≥ this

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

  // ---- SWOGE Smash (spin game) — provably-fair, RTP = 50% ----
  // 1 spin costs SPIN_COST $SWOGE and pays (multiplier × SPIN_COST).
  // [multiplier, weight] out of SPIN_TOTAL. Σ(weight·mult)/SPIN_TOTAL must equal
  // the target RTP. Here Σ = 5,000,000 / 10,000,000 = 0.50 exactly (RTP 50%).
  SPIN_COST: env('SPIN_COST', '1'),
  SPIN_PRIZES: [
    [0,    8576000],  // 85.76%  smash → nothing
    [1,     900000],  //  9.00%  money back
    [2,     300000],  //  3.00%
    [5,     100000],  //  1.00%
    [10,    100000],  //  1.00%
    [50,     20000],  //  0.20%
    [250,     4000],  //  0.04%  jackpot shard
  ],
  SPIN_TOTAL: 10000000,

  // Mise variable au Smash : payout = multiplicateur x mise (max 250x).
  // Exposition maximale = SMASH_MAX_BET x 250.
  SMASH_MIN_BET: parseInt(env('SMASH_MIN_BET', '1'), 10),
  SMASH_MAX_BET: parseInt(env('SMASH_MAX_BET', '1000'), 10),

  // ---- SWOGE Blackjack ----
  BJ_MAX_BET: parseInt(env('BJ_MAX_BET', '10000'), 10),  // max $SWOGE per hand
  BJ_MIN_BET: parseInt(env('BJ_MIN_BET', '1'), 10),

  // ---- SWOGE Casino (jeux contre la banque) ----
  // Ici la MAISON joue son argent : contrairement au poker ou l'on prend une
  // commission sans risque, une session courte peut couter cher malgre les
  // 2,4 % d'avantage. Le plafond est donc volontairement bas.
  // Commission de la maison sur le GAIN NET (jamais sur les mises rendues :
  // une egalite rend exactement la mise). 1350 bps = 13,5 % du gain, ce qui
  // amene le retour joueur a 92 % — 8 % pour la maison. C'est deja bien
  // au-dessus des 2-3 % d'un vrai casino, mais assez bas pour qu'un joueur
  // reste. Reperes mesures : 0 -> 97,6 % · 1350 -> 92 % · 2000 -> 89 %
  // · 4200 -> 80 %. Une seule valeur a changer.
  CASINO_WIN_FEE_BPS: parseInt(env('CASINO_WIN_FEE_BPS', '1350'), 10),
  CASINO_MIN_BET: parseInt(env('CASINO_MIN_BET', '10'), 10),
  // Plafond volontairement bas : ici c'est l'argent de la maison qui est en
  // jeu, et au Hold'em suivre engage 3x l'Ante, soit 30 000 sur une main.
  CASINO_MAX_BET: parseInt(env('CASINO_MAX_BET', '10000'), 10),

  // ---- SWOGE Poker (Texas Hold'em, 6 max, pas de bot) ----
  // Une table ne distribue jamais tant qu'un deuxieme joueur reel n'est pas
  // assis. Une minute par decision, exclusion apres 5 mains sans action.
  POKER_ACTION_MS: parseInt(env('POKER_ACTION_MS', '60000'), 10),
  POKER_IDLE_HANDS: parseInt(env('POKER_IDLE_HANDS', '5'), 10),
  POKER_BETWEEN_HANDS_MS: parseInt(env('POKER_BETWEEN_HANDS_MS', '6000'), 10),
  POKER_RAKE_BPS: parseInt(env('POKER_RAKE_BPS', '500'), 10),   // 5 %, seulement si le flop est vu
  // La cave par defaut vaut 20 a 200 grosses blindes : c'est ce qui rend le
  // poker jouable. Une cave enorme sur de petites blindes ne sert a rien —
  // a 10 M sur du 250/500 on serait a 20 000 blindes de profondeur, et plus
  // aucune mise ne peserait vraiment sur la main. L'echelle monte donc avec les blindes.
  POKER_TABLES: [
    { id: 'micro', name: 'Doge Micro', smallBlind: 5,      bigBlind: 10,
      minBuyIn: 200,       maxBuyIn: 2000 },
    { id: 'low',   name: 'Wolf Low',   smallBlind: 250,    bigBlind: 500,
      minBuyIn: 10000,     maxBuyIn: 100000 },
    { id: 'high',  name: 'Bull High',  smallBlind: 12500,  bigBlind: 25000,
      minBuyIn: 500000,    maxBuyIn: 10000000 },
  ],

  // ---- SWOGE Spin (Volcano slot) ----
  // Allowed bets; each spin costs `bet` $SWOGE, payout = base × bet (RTP ~70%).
  VOLCANO_BETS: [10, 20, 50, 100, 500, 1000, 10000, 100000],
  VOLCANO_BONUS_COST_MULT: 33,   // "Buy Bonus" costs bet × this (tuned so the bought feature is ~70% RTP, matching the base game, after the fuller-board rebalance)

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
