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
const volcano = require('./volcano');

const WEI = (n) => ethers.utils.parseUnits(String(n), cfg.DECIMALS);
const COST = WEI(cfg.DROP_COST);
const SPIN_COST = WEI(cfg.SPIN_COST || '1');
const MINW = WEI(cfg.MIN_WITHDRAW);
const BN = (n) => ethers.BigNumber.from(n);
const MS_YEAR = BN('31536000000'); // 365*24*3600*1000

class Game {
  constructor() {
    this.players = new Map(); // addr -> { balance, cumulativeAuthorized, clientSeed, nonce, name, dayNet, dayKey, dropsToday, winsToday, questClaimed, hasDeposited }
    this.telegramMap = new Map(); // telegramId (string) -> addr, so the Adsgram reward postback can find the account
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
        stk: p.stakes.map((x) => [x.a.toString(), x.s, x.u]), sa: p.stakeAccrued.toString(),
        tw: (p.wagered || ethers.BigNumber.from(0)).toString(), bc: p.betCount || 0,
        bj: p.bj || null, vm: p.volcanoMeter || 0,
        tg: p.tgId || null,
        wg: !!p.welcomeGranted, ww: !!p.welcomeWagered, wc: !!p.welcomeClaimed,
        sd: p.streakDay || 0, sl: p.streakLastClaimDay || null,
        ac: p.adCount || 0, ak: p.adDayKey || null, al: p.adLastMs || 0,
      }]);
    }
    return { v: 1, serverSeed: this.serverSeed, jackpotPot: this.jackpotPot.toString(),
             lastBlock: this.lastBlock, seenTx: Array.from(this.seenTx), players,
             telegramMap: Array.from(this.telegramMap) };
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
        stakes: Array.isArray(d.stk)
          ? d.stk.map((x) => ({ a: ethers.BigNumber.from(x[0]), s: x[1], u: x[2] }))
          : (d.st && d.st !== '0' // migrate old single-stake format → one locked position
              ? [{ a: ethers.BigNumber.from(d.st), s: d.ss || Date.now(), u: (d.ss || Date.now()) + cfg.STAKE_LOCK_DAYS * 86400000 }]
              : []),
        stakeAccrued: ethers.BigNumber.from(d.sa || '0'),
        wagered: ethers.BigNumber.from(d.tw || '0'), betCount: d.bc || 0,
        bj: d.bj || null, volcanoMeter: d.vm || 0,
        tgId: d.tg || null,
        welcomeGranted: !!d.wg, welcomeWagered: !!d.ww, welcomeClaimed: !!d.wc,
        streakDay: d.sd || 0, streakLastClaimDay: d.sl || null,
        adCount: d.ac || 0, adDayKey: d.ak || null, adLastMs: d.al || 0,
      });
    }
    if (Array.isArray(st.telegramMap)) this.telegramMap = new Map(st.telegramMap.map((e) => [String(e[0]), String(e[1]).toLowerCase()]));
  }

  _today() { return new Date().toISOString().slice(0, 10); } // UTC day key
  // UTC day key shifted by `n` days (n<0 = past). Used for streak "was yesterday?".
  _dayShift(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
  // Called every time a player actually stakes a bet — unlocks the welcome claim.
  // Appele a chaque mise reelle : debloque le bonus de bienvenue ET cumule le
  // total joue a vie (affiche dans le tableau de bord admin).
  _markWager(p, wei) {
    if (!p) return;
    if (!p.welcomeWagered) p.welcomeWagered = true;
    if (wei) { p.wagered = (p.wagered || BN(0)).add(wei); p.betCount = (p.betCount || 0) + 1; }
  }
  _bumpDay(p) {
    const t = this._today();
    if (p.dayKey !== t) { p.dayKey = t; p.dayNet = ethers.BigNumber.from(0); p.dropsToday = 0; p.winsToday = 0; p.questClaimed = {}; }
  }
  jackpotStr() { return ethers.utils.formatUnits(this.jackpotPot, cfg.DECIMALS); }

  // ---- Staking: 100% APR, per-position soft lock; early exit forfeits 50% ----
  _lockMs() { return cfg.STAKE_LOCK_DAYS * 86400000; }
  _pendingPos(pos) {
    const elapsed = Date.now() - pos.s;
    if (elapsed <= 0) return BN(0);
    return pos.a.mul(this._stakeRateBps).mul(elapsed).div(10000).div(MS_YEAR); // a × apr × elapsed/yr
  }
  _pendingAll(p) { let y = BN(0); for (const pos of p.stakes) y = y.add(this._pendingPos(pos)); return y; }
  _settleStakes(p) { const now = Date.now(); for (const pos of p.stakes) { p.stakeAccrued = p.stakeAccrued.add(this._pendingPos(pos)); pos.s = now; } }
  _stakedTotal(p) { let s = BN(0); for (const pos of p.stakes) s = s.add(pos.a); return s; }

  stake(addr, amountStr) {
    const p = this._p(addr);
    const amount = WEI(amountStr);
    if (amount.lte(0)) throw new Error('enter an amount');
    if (amount.gt(p.balance)) throw new Error('amount exceeds balance');
    this._settleStakes(p);
    p.balance = p.balance.sub(amount);
    const now = Date.now();
    p.stakes.push({ a: amount, s: now, u: now + this._lockMs() }); // a=amount, s=lastSettle, u=unlockAt
  }

  claimStake(addr) {
    const p = this._p(addr);
    this._settleStakes(p);
    const reward = p.stakeAccrued;
    if (reward.lte(0)) throw new Error('no yield to claim yet');
    p.stakeAccrued = BN(0);
    p.balance = p.balance.add(reward);
    return ethers.utils.formatUnits(reward, cfg.DECIMALS);
  }

  /** Unstake EVERYTHING + pay accrued yield. Unlocked positions return in full;
   * still-locked ones return (1 − penalty), the rest is forfeited to the vault. */
  unstakeAll(addr) {
    const p = this._p(addr);
    if (!p.stakes.length) throw new Error('nothing staked');
    this._settleStakes(p);
    const now = Date.now();
    let returned = BN(0), penalty = BN(0);
    for (const pos of p.stakes) {
      if (now >= pos.u) { returned = returned.add(pos.a); }
      else {
        const keep = pos.a.mul(10000 - cfg.STAKE_EARLY_PENALTY_BPS).div(10000);
        returned = returned.add(keep);
        penalty = penalty.add(pos.a.sub(keep)); // forfeited → stays in the vault (house)
      }
    }
    const yld = p.stakeAccrued;
    p.stakeAccrued = BN(0);
    p.stakes = [];
    p.balance = p.balance.add(returned).add(yld);
    const f = (w) => ethers.utils.formatUnits(w, cfg.DECIMALS);
    return { returned: f(returned), penalty: f(penalty), yield: f(yld) };
  }

  /** Sum of all staked principal (wei). */
  totalStaked() { let s = BN(0); for (const p of this.players.values()) s = s.add(this._stakedTotal(p)); return s; }

  /** Breakdown (wei) of what the vault owes: player balances, staked, pending
   * yield, and the jackpot reserve. */
  owedBreakdown() {
    let balances = BN(0), staked = BN(0), pending = BN(0);
    for (const p of this.players.values()) {
      balances = balances.add(p.balance);
      staked = staked.add(this._stakedTotal(p));
      pending = pending.add(p.stakeAccrued).add(this._pendingAll(p));
    }
    return { balances, staked, pending, jackpot: this.jackpotPot };
  }

  /** Everything the vault OWES players right now (wei): balances + staked +
   * pending yield + the jackpot pot. Owner surplus = vaultPot − this. */
  totalOwed() {
    const b = this.owedBreakdown();
    return b.balances.add(b.staked).add(b.pending).add(b.jackpot);
  }

  /** Une ligne par joueur pour le tableau de bord proprietaire (/players). */
  playersReport() {
    const f = (w) => ethers.utils.formatUnits(w || BN(0), cfg.DECIMALS);
    const rows = [];
    for (const [addr, p] of this.players) {
      const staked = this._stakedTotal(p);
      const pending = p.stakeAccrued.add(this._pendingAll(p));
      rows.push({
        address: addr,
        name: p.name || addr.slice(0, 6),
        balance: f(p.balance),
        staked: f(staked),
        pending: f(pending),
        wagered: f(p.wagered),                     // total joue a vie
        bets: p.betCount || 0,                     // nombre de mises
        withdrawn: f(p.cumulativeAuthorized),
        deposited: !!p.hasDeposited,
        tgId: p.tgId || null,
        total: f(p.balance.add(staked).add(pending)),
      });
    }
    rows.sort((a, b) => parseFloat(b.wagered) - parseFloat(a.wagered));
    return rows;
  }

  stakeInfo(addr) {
    const p = this._p(addr);
    const pending = p.stakeAccrued.add(this._pendingAll(p));
    const now = Date.now();
    let locked = BN(0), unlocked = BN(0), nextUnlock = null;
    for (const pos of p.stakes) {
      if (now >= pos.u) unlocked = unlocked.add(pos.a);
      else { locked = locked.add(pos.a); if (nextUnlock === null || pos.u < nextUnlock) nextUnlock = pos.u; }
    }
    const f = (w) => ethers.utils.formatUnits(w, cfg.DECIMALS);
    return {
      staked: f(this._stakedTotal(p)), locked: f(locked), unlocked: f(unlocked),
      pending: f(pending), aprBps: cfg.STAKE_APR_BPS,
      penaltyBps: cfg.STAKE_EARLY_PENALTY_BPS, lockDays: cfg.STAKE_LOCK_DAYS, nextUnlock,
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

  // ---- Telegram link (for the Adsgram reward postback) ----
  linkTelegram(addr, tgId) {
    if (!tgId) return;
    tgId = String(tgId);
    const p = this._p(addr);
    p.tgId = tgId;
    this.telegramMap.set(tgId, addr.toLowerCase());
  }

  // ---- New-player welcome bonus (granted once, on first authenticated login) ----
  /** Grant the demo credit exactly once. Returns the granted amount (0 if already given). */
  grantWelcome(addr) {
    const p = this._p(addr);
    if (p.welcomeGranted) return 0;
    p.welcomeGranted = true;
    if (cfg.WELCOME_BONUS > 0) { p.balance = p.balance.add(WEI(cfg.WELCOME_BONUS)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(cfg.WELCOME_BONUS)); }
    return cfg.WELCOME_BONUS;
  }

  /** Claim the extra welcome reward — allowed only after the player has wagered. */
  claimWelcome(addr) {
    const p = this._p(addr);
    if (!p.welcomeGranted) throw new Error('welcome bonus not granted yet');
    if (!p.welcomeWagered) throw new Error('play your welcome bonus first');
    if (p.welcomeClaimed) throw new Error('welcome reward already claimed');
    p.welcomeClaimed = true;
    const r = WEI(cfg.WELCOME_CLAIM);
    p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r);
    return cfg.WELCOME_CLAIM;
  }

  // ---- 7-day login streak ----
  /** The streak day that TODAY's claim would credit (1..N), without mutating. */
  _streakToday(p) {
    const rewards = cfg.STREAK_REWARDS, N = rewards.length || 1;
    const today = this._today();
    if (p.streakLastClaimDay === today) return { day: p.streakDay, claimedToday: true };
    let day;
    if (p.streakLastClaimDay === this._dayShift(-1)) day = (p.streakDay % N) + 1; // consecutive → next (wraps N→1)
    else day = 1; // first ever, or a gap → restart
    return { day, claimedToday: false };
  }

  /** Public streak state for the UI. */
  streakState(addr) {
    const p = this._p(addr);
    const rewards = cfg.STREAK_REWARDS;
    const s = this._streakToday(p);
    return { day: s.day, claimedToday: s.claimedToday, rewards,
             todayReward: rewards[(s.day - 1) % rewards.length] || 0,
             claimable: !s.claimedToday };
  }

  /** Claim today's streak reward (once per UTC day). Returns { day, reward }. */
  claimStreak(addr) {
    const p = this._p(addr);
    const s = this._streakToday(p);
    if (s.claimedToday) throw new Error('streak already claimed today');
    const reward = cfg.STREAK_REWARDS[(s.day - 1) % cfg.STREAK_REWARDS.length] || 0;
    p.streakDay = s.day;
    p.streakLastClaimDay = this._today();
    if (reward > 0) { const r = WEI(reward); p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r); }
    return { day: s.day, reward };
  }

  /** Combined welcome + streak state for the client. */
  bonusState(addr) {
    const p = this._p(addr);
    return {
      welcome: { granted: !!p.welcomeGranted, wagered: !!p.welcomeWagered, claimed: !!p.welcomeClaimed,
                 amount: cfg.WELCOME_BONUS, reward: cfg.WELCOME_CLAIM,
                 claimable: !!p.welcomeGranted && !!p.welcomeWagered && !p.welcomeClaimed },
      streak: this.streakState(addr),
      ad: this.adState(addr),
    };
  }

  // ---- Rewarded video ads (Adsgram) ----
  _adBump(p) { const t = this._today(); if (p.adDayKey !== t) { p.adDayKey = t; p.adCount = 0; } }
  /** How many ad rewards are left today + cooldown remaining (seconds). */
  adState(addr) {
    const p = this._p(addr); this._adBump(p);
    const left = Math.max(0, cfg.AD_DAILY_CAP - (p.adCount || 0));
    const cool = Math.max(0, Math.ceil((p.adLastMs + cfg.AD_COOLDOWN_SEC * 1000 - Date.now()) / 1000));
    return { reward: cfg.AD_REWARD, dailyCap: cfg.AD_DAILY_CAP, watchedToday: p.adCount || 0, left, cooldown: cool, blockId: cfg.ADSGRAM_BLOCK_ID };
  }

  /**
   * Credit an Adsgram rewarded video, looked up by Telegram id. Enforces the
   * daily cap + cooldown so the reward postback can't be replayed for free coins.
   * Returns { ok, reward, balance, addr } or { ok:false, reason }.
   */
  grantAdReward(tgId) {
    tgId = String(tgId || '');
    const addr = this.telegramMap.get(tgId);
    if (!addr) return { ok: false, reason: 'unknown_user' };
    const p = this._p(addr); this._adBump(p);
    const now = Date.now();
    if (now < p.adLastMs + cfg.AD_COOLDOWN_SEC * 1000) return { ok: false, reason: 'cooldown', addr };
    if ((p.adCount || 0) >= cfg.AD_DAILY_CAP) return { ok: false, reason: 'daily_cap', addr };
    p.adCount = (p.adCount || 0) + 1;
    p.adLastMs = now;
    const r = WEI(cfg.AD_REWARD);
    p.balance = p.balance.add(r); this._bumpDay(p); p.dayNet = p.dayNet.add(r);
    return { ok: true, reward: cfg.AD_REWARD, balance: this.balanceStr(addr), addr };
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
            stakes: [], stakeAccrued: ethers.BigNumber.from(0), volcanoMeter: 0,
            wagered: ethers.BigNumber.from(0), betCount: 0,
            tgId: null, welcomeGranted: false, welcomeWagered: false, welcomeClaimed: false,
            streakDay: 0, streakLastClaimDay: null, adCount: 0, adDayKey: null, adLastMs: 0 };
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
    this._bumpDay(p); p.dayNet = p.dayNet.sub(COST); p.dropsToday++; this._markWager(p, COST);
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

  canSpin(addr) { return this._p(addr).balance.gte(SPIN_COST); }

  /**
   * SWOGE Smash: one spin. Deducts SPIN_COST, rolls a provably-fair multiplier
   * from cfg.SPIN_PRIZES (RTP = 50%) and credits (multiplier × SPIN_COST).
   * Fully synchronous — like drop() — so two concurrent spins can never both
   * pass the balance check (Node is single-threaded; the second sees the
   * already-deducted balance). Returns { mult, payout } or null if too poor.
   */
  spin(addr, betRaw) {
    const p = this._p(addr);
    // Mise variable (defaut : l'ancien cout fixe, pour les clients pas encore a jour)
    let bet = Math.floor(Number(betRaw));
    if (!(bet >= 1)) bet = Number(cfg.SPIN_COST || '1');
    if (bet < cfg.SMASH_MIN_BET) bet = cfg.SMASH_MIN_BET;
    if (bet > cfg.SMASH_MAX_BET) return { error: 'max bet is ' + cfg.SMASH_MAX_BET + ' $SWOGE' };
    const betWei = WEI(bet);
    if (p.balance.lt(betWei)) return null;
    p.balance = p.balance.sub(betWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(betWei); p.dropsToday++; this._markWager(p, betWei);
    const h = crypto.createHmac('sha256', this.serverSeed)
      .update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    let r = Number(BigInt('0x' + h.slice(0, 15)) % BigInt(cfg.SPIN_TOTAL));
    let mult = 0;
    for (let i = 0; i < cfg.SPIN_PRIZES.length; i++) { r -= cfg.SPIN_PRIZES[i][1]; if (r < 0) { mult = cfg.SPIN_PRIZES[i][0]; break; } }
    let payout = 0;
    if (mult > 0) {
      const pay = betWei.mul(mult);
      p.balance = p.balance.add(pay);
      this._bumpDay(p); p.dayNet = p.dayNet.add(pay); p.winsToday++;
      payout = mult * bet;
    }
    return { mult, payout, bet };
  }

  volcanoMeterOf(addr) { return this._p(addr).volcanoMeter || 0; }

  /**
   * SWOGE Spin (Volcano). One spin at `bet` $SWOGE. Deducts the bet, computes a
   * provably-fair outcome server-side (client only animates it, so wins can't be
   * faked), tracks the per-player collect meter, and credits base×bet. RTP ~70%.
   * Returns { outcome, bet, payout, balance, fairness } or { error }.
   */
  volcanoSpin(addr, bet) {
    const p = this._p(addr);
    bet = Math.floor(Number(bet));
    if (!cfg.VOLCANO_BETS.includes(bet)) throw new Error('invalid bet');
    const betWei = WEI(bet);
    if (p.balance.lt(betWei)) return { error: 'need_deposit' };
    p.balance = p.balance.sub(betWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(betWei); p.dropsToday++; this._markWager(p, betWei);
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    const out = volcano.spinAll(volcano.rngFrom(h), p.volcanoMeter || 0);
    p.volcanoMeter = out.meter;
    let payout = 0;
    if (out.totalInternal > 0) {
      const payWei = WEI(out.totalInternal * bet);
      p.balance = p.balance.add(payWei);
      this._bumpDay(p); p.dayNet = p.dayNet.add(payWei); p.winsToday++;
      payout = out.totalInternal * bet;
    }
    return { outcome: out, bet, payout, balance: this.balanceStr(addr), fairness: this.fairness(addr) };
  }

  /** Buy the bonus directly: costs bet × VOLCANO_BONUS_COST_MULT, runs a guaranteed bonus. */
  volcanoBuyBonus(addr, bet) {
    const p = this._p(addr);
    bet = Math.floor(Number(bet));
    if (!cfg.VOLCANO_BETS.includes(bet)) throw new Error('invalid bet');
    const cost = bet * cfg.VOLCANO_BONUS_COST_MULT;
    const costWei = WEI(cost);
    if (p.balance.lt(costWei)) return { error: 'need_deposit' };
    p.balance = p.balance.sub(costWei);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(costWei); p.dropsToday++; this._markWager(p, costWei);
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':' + p.nonce).digest('hex');
    p.nonce++;
    const bonus = volcano.runBonus(3, volcano.rngFrom(h));
    let payout = 0;
    if (bonus.total > 0) {
      const payWei = WEI(bonus.total * bet);
      p.balance = p.balance.add(payWei);
      this._bumpDay(p); p.dayNet = p.dayNet.add(payWei); p.winsToday++;
      payout = bonus.total * bet;
    }
    return { outcome: { bonus }, bet, cost, payout, balance: this.balanceStr(addr), fairness: this.fairness(addr) };
  }

  // ===== SWOGE Blackjack (provably-fair, infinite deck, dealer stands on 17) =====
  // rank index: 0=A, 1..8 = 2..9, 9=10, 10=J, 11=Q, 12=K
  _bjDraw(p) {
    const h = crypto.createHmac('sha256', this.serverSeed).update(p.clientSeed + ':bj:' + p.nonce).digest('hex');
    p.nonce++;
    return Number(BigInt('0x' + h.slice(0, 15)) % BigInt(13));
  }
  _bjVal(ranks) {
    let sum = 0, aces = 0;
    for (const r of ranks) { if (r === 0) { sum += 11; aces++; } else if (r >= 9) sum += 10; else sum += r + 1; }
    while (sum > 21 && aces) { sum -= 10; aces--; }
    return sum;
  }
  _bjDealerPlay(p) { while (this._bjVal(p.bj.dc) < 17) p.bj.dc.push(this._bjDraw(p)); }
  _bjPublic(p, reveal) {
    const b = p.bj, show = reveal || b.stage === 'done';
    return {
      bet: b.bet, doubled: !!b.doubled, stage: b.stage,
      player: { cards: b.pc.slice(), value: this._bjVal(b.pc) },
      dealer: { cards: show ? b.dc.slice() : [b.dc[0]], value: show ? this._bjVal(b.dc) : this._bjVal([b.dc[0]]), hidden: !show },
      canDouble: b.stage === 'player' && b.pc.length === 2 && p.balance.gte(WEI(b.bet)),
      result: b.result || null, payout: b.payout || 0,
      balance: ethers.utils.formatUnits(p.balance, cfg.DECIMALS),
      fairness: { serverSeedHash: this.serverSeedHash, nonce: p.nonce },
    };
  }
  _bjSettle(p, stake) {   // stake already deducted; credit the return
    const pv = this._bjVal(p.bj.pc), dv = this._bjVal(p.bj.dc);
    let res, credit = 0;
    if (pv > 21) res = 'bust';
    else if (dv > 21 || pv > dv) { res = 'win'; credit = stake * 2; }
    else if (pv < dv) res = 'lose';
    else { res = 'push'; credit = stake; }
    if (credit > 0) { p.balance = p.balance.add(WEI(credit)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(credit)); if (res === 'win') p.winsToday++; }
    p.bj.stage = 'done'; p.bj.result = res; p.bj.payout = credit;
  }

  bjState(addr) { const p = this._p(addr); return p.bj ? this._bjPublic(p, false) : null; }

  // ------------------------------------------------------------------ poker
  // Le poker se joue en jetons entiers sur la table (1 jeton = 1 $SWOGE). La
  // cave sort du solde a l'arrivee et y retourne au depart. Ce n'est pas une
  // mise : ce qui est reellement joue est compte main par main via pokerWager.

  /** Sort `amount` du solde pour l'emmener sur une table. */
  pokerBuyIn(addr, amountRaw) {
    const p = this._p(addr);
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) throw new Error('invalid buy-in');
    const w = WEI(amt);
    if (p.balance.lt(w)) throw new Error('not enough $SWOGE');
    p.balance = p.balance.sub(w);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(w);
    return amt;
  }

  /** Ramene des jetons de table dans le solde (depart, exclusion, tapis vide). */
  pokerCashOut(addr, amountRaw) {
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) return 0;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(amt));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(amt));
    return amt;
  }

  /** Ce qu'un joueur a reellement engage sur une main : compte comme une mise. */
  pokerWager(addr, amountRaw) {
    const amt = Math.floor(Number(amountRaw));
    if (!(amt > 0)) return;
    const p = this._p(addr);
    this._bumpDay(p); p.dropsToday++;
    this._markWager(p, WEI(amt));
  }

  /** Une main gagnee : compte pour les quetes et le classement du jour. */
  pokerWin(addr) { const p = this._p(addr); this._bumpDay(p); p.winsToday++; }

  bjBet(addr, amountRaw) {
    const p = this._p(addr);
    if (p.bj && p.bj.stage !== 'done') throw new Error('hand in progress');
    const amt = Math.floor(Number(amountRaw));
    if (!(amt >= cfg.BJ_MIN_BET)) throw new Error('bet too small');
    if (amt > cfg.BJ_MAX_BET) throw new Error('max bet is ' + cfg.BJ_MAX_BET + ' $SWOGE');
    const w = WEI(amt);
    if (p.balance.lt(w)) throw new Error('not enough $SWOGE');
    p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); p.dropsToday++; this._markWager(p, w);
    p.bj = { bet: amt, pc: [this._bjDraw(p), this._bjDraw(p)], dc: [this._bjDraw(p), this._bjDraw(p)], stage: 'player', doubled: false, result: null, payout: 0 };
    const pv = this._bjVal(p.bj.pc), dv = this._bjVal(p.bj.dc);
    if (pv === 21 || dv === 21) {
      if (pv === 21 && dv === 21) { p.bj.stage = 'done'; p.bj.result = 'push'; p.balance = p.balance.add(w); this._bumpDay(p); p.dayNet = p.dayNet.add(w); p.bj.payout = amt; }
      else if (pv === 21) { const credit = amt * 2.5; p.balance = p.balance.add(WEI(credit)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(credit)); p.winsToday++; p.bj.stage = 'done'; p.bj.result = 'blackjack'; p.bj.payout = credit; }
      else { p.bj.stage = 'done'; p.bj.result = 'dealer_blackjack'; p.bj.payout = 0; }
    }
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  bjHit(addr) {
    const p = this._p(addr);
    if (!p.bj || p.bj.stage !== 'player') throw new Error('no active hand');
    p.bj.pc.push(this._bjDraw(p));
    if (this._bjVal(p.bj.pc) > 21) this._bjSettle(p, p.bj.doubled ? p.bj.bet * 2 : p.bj.bet);
    return this._bjPublic(p, p.bj.stage === 'done');
  }

  bjStand(addr) {
    const p = this._p(addr);
    if (!p.bj || p.bj.stage !== 'player') throw new Error('no active hand');
    this._bjDealerPlay(p);
    this._bjSettle(p, p.bj.doubled ? p.bj.bet * 2 : p.bj.bet);
    return this._bjPublic(p, true);
  }

  bjDouble(addr) {
    const p = this._p(addr);
    if (!p.bj || p.bj.stage !== 'player' || p.bj.pc.length !== 2) throw new Error('cannot double now');
    const w = WEI(p.bj.bet);
    if (p.balance.lt(w)) throw new Error('not enough to double');
    p.balance = p.balance.sub(w); this._bumpDay(p); p.dayNet = p.dayNet.sub(w); this._markWager(p, w); p.bj.doubled = true;
    p.bj.pc.push(this._bjDraw(p));
    if (this._bjVal(p.bj.pc) <= 21) this._bjDealerPlay(p);
    this._bjSettle(p, p.bj.bet * 2);
    return this._bjPublic(p, true);
  }

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
