'use strict';
/*
 * Game logic: player balances, provably-fair coin values, winnings.
 *
 * Balance model (all in $SWOGE wei, BigNumber):
 *   deposit  → balance += amount
 *   drop     → balance -= DROP_COST     (and a provably-fair value is locked on the coin)
 *   win      → balance += coinValue     (when the coin is pushed off the front)
 *   withdraw → balance -= amount, cumulativeAuthorized += amount
 *              (the signed voucher authorizes cumulativeAuthorized; the contract
 *               pays cumulative − alreadyWithdrawnOnChain, so it's replay-safe)
 *
 * Provably-fair:
 *   serverSeed (secret) + serverSeedHash (public, sent to clients)
 *   value = POOL[ HMAC(serverSeed, clientSeed:nonce) mod POOL.length ]
 *   Rotating the seed reveals the old serverSeed so players can verify history.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const cfg = require('./config');

const WEI = (n) => ethers.utils.parseUnits(String(n), cfg.DECIMALS);
const COST = WEI(cfg.DROP_COST);
const MINW = WEI(cfg.MIN_WITHDRAW);
const BN = (n) => ethers.BigNumber.from(n);
const MS_YEAR = BN('31536000000'); // 365*24*3600*1000

class Game {
  constructor() {
    this.players = new Map(); // addr -> { balance, cumulativeAuthorized, clientSeed, nonce, name, dayNet, dayKey, dropsToday, winsToday, questClaimed, hasDeposited }
    this.seenTx = new Set();  // dedupe deposits
    this.lastBlock = 0;       // deposit-scan watermark (persisted so a restart resumes)
    this._stakeRateBps = BN(cfg.STAKE_APR_BPS);
    // progressive jackpot (all wei)
    this.jackpotPot = WEI(cfg.JACKPOT_SEED);
    this._jackpotSeed = WEI(cfg.JACKPOT_SEED);
    this._rakeWei = COST.mul(Math.round(cfg.JACKPOT_RAKE_PCT * 100)).div(10000); // pct, 2-dec
    this._rotateSeed();
  }

  /** Snapshot the whole state for persistence (BigNumbers → strings). */
  serialize() {
    const players = [];
    for (const [addr, p] of this.players) {
      players.push([addr, {
        b: p.balance.toString(), c: p.cumulativeAuthorized.toString(),
        s: p.clientSeed, n: p.nonce, name: p.name,
        dn: p.dayNet.toString(), dk: p.dayKey,
        dt: p.dropsToday, wt: p.winsToday, qc: p.questClaimed, hd: p.hasDeposited,
        st: p.staked.toString(), ss: p.stakeSince, sa: p.stakeAccrued.toString(),
      }]);
    }
    return { v: 1, serverSeed: this.serverSeed, jackpotPot: this.jackpotPot.toString(),
             lastBlock: this.lastBlock, seenTx: Array.from(this.seenTx), players };
  }

  /** Restore a snapshot produced by serialize() (called once at startup). */
  hydrate(st) {
    if (!st) return;
    if (st.serverSeed) { this.serverSeed = st.serverSeed; this.serverSeedHash = crypto.createHash('sha256').update(st.serverSeed).digest('hex'); }
    if (st.jackpotPot) this.jackpotPot = ethers.BigNumber.from(st.jackpotPot);
    if (st.lastBlock) this.lastBlock = st.lastBlock;
    if (Array.isArray(st.seenTx)) this.seenTx = new Set(st.seenTx);
    if (Array.isArray(st.players)) for (const [addr, d] of st.players) {
      this.players.set(addr, {
        balance: ethers.BigNumber.from(d.b || '0'),
        cumulativeAuthorized: ethers.BigNumber.from(d.c || '0'),
        clientSeed: d.s || crypto.randomBytes(8).toString('hex'),
        nonce: d.n || 0, name: d.name || addr.slice(0, 6),
        dayNet: ethers.BigNumber.from(d.dn || '0'), dayKey: d.dk || null,
        dropsToday: d.dt || 0, winsToday: d.wt || 0, questClaimed: d.qc || {}, hasDeposited: !!d.hd,
        staked: ethers.BigNumber.from(d.st || '0'), stakeSince: d.ss || 0, stakeAccrued: ethers.BigNumber.from(d.sa || '0'),
      });
    }
  }

  _today() { return new Date().toISOString().slice(0, 10); } // UTC day key
  _bumpDay(p) {
    const t = this._today();
    if (p.dayKey !== t) { p.dayKey = t; p.dayNet = ethers.BigNumber.from(0); p.dropsToday = 0; p.winsToday = 0; p.questClaimed = {}; }
  }
  jackpotStr() { return ethers.utils.formatUnits(this.jackpotPot, cfg.DECIMALS); }

  // ---- Staking: yield accrues per second at STAKE_APR_BPS, claimable anytime ----
  /** Yield (wei) accrued since stakeSince, without mutating (safe for display). */
  _pendingSince(p) {
    if (!p.staked.gt(0) || !p.stakeSince) return BN(0);
    const elapsed = Date.now() - p.stakeSince; // ms
    if (elapsed <= 0) return BN(0);
    // staked × (aprBps/10000) × (elapsed/msPerYear), integer math (wei precision)
    return p.staked.mul(this._stakeRateBps).mul(elapsed).div(10000).div(MS_YEAR);
  }
  /** Fold pending yield into stakeAccrued and restart the clock. */
  _settleStake(p) { p.stakeAccrued = p.stakeAccrued.add(this._pendingSince(p)); p.stakeSince = Date.now(); }

  stake(addr, amountStr) {
    const p = this._p(addr);
    const amount = WEI(amountStr);
    if (amount.lte(0)) throw new Error('enter an amount');
    if (amount.gt(p.balance)) throw new Error('amount exceeds balance');
    this._settleStake(p);
    p.balance = p.balance.sub(amount);
    p.staked = p.staked.add(amount);
  }
  unstake(addr, amountStr) {
    const p = this._p(addr);
    const amount = WEI(amountStr);
    if (amount.lte(0)) throw new Error('enter an amount');
    if (amount.gt(p.staked)) throw new Error('amount exceeds staked');
    this._settleStake(p);
    p.staked = p.staked.sub(amount);
    p.balance = p.balance.add(amount);
  }
  claimStake(addr) {
    const p = this._p(addr);
    this._settleStake(p);
    const reward = p.stakeAccrued;
    if (reward.lte(0)) throw new Error('no yield to claim yet');
    p.stakeAccrued = BN(0);
    p.balance = p.balance.add(reward);
    return ethers.utils.formatUnits(reward, cfg.DECIMALS);
  }
  /** Sum of all staked balances (wei). */
  totalStaked() { let s = BN(0); for (const p of this.players.values()) s = s.add(p.staked); return s; }

  /** Breakdown (wei) of what the vault owes: player balances, staked, pending
   * yield, and the jackpot reserve. */
  owedBreakdown() {
    let balances = BN(0), staked = BN(0), pending = BN(0);
    for (const p of this.players.values()) {
      balances = balances.add(p.balance);
      staked = staked.add(p.staked);
      pending = pending.add(p.stakeAccrued).add(this._pendingSince(p));
    }
    return { balances, staked, pending, jackpot: this.jackpotPot };
  }

  /** Everything the vault OWES players right now (wei): balances + staked +
   * pending yield + the jackpot pot. Owner surplus = vaultPot − this. */
  totalOwed() {
    const b = this.owedBreakdown();
    return b.balances.add(b.staked).add(b.pending).add(b.jackpot);
  }

  stakeInfo(addr) {
    const p = this._p(addr);
    const pending = p.stakeAccrued.add(this._pendingSince(p));
    return {
      staked: ethers.utils.formatUnits(p.staked, cfg.DECIMALS),
      pending: ethers.utils.formatUnits(pending, cfg.DECIMALS),
      aprBps: cfg.STAKE_APR_BPS,
    };
  }

  /** Per-player daily quest state (progress + claimable flags). */
  questState(addr) {
    const p = this._p(addr); this._bumpDay(p);
    const locked = cfg.QUEST_REQUIRE_DEPOSIT && !p.hasDeposited;
    return cfg.QUESTS.map((q) => {
      const prog = q.metric === 'drops' ? p.dropsToday : q.metric === 'wins' ? p.winsToday : q.target; // 'free' → always met
      const done = prog >= q.target;
      const claimed = !!p.questClaimed[q.id];
      return { id: q.id, label: q.label, metric: q.metric, target: q.target, reward: q.reward,
               progress: Math.min(prog, q.target), done, claimed, locked, claimable: done && !claimed && !locked };
    });
  }

  /** Claim a completed quest → credit its reward. Throws on any invalid claim. */
  claimQuest(addr, id) {
    const p = this._p(addr); this._bumpDay(p);
    const q = cfg.QUESTS.find((x) => x.id === id);
    if (!q) throw new Error('unknown quest');
    if (cfg.QUEST_REQUIRE_DEPOSIT && !p.hasDeposited) throw new Error('deposit first to unlock quests');
    const prog = q.metric === 'drops' ? p.dropsToday : q.metric === 'wins' ? p.winsToday : q.target;
    if (prog < q.target) throw new Error('quest not complete yet');
    if (p.questClaimed[q.id]) throw new Error('already claimed today');
    p.questClaimed[q.id] = true;
    const r = WEI(q.reward);
    p.balance = p.balance.add(r);
    p.dayNet = p.dayNet.add(r);
    return q.reward;
  }

  /** Top `n` players by today's net gain (winners only). */
  leaderboard(n) {
    const t = this._today(), arr = [];
    for (const p of this.players.values()) {
      if (p.dayKey === t && p.dayNet.gt(0)) arr.push({ name: p.name, net: ethers.utils.formatUnits(p.dayNet, cfg.DECIMALS) });
    }
    arr.sort((a, b) => parseFloat(b.net) - parseFloat(a.net));
    return arr.slice(0, n);
  }

  _rotateSeed() {
    this.serverSeed = crypto.randomBytes(32).toString('hex');
    this.serverSeedHash = crypto.createHash('sha256').update(this.serverSeed).digest('hex');
  }

  _p(addr) {
    addr = addr.toLowerCase();
    let p = this.players.get(addr);
    if (!p) {
      p = { balance: ethers.BigNumber.from(0), cumulativeAuthorized: ethers.BigNumber.from(0),
            clientSeed: crypto.randomBytes(8).toString('hex'), nonce: 0, name: addr.slice(0, 6),
            dayNet: ethers.BigNumber.from(0), dayKey: null,
            dropsToday: 0, winsToday: 0, questClaimed: {}, hasDeposited: false,
            staked: ethers.BigNumber.from(0), stakeSince: 0, stakeAccrued: ethers.BigNumber.from(0) };
      this.players.set(addr, p);
    }
    return p;
  }

  setName(addr, name) { this._p(addr).name = String(name || '').slice(0, 24) || addr.slice(0, 6); }
  setClientSeed(addr, seed) { this._p(addr).clientSeed = String(seed || '').slice(0, 64) || this._p(addr).clientSeed; }

  balanceWei(addr) { return this._p(addr).balance; }
  balanceStr(addr) { return ethers.utils.formatUnits(this._p(addr).balance, cfg.DECIMALS); }

  /** Credit an on-chain deposit once (deduped by tx hash). */
  creditDeposit({ player, amount, tx }) {
    if (this.seenTx.has(tx)) return false;
    this.seenTx.add(tx);
    const p = this._p(player);
    p.balance = p.balance.add(amount);
    p.hasDeposited = true; // unlocks daily quests (real skin in the game)
    return true;
  }

  canDrop(addr) { return this._p(addr).balance.gte(COST); }

  /**
   * Consume 1 drop cost. Returns { value, jackpotWon } (both provably-fair):
   *   value      = coin value paid when it reaches the front (0 = empty)
   *   jackpotWon = wei won from the progressive pot on this drop (0 if not)
   * Returns null if the balance can't cover the drop.
   */
  drop(addr) {
    const p = this._p(addr);
    if (p.balance.lt(COST)) return null;
    p.balance = p.balance.sub(COST);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(COST); p.dropsToday++;
    const h = crypto.createHmac('sha256', this.serverSeed)
      .update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    // weighted provably-fair pick over cfg.PRIZES ([value, weight]) — bits 0..14
    let r = Number(BigInt('0x' + h.slice(0, 15)) % BigInt(cfg.PRIZE_TOTAL));
    let value = 0;
    for (let i = 0; i < cfg.PRIZES.length; i++) { r -= cfg.PRIZES[i][1]; if (r < 0) { value = cfg.PRIZES[i][0]; break; } }
    // progressive jackpot: feed the pot, then roll the trigger on bits 15..29
    this.jackpotPot = this.jackpotPot.add(this._rakeWei);
    let jackpotWon = ethers.BigNumber.from(0);
    const jr = Number(BigInt('0x' + h.slice(15, 30)) % BigInt(cfg.JACKPOT_ODDS));
    if (jr === 0) {
      jackpotWon = this.jackpotPot;
      p.balance = p.balance.add(jackpotWon);
      p.dayNet = p.dayNet.add(jackpotWon);
      this.jackpotPot = this._jackpotSeed;
    }
    return { value, jackpotWon };
  }

  /** Give back a drop cost (the table was full, so no coin was placed). */
  refund(addr) { const p = this._p(addr); p.balance = p.balance.add(COST); }

  /** A coin was pushed off the front → credit its owner. */
  win(addr, value) {
    if (!value) return;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(value));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(value)); p.winsToday++;
  }

  /** Request a withdrawal of `amountStr` $SWOGE. Returns cumulativeAuthorized (wei) or throws. */
  requestWithdraw(addr, amountStr) {
    const p = this._p(addr);
    const amount = WEI(amountStr);
    if (amount.lt(MINW)) throw new Error('below minimum withdraw (' + cfg.MIN_WITHDRAW + ' $SWOGE)');
    if (amount.gt(p.balance)) throw new Error('amount exceeds balance');
    p.balance = p.balance.sub(amount);
    p.cumulativeAuthorized = p.cumulativeAuthorized.add(amount);
    return p.cumulativeAuthorized;
  }

  fairness(addr) {
    const p = this._p(addr);
    return { serverSeedHash: this.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce };
  }
}

module.exports = { Game, COST, MINW };
