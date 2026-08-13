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
const journal = require('./journal');
const casino = require('./casino');
const hilo = require('./hilo');
const mines = require('./mines');
const plinko = require('./plinko');
const crash = require('./crash');
const p4 = require('./puissance4');
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
    /* Secret des jetons de session. Il vit avec l'etat : sans ca, chaque
       redeploiement deconnecterait tous les joueurs d'un coup. */
    this.sessionSecret = cfg.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    /* La graine de la chaine du Crash vit avec l'etat, comme le secret de
       session : la regenerer a chaque redeploiement casserait l'engagement
       publie, et donc la seule chose qui prouve aux joueurs que les manches a
       venir sont deja ecrites. */
    this.crashGraine = cfg.CRASH_GRAINE || crypto.randomBytes(32).toString('hex');
    this._rotateSeed();
    this._crashTable();
    /* Les parties de Connect 4. Elles ne sont PAS sauvegardees avec l'etat :
       une partie interrompue par un redemarrage rendrait les deux mises (voir
       _p4Rendre), parce qu'une grille a moitie jouee dont les deux joueurs ont
       ete deconnectes n'a plus d'arbitre. */
    this.p4 = new Map();
    this.p4Seq = 0;
  }

  /** (Re)construit la table du Crash a partir de la graine courante. */
  _crashTable() {
    this.crash = new crash.Table({
      graine: this.crashGraine, longueur: cfg.CRASH_CHAINE, sel: cfg.CRASH_SEL,
      edgeBps: cfg.CRASH_EDGE_BPS, plafond: cfg.CRASH_PLAFOND,
      vitesse: cfg.CRASH_VITESSE, attenteMs: cfg.CRASH_ATTENTE_MS,
      apresMs: cfg.CRASH_APRES_MS,
    });
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
        vi: p.visage || null, am: p.amis || [],
        stk: p.stakes.map((x) => [x.a.toString(), x.s, x.u]), sa: p.stakeAccrued.toString(),
        tw: (p.wagered || ethers.BigNumber.from(0)).toString(), bc: p.betCount || 0,
        dp: (p.deposited || ethers.BigNumber.from(0)).toString(), jx: p.jeux || {},
        bj: p.bj || null, vm: p.volcanoMeter || 0,
        tg: p.tgId || null,
        wg: !!p.welcomeGranted, ww: !!p.welcomeWagered, wc: !!p.welcomeClaimed,
        sd: p.streakDay || 0, sl: p.streakLastClaimDay || null,
        ac: p.adCount || 0, ak: p.adDayKey || null, al: p.adLastMs || 0,
      }]);
    }
    return { v: 1, serverSeed: this.serverSeed, sessionSecret: this.sessionSecret,
             jackpotPot: this.jackpotPot.toString(),
             crashGraine: this.crashGraine, crash: this.crash.sauve(),
             lastBlock: this.lastBlock, seenTx: Array.from(this.seenTx), players,
             telegramMap: Array.from(this.telegramMap) };
  }

  /** Restore a snapshot produced by serialize() (called once at startup). */
  hydrate(st) {
    if (!st) return;
    /* Le secret fixe par l'environnement l'emporte : c'est ainsi qu'on revoque
       toutes les sessions d'un coup, en le changeant sur le serveur. */
    if (st.sessionSecret && !cfg.SESSION_SECRET) this.sessionSecret = st.sessionSecret;
    if (st.serverSeed) { this.serverSeed = st.serverSeed; this.serverSeedHash = crypto.createHash('sha256').update(st.serverSeed).digest('hex'); }
    if (st.jackpotPot) this.jackpotPot = ethers.BigNumber.from(st.jackpotPot);
    /* La graine d'environnement l'emporte, comme pour le secret de session :
       c'est ainsi qu'on repart sur une chaine neuve volontairement. Sinon on
       reprend celle de l'etat, et l'index sauve evite de rejouer un maillon
       deja consomme — le meme maillon deux fois, ce serait la meme manche. */
    if (st.crashGraine && !cfg.CRASH_GRAINE) { this.crashGraine = st.crashGraine; this._crashTable(); }
    if (st.crash) this.crash.charge(st.crash);
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
        visage: d.vi || null, amis: Array.isArray(d.am) ? d.am : [],
        stakes: Array.isArray(d.stk)
          ? d.stk.map((x) => ({ a: ethers.BigNumber.from(x[0]), s: x[1], u: x[2] }))
          : (d.st && d.st !== '0' // migrate old single-stake format → one locked position
              ? [{ a: ethers.BigNumber.from(d.st), s: d.ss || Date.now(), u: (d.ss || Date.now()) + cfg.STAKE_LOCK_DAYS * 86400000 }]
              : []),
        stakeAccrued: ethers.BigNumber.from(d.sa || '0'),
        wagered: ethers.BigNumber.from(d.tw || '0'), betCount: d.bc || 0,
        deposited: ethers.BigNumber.from(d.dp || '0'), jeux: d.jx || {},
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
    /* Le compteur AVANT le tirage. C'est le seul endroit traverse par tous les
       jeux au moment ou la mise part, donc avant qu'aucune carte ne soit
       tiree : en le notant ici et en relisant le compteur a la fin de la
       manche, on obtient la PLAGE exacte de numeros utilises. Noter seulement
       le compteur final serait faux des qu'un jeu tire plusieurs fois — au
       blackjack, une main en consomme une dizaine. */
    p.nonceDebut = p.nonce;
    if (!p.welcomeWagered) p.welcomeWagered = true;
    if (wei) { p.wagered = (p.wagered || BN(0)).add(wei); p.betCount = (p.betCount || 0) + 1; }
  }
  /**
   * Comptabilite PAR JEU. Le serveur ne retenait qu'un total de mises, tous
   * jeux confondus : impossible de dire si un joueur gagne anormalement
   * quelque part, ni meme a quoi il joue. On enregistre une manche a la fois,
   * au moment ou elle se conclut.
   *
   * `mise` et `rendu` sont des NOMBRES, pas des wei : ce sont des chiffres
   * d'affichage, jamais des soldes, et personne ne paie avec.
   */
  _manche(p, jeu, mise, rendu) {
    if (!p || !jeu) return;
    /* Le seul point de passage de TOUTES les manches, tous jeux confondus :
       c'est donc ici que le journal se remplit, et nulle part ailleurs. Un
       nouveau jeu qui appelle _manche est journalise sans rien avoir a
       ajouter — et un jeu qui oublierait de l'appeler ne compterait deja pas
       dans les statistiques, ce qui se voit. */
    if (p.addr) journal.ajoute(p.addr, { k: 'r', g: jeu, m: Number(mise) || 0, p: Number(rendu) || 0,
      /* De quoi refaire le calcul soi-meme, une fois la graine du serveur
         revelee : son empreinte, la graine du joueur, et les numeros utilises
         par cette manche. */
      sh: this.serverSeedHash, cs: p.clientSeed,
      n0: p.nonceDebut == null ? p.nonce : p.nonceDebut, n1: p.nonce });
    if (!p.jeux) p.jeux = {};
    const j = p.jeux[jeu] || (p.jeux[jeu] = { n: 0, mise: 0, rendu: 0, gagne: 0, nul: 0 });
    j.n++;
    j.mise += Number(mise) || 0;
    j.rendu += Number(rendu) || 0;
    if (rendu > mise) j.gagne++;
    else if (rendu === mise) j.nul++;
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
    journal.ajoute(addr, { k: 'st', s: 'stake', m: ethers.utils.formatUnits(amount, cfg.DECIMALS),
                           total: ethers.utils.formatUnits(this._stakedTotal(p), cfg.DECIMALS) });
  }

  claimStake(addr) {
    const p = this._p(addr);
    this._settleStakes(p);
    const reward = p.stakeAccrued;
    if (reward.lte(0)) throw new Error('no yield to claim yet');
    p.stakeAccrued = BN(0);
    p.balance = p.balance.add(reward);
    const r = ethers.utils.formatUnits(reward, cfg.DECIMALS);
    journal.ajoute(addr, { k: 'st', s: 'claim', m: r,
                           total: ethers.utils.formatUnits(this._stakedTotal(p), cfg.DECIMALS) });
    return r;
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
    /* La PENALITE est journalisee separement de ce qui revient : c'est
       exactement le chiffre qu'un joueur conteste six mois plus tard, et
       « rendu 500 » sans « penalite 500 » ne permet pas de lui repondre. */
    journal.ajoute(addr, { k: 'st', s: 'unstake', m: f(returned),
                           pen: f(penalty), yld: f(yld), total: '0' });
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
        visage: p.visage || null,          // le visage fait partie de l'identite affichee
        amis: (p.amis || []).length,
        balance: f(p.balance),
        staked: f(staked),
        pending: f(pending),
        wagered: f(p.wagered),                     // total joue a vie
        bets: p.betCount || 0,                     // nombre de mises
        withdrawn: f(p.cumulativeAuthorized),
        deposited: !!p.hasDeposited,
        depositedAmount: f(p.deposited),
        /* Le seul chiffre qui repond a « d'ou vient cet argent ? » :
           ce qu'il detient, plus ce qu'il a sorti, moins ce qu'il a mis.
           Un joueur normal est LEGEREMENT NEGATIF — c'est l'avantage de la
           maison. Fortement positif sans mise correspondante, c'est une entree
           d'argent qui ne vient pas du jeu. */
        net: f(p.balance.add(staked).add(pending).add(p.cumulativeAuthorized)
                .sub(p.deposited || BN(0))),
        jeux: p.jeux || {},
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

  // ---- 7-day login ladder ----
  /**
   * Le palier que la reclamation d'AUJOURD'HUI crediterait (1..N), sans rien
   * modifier.
   *
   * UN TROU NE REMET PLUS A ZERO. Avant, rater une journee renvoyait le joueur
   * au palier 1 : il revenait le surlendemain, voyait « Claim day 1 » a la
   * place de « day 2 » et concluait, a raison, que la reclamation ne marchait
   * pas. Une echelle qui punit l'absence punit surtout ceux qui reviennent.
   * On avance donc d'un palier a chaque journee reclamee, quel que soit
   * l'ecart ; la seule regle qui reste est UNE reclamation par journee.
   */
  _streakToday(p) {
    const rewards = cfg.STREAK_REWARDS, N = rewards.length || 1;
    if (p.streakLastClaimDay === this._today()) return { day: p.streakDay, claimedToday: true };
    // jamais rien reclame -> palier 1 ; sinon le suivant, qui reboucle N -> 1
    const day = p.streakLastClaimDay ? (p.streakDay % N) + 1 : 1;
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
    /* La fiche porte son adresse. Sans elle, tout code qui ne recoit que la
       fiche — _manche, appele par les dix-neuf fins de manche — ne sait pas de
       QUI il parle, et ne peut donc rien journaliser. Elle est reposee aussi
       pour les fiches relues du disque, qui datent d'avant. */
    if (p && !p.addr) p.addr = addr;
    if (!p) {
      p = { addr, balance: ethers.BigNumber.from(0), cumulativeAuthorized: ethers.BigNumber.from(0),
            clientSeed: crypto.randomBytes(8).toString('hex'), nonce: 0, name: addr.slice(0, 6),
            deposited: BN(0), jeux: {}, visage: null, amis: [],
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

  /* Les vingt-quatre visages proposes. Une LISTE FERMEE, et pas une chaine
     libre : ce nom et cette image s'affichent chez les AUTRES joueurs, au
     poker, au Crash, au Connect 4. Laisser passer n'importe quel texte, c'est
     laisser un joueur en coller un autre dans le HTML de la table. */
  /** La forme comparable d'un nom : sans casse et sans accents. */
  static cleNom(n) {
    return String(n || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  }

  static get VISAGES() {
    return ['🐕','🦴','💪','🔥','👑','💎','🚀','🎯','🍀','⚡','🌊','🐉',
            '🦈','🐺','🦊','🐼','🎰','🃏','🎲','⚔️','🛡️','🏆','💰','🥇'];
  }

  /**
   * Le nom public d'un joueur, tel qu'il choisit de le porter.
   *
   * Les espaces de bout sont retires — c'est une faute de frappe, pas une
   * intention. Tout le reste est REFUSE plutot que corrige en silence : un
   * joueur qui tape un nom pris, trop court ou plein de balises doit
   * l'apprendre, pas se retrouver affiche sous autre chose.
   */
  setPublicName(addr, nom) {
    const n = String(nom == null ? '' : nom).trim();
    if (n.length < 3) throw new Error('name must be at least 3 characters');
    if (n.length > 18) throw new Error('name must be 18 characters at most');
    /* Lettres, chiffres, espace, tiret, souligne et point. Rien d'autre : ce
       nom part dans le HTML des tables des autres joueurs. */
    if (!/^[\p{L}\p{N} ._-]+$/u.test(n)) throw new Error('letters, digits, space, . _ - only');
    if (/^\s|\s$|\s{2,}/.test(n)) throw new Error('no double or trailing spaces');
    /* La cle d'unicite ignore la casse ET les accents : « Eliott » et
       « Éliott » se ressemblent assez a l'ecran d'une table pour qu'on prenne
       l'un pour l'autre, et se faire passer pour un autre joueur est
       precisement ce qu'un nom public ne doit pas permettre. */
    const cle = Game.cleNom(n);
    for (const [a, p] of this.players)
      if (a !== String(addr).toLowerCase() && Game.cleNom(p.name || '') === cle)
        throw new Error('that name is taken');
    this._p(addr).name = n;
    return n;
  }

  /** Le visage, choisi dans la liste fermee. */
  setVisage(addr, v) {
    const liste = Game.VISAGES;
    const s = String(v == null ? '' : v);
    if (liste.indexOf(s) < 0) throw new Error('unknown avatar');
    this._p(addr).visage = s;
    return s;
  }

  /** Ce que les autres joueurs voient d'un joueur. */
  profilPublic(addr) {
    const p = this._p(addr);
    return { address: String(addr).toLowerCase(), name: p.name, visage: p.visage || null };
  }
  /**
   * Graine du joueur. Le DEUX-POINTS est interdit, et ce n'est pas cosmetique.
   *
   * Chaque jeu fabrique son message en collant des morceaux avec ce separateur :
   * la machine a sous utilise `graine:numero`, le blackjack `graine:bj:numero`,
   * les autres `graine:casino`, `graine:hilo`, `graine:mines`, `graine:plinko`.
   * Un joueur qui choisissait la graine « X:bj » obtenait pour la machine a
   * sous le message « X:bj:12 » — exactement celui du blackjack pour la graine
   * « X ». Deux jeux differents partageaient alors le meme tirage, et le
   * cloisonnement sur lequel repose toute l'equite tombait.
   *
   * En retirant le separateur de ce que le joueur controle, aucune graine ne
   * peut plus se faire passer pour un autre jeu.
   */
  setClientSeed(addr, seed) {
    const p = this._p(addr);
    const propre = String(seed || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (propre) p.clientSeed = propre;
    return p.clientSeed;
  }

  balanceWei(addr) { return this._p(addr).balance; }
  balanceStr(addr) { return ethers.utils.formatUnits(this._p(addr).balance, cfg.DECIMALS); }

  /** Credit an on-chain deposit once (deduped by tx hash). */
  creditDeposit({ player, amount, tx }) {
    if (this.seenTx.has(tx)) return false;
    this.seenTx.add(tx);
    const p = this._p(player);
    p.balance = p.balance.add(amount);
    p.hasDeposited = true; // unlocks daily quests (real skin in the game)
    /* Le TOTAL depose, et pas seulement un oui/non. Sans lui il est impossible
       de dire si un gros solde vient d'un gros depot ou de nulle part — c'est
       exactement la question qu'on n'a pas su trancher le jour ou un joueur a
       ete soupconne de tricher. */
    p.deposited = (p.deposited || BN(0)).add(amount);
    /* L'adresse ET la transaction. Le joueur qui conteste un depot six mois
       plus tard ne se souvient pas d'un montant : il se souvient d'un
       virement, et c'est le hash qui permet d'aller le regarder sur la
       chaine. L'adresse de depart est la sienne — le coffre credite celui qui
       a envoye — mais l'ecrire noir sur blanc evite d'avoir a le supposer. */
    journal.ajoute(player, { k: 'dep', m: ethers.utils.formatUnits(amount, cfg.DECIMALS),
                             tx, from: String(player).toLowerCase() });
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
    this._manche(p, 'smash', bet, payout);
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
    this._manche(p, 'spin', bet, payout);
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
    this._manche(p, 'spinBonus', cost, payout);
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
    this._manche(p, 'bj', stake, credit);
  }

  bjState(addr) { const p = this._p(addr); return p.bj ? this._bjPublic(p, false) : null; }

  // ----------------------------------------------------------------- casino
  // Deux jeux contre la banque : Casino Hold'em et Three Card. Toute la logique
  // de gain vit dans casino.js, teste hors ligne ; ici on ne fait que debiter,
  // garder l'etat entre la donne et la decision, puis crediter.

  /** Vue publique : jamais les cartes du croupier avant la decision. */
  _casinoPublic(p, fini) {
    const s = p.casino;
    if (!s) return null;
    const v = {
      game: s.game, stage: fini ? 'done' : s.stage,
      ante: s.ante, side: s.side,
      player: s.player.slice(),
      board: s.board ? s.board.slice() : [],
      result: null,
    };
    if (fini && s.result) {
      v.dealer = s.result.dealer ? s.result.dealer.slice() : (s.dealer || []).slice();
      v.board = (s.result.board || s.board || []).slice();
      const engage = s.game === 'holdem'
        ? s.ante * (s.called ? 3 : 1) + s.side
        : s.ante * (s.called ? 2 : 1) + s.side;
      v.result = {
        outcome: s.result.outcome, payout: s.result.payout, detail: s.result.detail,
        fee: s.result.fee || 0, staked: engage, net: s.result.payout - engage,
        playerHand: s.result.playerHand || null, dealerHand: s.result.dealerHand || null,
      };
    }
    return v;
  }

  casinoState(addr) { const p = this._p(addr); return p.casino ? this._casinoPublic(p, p.casino.stage === 'done') : null; }

  /**
   * Distribue une main. `side` est le Pair Plus (Three Card) ou le bonus AA
   * (Hold'em). Les mises partent tout de suite : rien ne doit pouvoir etre
   * distribue sans que le solde ait deja ete debite.
   */
  casinoDeal(addr, gameId, anteRaw, sideRaw) {
    const p = this._p(addr);
    if (p.casino && p.casino.stage !== 'done') throw new Error('hand in progress');
    if (gameId !== 'holdem' && gameId !== 'three') throw new Error('unknown game');

    const ante = Math.floor(Number(anteRaw));
    const side = Math.max(0, Math.floor(Number(sideRaw) || 0));
    if (!(ante >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (ante > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (side > cfg.CASINO_MAX_BET) throw new Error('side bet too large');

    // Hold'em : suivre coute 2x l'Ante, on exige donc 3x l'Ante des le depart,
    // sinon le joueur decouvre son flop sans pouvoir payer la suite.
    const requis = ante * (gameId === 'holdem' ? 3 : 2) + side;
    if (p.balance.lt(WEI(requis))) throw new Error('not enough $SWOGE to see the hand through');

    const debit = WEI(ante + side);
    p.balance = p.balance.sub(debit);
    this._bumpDay(p); p.dayNet = p.dayNet.sub(debit); p.dropsToday++; this._markWager(p, debit);

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':casino', nonce: p.nonce };

    if (gameId === 'three') {
      const d = casino.shoe(graine.serverSeed, graine.clientSeed, graine.nonce);
      p.casino = { game: 'three', stage: 'decide', ante, side, graine,
                   player: [d[0], d[1], d[2]], dealer: [d[3], d[4], d[5]], board: [] };
    } else {
      const deal = casino.holdemDeal(graine);
      p.casino = { game: 'holdem', stage: 'decide', ante, side, graine, deal,
                   player: deal.player, dealer: deal.dealer, board: deal.board };
    }
    return this._casinoPublic(p, false);
  }

  /** Suivre ou se coucher. Credite le gain et referme la main. */
  casinoDecide(addr, suit) {
    const p = this._p(addr);
    const s = p.casino;
    if (!s || s.stage !== 'decide') throw new Error('no hand to decide');

    // Suivre engage une mise supplementaire : elle doit etre debitee AVANT que
    // le resultat soit connu, sinon un joueur a sec pourrait suivre gratuitement.
    let extra = 0;
    if (suit) extra = s.game === 'holdem' ? s.ante * 2 : s.ante;
    if (extra > 0) {
      if (p.balance.lt(WEI(extra))) throw new Error('not enough $SWOGE to call');
      p.balance = p.balance.sub(WEI(extra));
      this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(extra)); this._markWager(p, WEI(extra));
    }

    const feeBps = cfg.CASINO_WIN_FEE_BPS;
    const r = s.game === 'three'
      ? casino.threeCard(Object.assign({}, s.graine, { ante: s.ante, pairPlus: s.side, play: !!suit, feeBps }))
      : casino.holdemResolve({ deal: s.deal, ante: s.ante, aa: s.side, call: !!suit, feeBps });

    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.outcome === 'win' || r.outcome === 'dealer_not_qualified') p.winsToday++;
    }
    s.result = r; s.stage = 'done'; s.called = !!suit;
    const vue = this._casinoPublic(p, true);
    this._manche(p, s.game, vue.result.staked, r.payout);
    return vue;
  }

  // ------------------------------------------------------------------ hi-lo
  // Plus haut ou plus bas. La mise part au premier tirage ; a partir de la, le
  // joueur ne risque plus que ce qu'il a deja engage. Tout le calcul vit dans
  // hilo.js, teste hors ligne.

  _hiloPublic(p) {
    const s = p.hilo;
    if (!s) return null;
    const e = s.etat;
    return {
      mise: e.mise, carte: e.carte, rang: e.rang, pas: e.pas,
      multi: e.multi, fini: !!e.fini, perdu: !!e.perdu, encaisse: !!e.encaisse,
      peutMonter: !!e.peutMonter, peutDescendre: !!e.peutDescendre,
      // ce que rapporterait chaque pari, pour l'afficher AVANT de cliquer
      multHigher: e.peutMonter ? hilo.multiplicateur(e.rang, 'higher', cfg.HILO_EDGE_BPS) : 0,
      multLower: e.peutDescendre ? hilo.multiplicateur(e.rang, 'lower', cfg.HILO_EDGE_BPS) : 0,
      gain: Math.floor(e.mise * e.multi),
      dernier: s.dernier || null,
    };
  }

  hiloState(addr) { const p = this._p(addr); return this._hiloPublic(p); }

  /** Ouvre une partie : la mise est debitee tout de suite. */
  hiloStart(addr, miseRaw) {
    const p = this._p(addr);
    if (p.hilo && !p.hilo.etat.fini) throw new Error('game in progress');

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise));

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':hilo', nonce: p.nonce };
    p.hilo = { graine, etat: hilo.ouvrir(Object.assign({ mise }, graine)), dernier: null };
    return this._hiloPublic(p);
  }

  /** Un pas : plus haut ou plus bas. Rien n'est debite, la mise est deja partie. */
  hiloStep(addr, sens) {
    const p = this._p(addr);
    const s = p.hilo;
    if (!s || s.etat.fini) throw new Error('no game in progress');
    const avant = s.etat.carte;
    const r = hilo.jouer(Object.assign({ etat: s.etat, sens, edgeBps: cfg.HILO_EDGE_BPS }, s.graine));
    s.etat = r.etat;
    s.dernier = { sens, avant, carte: r.carte, gagne: r.gagne,
                  egalites: r.egalites, mult: r.multiplicateurDuPas };
    // une partie perdue se conclut ICI, pas a l'encaissement : sans ca on ne
    // compterait que les parties gagnantes et le taux serait de 100 %
    if (s.etat.fini && s.etat.perdu) this._manche(p, 'hilo', s.etat.mise, 0);
    return this._hiloPublic(p);
  }

  /** Encaisse le multiplicateur courant. */
  hiloCashOut(addr) {
    const p = this._p(addr);
    const s = p.hilo;
    if (!s || s.etat.fini) throw new Error('no game to cash out');
    const r = hilo.encaisser(s.etat);
    s.etat = r.etat;
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    const v = this._hiloPublic(p);
    v.payout = r.payout; v.net = r.net;
    this._manche(p, 'hilo', v.mise, r.payout);
    return v;
  }

  // ------------------------------------------------------------------ mines
  // Une grille de 25 cases, des bombes placees a l'ouverture. Tout le calcul
  // vit dans mines.js, verifie hors ligne.

  /**
   * Vue publique. Les bombes ne sortent QUE lorsque la partie est finie : les
   * envoyer plus tot reviendrait a donner la solution, et aucun affichage cote
   * navigateur ne peut cacher une donnee qu'on lui a transmise.
   */
  _minesPublic(p) {
    const s = p.mines;
    if (!s) return null;
    const e = s.etat;
    const v = {
      mise: e.mise, nbMines: e.nbMines,
      ouvertes: e.ouvertes.slice(),
      multi: e.multi,
      fini: !!e.fini, perdu: !!e.perdu, encaisse: !!e.encaisse, complet: !!e.complet,
      // ce que rapporterait la case suivante, pour l'afficher AVANT de cliquer
      multiSuivant: e.fini ? 0
        : mines.multiplicateur(e.nbMines, e.ouvertes.length + 1, e.edgeBps),
      gain: Math.floor(e.mise * e.multi),
      maximum: mines.maximum(e.nbMines, e.edgeBps),
    };
    if (e.fini) {
      v.bombes = e.bombes.slice();          // la grille se decouvre a la fin
      if (e.touchee != null) v.touchee = e.touchee;
    }
    return v;
  }

  minesState(addr) { const p = this._p(addr); return this._minesPublic(p); }

  /**
   * Multiplicateur de la PREMIERE case pour chaque nombre de bombes propose.
   * Calcule ici, et envoye au navigateur, pour qu'il n'ait aucune formule a
   * lui : deux sources de verite finissent toujours par diverger, et c'est
   * l'affichage qui aurait tort au pire moment — juste avant de miser.
   */
  minesBareme() {
    const out = {};
    for (const m of cfg.MINES_CHOIX) out[m] = mines.multiplicateur(m, 1, cfg.MINES_EDGE_BPS);
    return out;
  }

  /** Ouvre une partie : la mise est debitee tout de suite. */
  minesStart(addr, miseRaw, nbMinesRaw) {
    const p = this._p(addr);
    if (p.mines && !p.mines.etat.fini) throw new Error('game in progress');

    /* Pas de Math.floor ici, contrairement a la mise : le nombre de bombes est
       un choix pris dans une liste, pas un montant. Recevoir 2,5 veut dire que
       le client s'est trompe — l'arrondir en silence masquerait sa faute et
       ferait jouer une grille que personne n'a demandee. */
    const nbMines = Number(nbMinesRaw);
    if (!Number.isInteger(nbMines) || nbMines < mines.MINES_MIN || nbMines > mines.MINES_MAX)
      throw new Error('mines must be a whole number between ' + mines.MINES_MIN + ' and ' + mines.MINES_MAX);

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise));

    p.nonce++;
    const graine = { serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':mines', nonce: p.nonce };
    p.mines = { graine, etat: mines.ouvrir(Object.assign({ mise, nbMines, edgeBps: cfg.MINES_EDGE_BPS }, graine)) };
    return this._minesPublic(p);
  }

  /** Retourne une case. Rien n'est debite : la mise est deja partie. */
  minesPick(addr, position) {
    const p = this._p(addr);
    const s = p.mines;
    if (!s || s.etat.fini) throw new Error('no game in progress');
    const r = mines.jouer({ etat: s.etat, position });
    s.etat = r.etat;
    if (s.etat.fini && s.etat.perdu) this._manche(p, 'mines', s.etat.mise, 0);
    const v = this._minesPublic(p);
    v.dernier = { position: r.position, sure: r.sure };
    return v;
  }

  /** Encaisse le multiplicateur courant. */
  minesCashOut(addr) {
    const p = this._p(addr);
    const s = p.mines;
    if (!s || s.etat.encaisse || s.etat.perdu) throw new Error('no game to cash out');
    const r = mines.encaisser(s.etat);
    s.etat = r.etat;
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    const v = this._minesPublic(p);
    v.payout = r.payout; v.net = r.net;
    this._manche(p, 'mines', v.mise, r.payout);
    return v;
  }

  // ----------------------------------------------------------------- plinko
  // Une bille, un coup. Rien a conserver entre deux messages : il n'y a donc
  // aucun etat qu'un joueur puisse abandonner en cours de route pour garder sa
  // mise, contrairement au Hi-Lo et au Mines.

  /** Le bareme complet, pour que le navigateur affiche les godets sans calculer. */
  plinkoTable(rangees, risque) {
    return plinko.table(rangees, risque, cfg.PLINKO_EDGE_BPS);
  }

  /** Toutes les tables d'un coup : envoyees a la connexion, jamais recalculees. */
  plinkoBaremes() {
    const out = {};
    for (const r of plinko.RANGEES)
      for (const q of plinko.RISQUES) out[r + ':' + q] = this.plinkoTable(r, q);
    return out;
  }

  /** Lache une bille. La mise part et le gain revient dans le meme geste. */
  plinkoDrop(addr, miseRaw, rangeesRaw, risqueRaw) {
    const p = this._p(addr);

    const rangees = Number(rangeesRaw);
    if (!Number.isInteger(rangees) || plinko.RANGEES.indexOf(rangees) < 0)
      throw new Error('rows must be one of ' + plinko.RANGEES.join(', '));
    const risque = String(risqueRaw || '');
    if (plinko.RISQUES.indexOf(risque) < 0)
      throw new Error('risk must be one of ' + plinko.RISQUES.join(', '));

    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++; this._markWager(p, WEI(mise));

    p.nonce++;
    const r = plinko.lancer({
      serverSeed: this.serverSeed, clientSeed: p.clientSeed + ':plinko', nonce: p.nonce,
      mise, rangees, risque, edgeBps: cfg.PLINKO_EDGE_BPS,
    });
    if (r.payout > 0) {
      p.balance = p.balance.add(WEI(r.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(r.payout));
      if (r.net > 0) p.winsToday++;
    }
    this._manche(p, 'plinko', r.mise, r.payout);
    return { mise: r.mise, rangees: r.rangees, risque: r.risque,
             chemin: r.chemin, case: r.case, multi: r.multi,
             payout: r.payout, net: r.net, table: r.table };
  }

  // ------------------------------------------------------------------ crash
  // Une seule manche pour tout le monde. Contrairement au Plinko, la mise part
  // AVANT de savoir quoi que ce soit, et le gain revient plus tard — au retrait,
  // ou jamais. Le solde suit donc deux chemins separes : le debit a la mise, le
  // credit a l'encaissement.

  /** L'etat de la table pour un joueur donne, avec son propre pari. */
  crashEtat(now, addr) {
    const e = this.crash.etat(now || Date.now());
    e.edgeBps = cfg.CRASH_EDGE_BPS;
    e.min = cfg.CASINO_MIN_BET;
    e.max = cfg.CASINO_MAX_BET;
    e.joueurs = this._crashNoms(e.joueurs);
    if (addr) e.moi = this.crash.pari(addr);
    return e;
  }

  /**
   * La table du Crash ne connait que des adresses — c'est voulu, elle ignore
   * tout des joueurs. Mais une liste de 0x25…47f ne dit rien a personne : on y
   * remet les noms au moment de sortir, la ou ils sont connus.
   */
  _crashNoms(liste) {
    return (liste || []).map((j) => Object.assign({ name: this._p(j.addr).name }, j));
  }

  /**
   * Poser une mise sur la manche en cours. La mise est debitee tout de suite :
   * un solde qui ne bougerait qu'au crash laisserait le joueur miser deux fois
   * le meme jeton sur deux onglets.
   */
  crashMise(addr, miseRaw, autoRaw, now) {
    const p = this._p(addr);
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.CASINO_MIN_BET)) throw new Error('bet too small');
    if (mise > cfg.CASINO_MAX_BET) throw new Error('max bet is ' + cfg.CASINO_MAX_BET + ' $SWOGE');
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');

    // parier() est ce qui peut encore refuser (mises fermees, deja en table) :
    // on l'appelle AVANT de toucher au solde, pour n'avoir rien a annuler.
    const r = this.crash.parier(addr, mise, autoRaw, now || Date.now());

    p.balance = p.balance.sub(WEI(mise));
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise));
    p.dropsToday++; this._markWager(p, WEI(mise));
    return { manche: r.manche, mise, auto: r.auto, balance: this.balanceStr(addr) };
  }

  /** Encaisser a la main. Le multiplicateur vient de l'horloge du serveur. */
  crashRetrait(addr, now) {
    const ev = this.crash.retirer(addr, now || Date.now());
    this._crediteRetrait(ev);
    return ev;
  }

  /** Le credit d'un encaissement, manuel ou automatique — un seul chemin. */
  _crediteRetrait(ev) {
    const p = this._p(ev.addr);
    if (ev.payout > 0) {
      p.balance = p.balance.add(WEI(ev.payout));
      this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(ev.payout));
      if (ev.net > 0) p.winsToday++;
    }
    this._manche(p, 'crash', ev.mise, ev.payout);
    ev.balance = this.balanceStr(ev.addr);
    return ev;
  }

  /**
   * Fait avancer la manche. Renvoie les evenements a diffuser tels quels ;
   * les soldes, eux, sont deja a jour quand la fonction rend la main.
   */
  crashTick(now) {
    const evs = this.crash.tick(now || Date.now());
    for (const ev of evs) {
      if (ev.type === 'crashDepart') ev.joueurs = this._crashNoms(ev.joueurs);
      else if (ev.type === 'crashRetrait') this._crediteRetrait(ev);
      else if (ev.type === 'crashFin') {
        // Les perdants ont ete debites a la mise : il ne reste qu'a inscrire la
        // manche a leur compteur, pour que la comptabilite par jeu soit juste.
        // La table garde les paris jusqu'a l'ouverture de la manche suivante :
        // la mise perdue est donc encore lisible ici, et nulle part apres.
        for (const addr of ev.perdants) {
          const pari = this.crash.pari(addr);
          this._manche(this._p(addr), 'crash', pari ? pari.mise : 0, 0);
        }
      }
    }
    return evs;
  }


  // ------------------------------------------------------------ connect 4
  // Un contre un. La mise part a la creation ou a l'entree, et ne revient
  // qu'a la fin : c'est ce qui garantit qu'un joueur ne peut pas s'engager
  // sur une table avec un solde qu'il aura depense ailleurs entre-temps.

  _p4Verifie(miseRaw, addr) {
    const mise = Math.floor(Number(miseRaw));
    if (!(mise >= cfg.P4_MIN)) throw new Error('minimum bet is ' + cfg.P4_MIN + ' $SWOGE');
    if (mise > cfg.P4_MAX) throw new Error('maximum bet is ' + cfg.P4_MAX + ' $SWOGE');
    const p = this._p(addr);
    if (p.balance.lt(WEI(mise))) throw new Error('not enough $SWOGE');
    return mise;
  }

  _p4Debite(addr, mise) {
    const p = this._p(addr);
    p.balance = p.balance.sub(WEI(mise));
    // dropsToday compte pour les quetes du jour. Tous les autres jeux
    // l'incrementent a la mise ; le Connect 4 l'avait oublie, et une partie
    // ne faisait donc avancer aucune quete.
    this._bumpDay(p); p.dayNet = p.dayNet.sub(WEI(mise)); p.dropsToday++;
    this._markWager(p, WEI(mise));
  }

  _p4Credite(addr, montant) {
    if (!(montant > 0)) return;
    const p = this._p(addr);
    p.balance = p.balance.add(WEI(montant));
    this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(montant));
  }

  /** Ouvre une table et attend un adversaire. */
  p4Creer(addr, miseRaw, now) {
    const mise = this._p4Verifie(miseRaw, addr);
    for (const m of this.p4.values())
      if (m.phase !== p4.FINIE && m.jeton(addr)) throw new Error('you already have a match running');
    const id = 'p4' + (++this.p4Seq) + '-' + Math.floor((now || Date.now()) / 1000).toString(36);
    const partie = new p4.Partie({ id, mise, createur: addr, now: now || Date.now(),
                                   coupMs: cfg.P4_COUP_MS });
    this._p4Debite(addr, mise);
    this.p4.set(id, partie);
    return partie;
  }

  /** S'asseoir en face. La partie demarre a cet instant. */
  p4Rejoindre(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    /* Sa propre table AVANT le controle general : un joueur qui clique sur sa
       propre partie a besoin d'entendre « c'est la tienne », pas « tu as deja
       une partie en cours » — qui est vrai mais n'explique rien. */
    if (partie.joueurs[0] === addr) throw new Error('you cannot join your own match');
    if (partie.reserve && partie.reserve !== addr)
      throw new Error('this rematch is reserved for another player');
    const mise = this._p4Verifie(partie.mise, addr);
    /* On ne tient qu'une partie a la fois — mais une table a soi qui attend
       encore n'est pas une partie : on la retire et on rend la mise. Sans ca,
       deux joueurs qui se proposent une revanche en meme temps se bloquent
       l'un l'autre jusqu'a l'expiration. */
    const retirees = [];
    for (const m of this.p4.values()) {
      if (m.phase !== p4.FINIE && m.jeton(addr)) {
        if (m.phase === p4.ATTENTE && m.joueurs[0] === addr) { retirees.push(m); continue; }
        throw new Error('you already have a match running');
      }
    }
    const t = now || Date.now();
    partie.rejoindre(addr, t);   // peut encore refuser : table deja prise
    for (const m of retirees) this._p4Ferme(m, 'retiree', t);
    this._p4Debite(addr, mise);
    return partie;
  }

  /** Retirer sa propre table tant que personne ne s'est assis. */
  p4Annuler(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    if (partie.joueurs[0] !== addr) throw new Error('this table is not yours');
    if (partie.phase !== p4.ATTENTE) throw new Error('this match has already started');
    this._p4Ferme(partie, 'retiree', now || Date.now());
    return partie;
  }

  /** Ferme une table en attente et rend la mise. */
  _p4Ferme(partie, raison, now) {
    this._p4Rendre(partie);
    partie.phase = p4.FINIE;
    partie.raison = raison;
    partie.finA = now || Date.now();
  }

  /**
   * « On remet ca ? » — avec une somme, qui n'est pas forcement celle d'avant.
   *
   * L'offre EST une table, simplement nominative : le demandeur paie tout de
   * suite, comme pour n'importe quelle table, et l'autre s'assied avec
   * p4Rejoindre. Si personne ne repond, l'expiration rend la mise. Rien de
   * neuf ne touche a l'argent, donc rien de neuf ne peut le perdre.
   */
  p4Revanche(addr, idPrecedent, miseRaw, now) {
    const avant = this.p4.get(String(idPrecedent));
    if (!avant) throw new Error('previous match not found');
    if (avant.phase !== p4.FINIE) throw new Error('this match is not over yet');
    if (!avant.jeton(addr)) throw new Error('you were not in this match');
    const adversaire = avant.joueurs[avant.jeton(addr) === 1 ? 1 : 0];
    if (!adversaire) throw new Error('there is no opponent to challenge');

    const mise = this._p4Verifie(miseRaw, addr);
    for (const m of this.p4.values())
      if (m.phase !== p4.FINIE && m.jeton(addr)) throw new Error('you already have a match running');
    /* Une seule offre en attente vers le meme adversaire : sinon dix clics
       bloquent dix mises et l'autre ne peut en accepter qu'une. */
    for (const m of this.p4.values())
      if (m.phase === p4.ATTENTE && m.reserve === adversaire && m.joueurs[0] === addr)
        throw new Error('you already sent a rematch request');

    const t = now || Date.now();
    const id = 'p4' + (++this.p4Seq) + '-' + Math.floor(t / 1000).toString(36);
    const partie = new p4.Partie({ id, mise, createur: addr, now: t,
                                   coupMs: cfg.P4_COUP_MS,
                                   reserve: adversaire, revancheDe: avant.id });
    this._p4Debite(addr, mise);
    this.p4.set(id, partie);
    return partie;
  }

  p4Jouer(addr, id, colonne, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    const coup = partie.jouer(addr, colonne, now || Date.now());
    const reglement = partie.phase === p4.FINIE ? this._p4Regle(partie) : null;
    return { partie, coup, reglement };
  }

  p4Abandonner(addr, id, now) {
    const partie = this.p4.get(String(id));
    if (!partie) throw new Error('match not found');
    partie.abandonner(addr, now || Date.now());
    return { partie, reglement: this._p4Regle(partie) };
  }

  /**
   * Le reglement. Appele UNE SEULE FOIS par partie : `regle` garde la trace,
   * sinon un abandon suivi d'un tick paierait le gagnant deux fois.
   */
  _p4Regle(partie) {
    if (partie.regle) return null;
    partie.regle = true;
    const nul = !partie.gagnant;
    const r = p4.partage(partie.mise, cfg.P4_RAKE_BPS, nul, cfg.P4_RAKE_SUR_NUL);
    if (nul) {
      for (const a of partie.joueurs) if (a) {
        this._p4Credite(a, r.rendu);
        this._manche(this._p(a), 'p4', partie.mise, r.rendu);
      }
    } else {
      const gagnant = partie.adresseGagnante();
      const perdant = partie.joueurs[partie.gagnant === 1 ? 1 : 0];
      this._p4Credite(gagnant, r.gain);
      const pg = this._p(gagnant);
      this._bumpDay(pg); pg.winsToday++;
      this._manche(pg, 'p4', partie.mise, r.gain);
      if (perdant) this._manche(this._p(perdant), 'p4', partie.mise, 0);
    }
    return r;
  }

  /** Rend les mises : une table qu'on ferme sans avoir joue ne coute rien. */
  _p4Rendre(partie) {
    if (partie.regle) return;
    partie.regle = true;
    for (const a of partie.joueurs) if (a) this._p4Credite(a, partie.mise);
  }

  /**
   * Fait avancer les parties. Renvoie ce qui a change, pour diffusion.
   * Deux echeances : le coup, et l'attente d'un adversaire — une table sans
   * preneur ne doit pas retenir une mise indefiniment.
   */
  p4Tick(now) {
    const t = now || Date.now();
    const evs = [];
    for (const [id, partie] of this.p4) {
      if (partie.phase === p4.EN_COURS) {
        if (partie.tick(t)) evs.push({ type: 'p4Fin', partie, reglement: this._p4Regle(partie) });
      } else if (partie.phase === p4.ATTENTE &&
                 t - partie.creeA > (partie.reserve ? cfg.P4_REVANCHE_MS : cfg.P4_ATTENTE_MS)) {
        /* Une revanche tient moins longtemps qu'une table ouverte : elle
           s'adresse a quelqu'un qui est encore devant son ecran, et elle
           immobilise une mise en attendant sa reponse. */
        this._p4Rendre(partie);
        partie.phase = p4.FINIE; partie.raison = 'expiree';
        evs.push({ type: 'p4Expire', partie });
      } else if (partie.phase === p4.FINIE && t - (partie.finA || partie.creeA) > 120000) {
        this.p4.delete(id);   // on ne garde pas les parties finies plus de deux minutes
      }
    }
    return evs;
  }

  /**
   * Les tables ouvertes, pour la fenetre « rejoindre une partie ».
   * Les revanches n'y figurent pas : elles sont nominatives, et les voir
   * afficher une place qu'on ne peut pas prendre serait pire que de ne pas
   * les voir du tout.
   */
  p4Lobby() {
    const out = [];
    for (const m of this.p4.values()) {
      if (m.phase !== p4.ATTENTE || m.reserve) continue;
      out.push({ id: m.id, mise: m.mise, createur: m.joueurs[0],
                 nom: this._p(m.joueurs[0]).name, creeA: m.creeA });
    }
    return out.sort((a, b) => b.creeA - a.creeA);
  }

  /** Les demandes de revanche qui attendent la reponse de `addr`. */
  p4Invitations(addr, now) {
    const t = now || Date.now();
    const out = [];
    for (const m of this.p4.values()) {
      if (m.phase !== p4.ATTENTE || m.reserve !== addr) continue;
      out.push({ id: m.id, mise: m.mise, de: m.joueurs[0],
                 nom: this._p(m.joueurs[0]).name, revancheDe: m.revancheDe,
                 reste: Math.max(0, cfg.P4_REVANCHE_MS - (t - m.creeA)) });
    }
    return out.sort((a, b) => a.reste - b.reste);
  }

  /** L'etat d'une partie, avec les noms — la table n'en connait pas. */
  p4Etat(id, now) {
    const m = this.p4.get(String(id));
    if (!m) return null;
    const e = m.etat(now || Date.now());
    e.noms = m.joueurs.map((a) => (a ? this._p(a).name : null));
    e.rakeBps = cfg.P4_RAKE_BPS;
    return e;
  }

  /** La partie en cours d'un joueur, s'il en a une. */
  p4Mienne(addr) {
    for (const m of this.p4.values())
      if (m.phase !== p4.FINIE && m.jeton(addr)) return m;
    return null;
  }

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
      if (pv === 21 && dv === 21) { p.bj.stage = 'done'; p.bj.result = 'push'; p.balance = p.balance.add(w); this._bumpDay(p); p.dayNet = p.dayNet.add(w); p.bj.payout = amt; this._manche(p, 'bj', amt, amt); }
      else if (pv === 21) { const credit = amt * 2.5; p.balance = p.balance.add(WEI(credit)); this._bumpDay(p); p.dayNet = p.dayNet.add(WEI(credit)); p.winsToday++; p.bj.stage = 'done'; p.bj.result = 'blackjack'; p.bj.payout = credit; this._manche(p, 'bj', amt, credit); }
      else { p.bj.stage = 'done'; p.bj.result = 'dealer_blackjack'; p.bj.payout = 0; this._manche(p, 'bj', amt, 0); }
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
    /* On journalise l'AUTORISATION, pas l'encaissement : c'est le moment ou le
       solde quitte le compte, et c'est celui que le joueur reconnait. Le bon
       peut encore etre presente plus tard a la chaine — ou jamais. */
    journal.ajoute(addr, { k: 'wd', m: amountStr, to: String(addr).toLowerCase(),
                           cum: ethers.utils.formatUnits(p.cumulativeAuthorized, cfg.DECIMALS) });
    return p.cumulativeAuthorized;
  }

  // ------------------------------------------------------------- les amis
  /*
   * Une liste d'adresses, et un virement de solde a solde.
   *
   * Le virement ne touche PAS la chaine : il deplace deux nombres dans l'etat
   * du serveur, ce qui est instantane et gratuit — c'est tout l'interet. Mais
   * c'est de l'argent, donc trois regles :
   *
   *  1. l'expediteur doit avoir DEPOSE au moins une fois. Sans ca, ouvrir dix
   *     portefeuilles jetables, ramasser dix bonus de bienvenue et tout
   *     rassembler sur un onzieme ne couterait rien ;
   *  2. on ne s'envoie rien a soi-meme — ca ne veut rien dire et ca fabrique
   *     de faux mouvements dans l'historique ;
   *  3. debit et credit dans la MEME instruction, sans await entre les deux.
   *     Node est mono-thread : rien ne peut s'intercaler, donc la somme des
   *     deux soldes ne peut pas bouger.
   */
  amis(addr) {
    const p = this._p(addr);
    return (p.amis || []).map((a) => {
      const q = this.players.get(a);
      return { address: a, name: q ? q.name : a.slice(0, 6), visage: q ? (q.visage || null) : null,
               connu: !!q };
    });
  }

  amiAjoute(addr, autre) {
    const moi = String(addr).toLowerCase();
    const a = String(autre || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('enter a valid 0x… address');
    if (a === moi) throw new Error('that is your own address');
    const p = this._p(addr);
    if (!p.amis) p.amis = [];
    if (p.amis.indexOf(a) >= 0) throw new Error('already in your friends');
    if (p.amis.length >= 100) throw new Error('friend list is full (100)');
    p.amis.push(a);
    return this.amis(addr);
  }

  amiRetire(addr, autre) {
    const a = String(autre || '').toLowerCase();
    const p = this._p(addr);
    p.amis = (p.amis || []).filter((x) => x !== a);
    return this.amis(addr);
  }

  /**
   * Envoie du $SWOGE d'un solde a un autre.
   * @returns {{ montant:string, vers:string, solde:string }}
   */
  transfere(addr, vers, montantStr) {
    const moi = String(addr).toLowerCase();
    const dest = String(vers || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(dest)) throw new Error('enter a valid 0x… address');
    if (dest === moi) throw new Error('you cannot send to yourself');

    const p = this._p(moi);
    if (cfg.TRANSFER_REQUIRE_DEPOSIT && !p.hasDeposited)
      throw new Error('deposit once before sending $SWOGE to others');

    let montant;
    try { montant = WEI(String(montantStr)); }
    catch (e) { throw new Error('enter a valid amount'); }
    if (montant.lte(0)) throw new Error('enter an amount');
    if (montant.lt(WEI(String(cfg.TRANSFER_MIN)))) throw new Error('minimum transfer is ' + cfg.TRANSFER_MIN + ' $SWOGE');
    if (montant.gt(p.balance)) throw new Error('amount exceeds your balance');

    const q = this._p(dest);
    // debit et credit d'un seul tenant : rien ne peut s'intercaler
    p.balance = p.balance.sub(montant);
    q.balance = q.balance.add(montant);

    const m = ethers.utils.formatUnits(montant, cfg.DECIMALS);
    journal.ajoute(moi, { k: 'tr', sens: 'out', m, autre: dest });
    journal.ajoute(dest, { k: 'tr', sens: 'in', m, autre: moi });
    return { montant: m, vers: dest,
             solde: ethers.utils.formatUnits(p.balance, cfg.DECIMALS),
             nomDest: q.name };
  }

  fairness(addr) {
    const p = this._p(addr);
    return { serverSeedHash: this.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce };
  }
}

module.exports = { Game, COST, MINW };
