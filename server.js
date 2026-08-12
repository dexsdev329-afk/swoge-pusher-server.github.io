'use strict';
/*
 * SWOGE Pusher — authoritative real-time game server.
 *   • one shared physics table (physics.js)
 *   • wallet-signature login, balances from Vault deposits (chain.js)
 *   • provably-fair coin values, winnings (game.js)
 *   • 20 Hz state broadcast over WebSocket to every client
 *   • auto withdrawals via backend-signed EIP-712 vouchers
 *
 * The client only RENDERS what the server sends and forwards taps — so every
 * player sees the exact same table, coins, and pile.
 */
const http = require('http');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { WebSocketServer } = require('ws');
const cfg = require('./config');
const { Table } = require('./physics');
const { Game } = require('./game');
const { Chain } = require('./chain');
const { PokerRoom } = require('./poker_room');
const store = require('./store');
const tg = require('./telegram');
const admin = require('./admin');

const table = new Table();
const game = new Game();
const chain = new Chain();

// ---- restore persisted balances (survives Railway redeploys via a volume) ----
const saved = store.load();
if (saved) { game.hydrate(saved); console.log(`[store] restored ${game.players.size} players, jackpot=${game.jackpotStr()}, lastBlock=${game.lastBlock}`); }
else console.log('[store] no saved state (first run)');
function persist() { store.save(game.serialize()); }
// Coalesced immediate save: fires ~1.2s after an important event so an abrupt
// kill (no SIGTERM) can't lose a deposit/stake/withdraw/jackpot/quest.
let _saveT = null;
function persistSoon() { if (_saveT) return; _saveT = setTimeout(() => { _saveT = null; persist(); }, 1200); }
console.log('[store] state file →', require('path').resolve(store.FILE), '(must be inside your Railway volume)');

// ---- Telegram notification helpers ----
let supplyWei = null; // SWOGE total supply (for the % staked), fetched once
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '?';
const fmtAmt = (s) => { const n = parseFloat(s || '0'); return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(n < 1 ? 4 : 0); };
function stakedPct() {
  if (!supplyWei || supplyWei.isZero()) return null;
  // percent × 1e4 → 4-decimal precision (0.01% basis points truncated tiny pools to 0.00%)
  const p4 = game.totalStaked().mul(1000000).div(supplyWei);
  const pct = p4.toNumber() / 10000;
  // show up to 4 decimals but drop trailing zeros (5% not 5.0000%, 0.0012% stays)
  return pct.toFixed(4).replace(/\.?0+$/, '');
}

const clients = new Set();                 // all sockets
const byAddr = new Map();                  // addr -> Set(sockets)

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toAddr(addr, obj) { const set = byAddr.get(addr); if (set) for (const ws of set) send(ws, obj); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === 1) ws.send(s); }

// ---- poker ----
// La salle ignore les sockets : elle previent par evenements, et c'est ici
// qu'on decide qui recoit quoi. Chaque socket regarde au plus une table
// (ws.pokerTable), et ne recoit que ses propres cartes.
const poker = new PokerRoom(game, {
  tables: cfg.POKER_TABLES,
  actionMs: cfg.POKER_ACTION_MS,
  idleHandsLimit: cfg.POKER_IDLE_HANDS,
  betweenHandsMs: cfg.POKER_BETWEEN_HANDS_MS,
  rakeBps: cfg.POKER_RAKE_BPS,
  onEvent: (tableId, ev) => {
    pokerToTable(tableId, { type: 'pokerEvent', table: tableId, event: ev });
    if (ev.type === 'handEnd' || ev.type === 'leave' || ev.type === 'idleKick' || ev.type === 'busted') {
      persistSoon();                       // des jetons ont bouge cote solde
    }
  },
});

function pokerViewers(tableId) {
  const out = [];
  for (const ws of clients) if (ws.pokerTable === tableId && ws.readyState === 1) out.push(ws);
  return out;
}
function pokerToTable(tableId, obj) { for (const ws of pokerViewers(tableId)) send(ws, obj); }
/** Envoie a chacun SA vue de la table (ses cartes, ses actions permises). */
function pokerPush(tableId) {
  for (const ws of pokerViewers(tableId)) {
    const snap = poker.snapshot(tableId, ws.addr);
    if (snap) send(ws, { type: 'poker', table: tableId, snapshot: snap, now: Date.now(),
                         balance: ws.addr ? game.balanceStr(ws.addr) : null });
  }
}
function pokerPushAll() { for (const id of poker.tables.keys()) pokerPush(id); }

// ---- HTTP (health + tiny info) ----
const server = http.createServer(async (req, res) => {
 try {
  const path = req.url.split('?')[0];
  const key = new URLSearchParams(req.url.split('?')[1] || '').get('key') || '';
  const authed = !cfg.ADMIN_KEY || key === cfg.ADMIN_KEY; // open if no key configured
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  // Adsgram rewarded-video postback (server-to-server). Adsgram GETs this when a
  // user finishes a video: /adsgram/reward?userid=[TelegramId]&key=SECRET.
  // We verify the shared secret, credit the (capped) reward and push the new
  // balance to the player's live sockets. Always 200 on a valid key so Adsgram
  // doesn't retry a cooldown/cap as a failure; 403 only on a bad/absent key.
  if (path === '/adsgram/reward') {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const userid = qs.get('userid') || qs.get('userId') || qs.get('user_id') || '';
    const rkey = qs.get('key') || '';
    if (!cfg.ADSGRAM_KEY || rkey !== cfg.ADSGRAM_KEY) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
    }
    const r = game.grantAdReward(userid);
    if (r.ok) {
      persistSoon();
      toAddr(r.addr, { type: 'adReward', reward: r.reward, balance: r.balance, ad: game.adState(r.addr), bonus: game.bonusState(r.addr) });
      console.log(`[adsgram] rewarded ${userid} → ${r.addr} +${r.reward} $SWOGE`);
    } else {
      console.log(`[adsgram] no reward for ${userid}: ${r.reason}`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  // Private owner dashboard (HTML)
  if (path === '/admin') {
    if (!authed) { res.writeHead(401, { 'content-type': 'text/html' }); return res.end('<h3>401 — add ?key=YOUR_ADMIN_KEY</h3>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(admin.page());
  }
  // Liste des joueurs (prive, meme cle admin que /stats). Filtre optionnel ?q=
  if (path === '/players') {
    if (!authed) { res.writeHead(401); return res.end('unauthorized'); }
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    let rows = game.playersReport();
    const q = String(qs.get('q') || '').trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.address.includes(q) || (r.name || '').toLowerCase().includes(q) || String(r.tgId || '') === q);
    const limit = Math.min(1000, Math.max(1, parseInt(qs.get('limit') || '200', 10) || 200));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ count: rows.length, players: rows.slice(0, limit) }, null, 2));
  }
  // Owner solvency view: how much is in the vault, how much is owed to players,
  // and the SURPLUS you can safely ownerWithdraw without touching player funds.
  if (path === '/stats') {
    if (!authed) { res.writeHead(401); return res.end('unauthorized'); }
    const bd = game.owedBreakdown();
    const owed = bd.balances.add(bd.staked).add(bd.pending).add(bd.jackpot);
    const pot = await chain.vaultPot();
    const fmt = (w) => (w ? ethers.utils.formatUnits(w, cfg.DECIMALS) : null);
    const surplus = pot && pot.gt(owed) ? pot.sub(owed) : ethers.BigNumber.from(0);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      vaultPot: fmt(pot),                    // $SWOGE currently in the contract
      owedToPlayers: fmt(owed),              // total owed (the 4 lines below)
      owedBalances: fmt(bd.balances),        //   player balances
      owedStaked: fmt(bd.staked),            //   staked
      owedPending: fmt(bd.pending),          //   pending stake yield
      owedJackpot: fmt(bd.jackpot),          //   jackpot reserve
      ownerSurplus: fmt(pot ? surplus : null), // <-- safe amount you can withdraw
      jackpot: game.jackpotStr(), totalStaked: fmt(game.totalStaked()),
      players: game.players.size, vault: cfg.VAULT_ADDRESS || null,
    }, null, 2));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    game: 'swoge-pusher', players: game.players.size, coins: table.coins.size,
    serverSeedHash: game.serverSeedHash, vault: cfg.VAULT_ADDRESS || null,
    signer: chain.signerAddress || null,
  }));
 } catch (e) {
  // An HTTP route must NEVER crash the game server.
  console.warn('[http] handler error:', e.message);
  try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch (_) {}
 }
});
// last-resort guards so nothing can take the process down
process.on('unhandledRejection', (e) => console.warn('[unhandledRejection]', e && e.message));
process.on('uncaughtException', (e) => console.warn('[uncaughtException]', e && e.message));
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.addr = null;
  ws.nonce = crypto.randomBytes(16).toString('hex'); // login challenge
  clients.add(ws);
  send(ws, {
    type: 'hello',
    loginNonce: ws.nonce,
    serverSeedHash: game.serverSeedHash,
    dropCost: cfg.DROP_COST, minWithdraw: cfg.MIN_WITHDRAW,
    vault: cfg.VAULT_ADDRESS || null, token: cfg.SWOGE_TOKEN, chainId: cfg.CHAIN_ID,
    jackpot: game.jackpotStr(), leaderboard: game.leaderboard(cfg.LEADERBOARD_SIZE),
  });

  ws.on('message', async (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    try {
      if (m.type === 'login') {
        // client signs exactly this message with their wallet
        const expected = `SWOGE Pusher login\nnonce: ${ws.nonce}`;
        if (m.message !== expected) return send(ws, { type: 'error', error: 'bad login message' });
        const rec = chain.verifyLogin(m.message, m.signature);
        if (!rec) return send(ws, { type: 'error', error: 'bad signature' });
        ws.addr = rec;
        if (!byAddr.has(rec)) byAddr.set(rec, new Set());
        byAddr.get(rec).add(ws);
        if (m.name) game.setName(rec, m.name);
        if (m.tgId) game.linkTelegram(rec, m.tgId); // map Telegram id → account for the Adsgram reward postback
        const welcome = game.grantWelcome(rec);      // one-time demo credit for a brand-new player
        if (welcome > 0) persistSoon();
        return send(ws, { type: 'auth', address: rec, balance: game.balanceStr(rec), fairness: game.fairness(rec), quests: game.questState(rec), stake: game.stakeInfo(rec), bj: game.bjState(rec), casino: game.casinoState(rec), hilo: game.hiloState(rec),
          casinoPay: require('./casino').PAY, casinoMin: cfg.CASINO_MIN_BET, casinoMax: cfg.CASINO_MAX_BET, hiloEdgeBps: cfg.HILO_EDGE_BPS, volcano: { meter: game.volcanoMeterOf(rec) }, bonus: game.bonusState(rec), welcomeGranted: welcome });
      }
      // le hall et l'observation d'une table sont publics : on peut regarder
      // jouer avant de se connecter
      if (m.type === 'pokerLobby') return send(ws, { type: 'pokerLobby', tables: poker.lobby() });
      if (m.type === 'pokerWatch') {
        const id = String(m.table || '');
        if (!poker.tables.has(id)) return send(ws, { type: 'error', error: 'table inconnue' });
        ws.pokerTable = id;
        return send(ws, { type: 'poker', table: id, snapshot: poker.snapshot(id, ws.addr),
                          balance: ws.addr ? game.balanceStr(ws.addr) : null });
      }
      if (m.type === 'pokerUnwatch') { ws.pokerTable = null; return; }

      if (!ws.addr) return send(ws, { type: 'error', error: 'login required' });

      if (m.type === 'drop') {
        if (!game.canDrop(ws.addr)) return send(ws, { type: 'need_deposit', balance: game.balanceStr(ws.addr) });
        // Table full → refuse WITHOUT charging, so a big queued batch drains as
        // room frees instead of burning $SWOGE on coins that never appear.
        if (table.coins.size >= cfg.TABLE.maxCoins) return send(ws, { type: 'table_full' });
        const res = game.drop(ws.addr);
        if (res === null) return;
        const id = table.dropCoin(ws.addr, game._p(ws.addr).name, res.value);
        if (id === null) { game.refund(ws.addr); return send(ws, { type: 'table_full', balance: game.balanceStr(ws.addr) }); }
        // progressive jackpot hit → tell the winner + announce to everyone
        if (res.jackpotWon && res.jackpotWon.gt(0)) {
          const amt = ethers.utils.formatUnits(res.jackpotWon, cfg.DECIMALS);
          toAddr(ws.addr, { type: 'jackpot', amount: amt, balance: game.balanceStr(ws.addr) });
          broadcast({ type: 'jackpotWin', name: game._p(ws.addr).name, amount: amt, jackpot: game.jackpotStr() });
          persistSoon();
          tg.notify(`🎰 <b>JACKPOT WON!</b>\n${game._p(ws.addr).name} just hit <b>${fmtAmt(amt)} $SWOGE</b> 🎉`);
        }
        return send(ws, { type: 'balance', balance: game.balanceStr(ws.addr) });
      }
      if (m.type === 'spin') {
        // SWOGE Smash: 1 spin = SPIN_COST $SWOGE, provably-fair, RTP 50%.
        // Shares the exact same balance as the Pusher (same game.players map).
        const r = game.spin(ws.addr, m.bet);
        if (r === null) return send(ws, { type: 'need_deposit', balance: game.balanceStr(ws.addr) });
        if (r.error) return send(ws, { type: 'error', error: r.error });
        persistSoon();
        if (r.payout >= cfg.NOTIFY_WIN_MIN) tg.notify(`🎰 <b>Smash win!</b>\n${game._p(ws.addr).name} hit <b>${r.mult}×</b> for <b>${r.payout} $SWOGE</b> 🐕`);
        return send(ws, { type: 'spinResult', mult: r.mult, payout: r.payout, bet: r.bet, balance: game.balanceStr(ws.addr), fairness: game.fairness(ws.addr) });
      }
      if (m.type === 'volcanoSpin' || m.type === 'volcanoBuyBonus') {
        // SWOGE Spin (Volcano). Server-authoritative, provably fair, RTP ~70%.
        // Shares the same balance as every other game.
        try {
          const r = m.type === 'volcanoSpin' ? game.volcanoSpin(ws.addr, m.bet) : game.volcanoBuyBonus(ws.addr, m.bet);
          if (r.error) return send(ws, { type: 'need_deposit', balance: game.balanceStr(ws.addr) });
          persistSoon();
          if (r.payout >= cfg.NOTIFY_WIN_MIN) tg.notify(`🌋 <b>SWOGE Spin win!</b>\n${game._p(ws.addr).name} won <b>${r.payout} $SWOGE</b> 🐕`);
          send(ws, { type: 'volcanoResult', ...r });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'bj_bet' || m.type === 'bj_hit' || m.type === 'bj_stand' || m.type === 'bj_double') {
        // SWOGE Blackjack — same shared balance, provably-fair, server-authoritative.
        try {
          let st;
          if (m.type === 'bj_bet') st = game.bjBet(ws.addr, m.amount);
          else if (m.type === 'bj_hit') st = game.bjHit(ws.addr);
          else if (m.type === 'bj_stand') st = game.bjStand(ws.addr);
          else st = game.bjDouble(ws.addr);
          persistSoon();
          if (st.stage === 'done' && st.payout >= cfg.NOTIFY_WIN_MIN) tg.notify(`🃏 <b>Blackjack win!</b>\n${game._p(ws.addr).name} won <b>${st.payout} $SWOGE</b> 🐕`);
          send(ws, { type: 'bj', state: st });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'devCredit' && process.env.DEV_FAUCET === '1') {
        game.creditDeposit({ player: ws.addr, amount: require('ethers').ethers.utils.parseUnits('1000', cfg.DECIMALS), tx: 'dev:' + Date.now() + Math.random() });
        return send(ws, { type: 'balance', balance: game.balanceStr(ws.addr) });
      }
      if (m.type === 'setClientSeed') { game.setClientSeed(ws.addr, m.seed); return send(ws, { type: 'fairness', fairness: game.fairness(ws.addr) }); }
      if (m.type === 'claimQuest') {
        try {
          const reward = game.claimQuest(ws.addr, m.id);
          persistSoon();
          send(ws, { type: 'questClaimed', id: m.id, reward, balance: game.balanceStr(ws.addr), quests: game.questState(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'quests') return send(ws, { type: 'quests', quests: game.questState(ws.addr) });
      if (m.type === 'bonusState') return send(ws, { type: 'bonus', bonus: game.bonusState(ws.addr) });
      if (m.type === 'claimWelcome') {
        try {
          const reward = game.claimWelcome(ws.addr);
          persistSoon();
          send(ws, { type: 'welcomeClaimed', reward, balance: game.balanceStr(ws.addr), bonus: game.bonusState(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'claimStreak') {
        try {
          const r = game.claimStreak(ws.addr);
          persistSoon();
          send(ws, { type: 'streakClaimed', day: r.day, reward: r.reward, balance: game.balanceStr(ws.addr), bonus: game.bonusState(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'stake' || m.type === 'unstake' || m.type === 'claimStake') {
        try {
          if (m.type === 'stake') game.stake(ws.addr, m.amount);
          else if (m.type === 'unstake') { const r = game.unstakeAll(ws.addr); send(ws, { type: 'stakeUnstaked', ...r }); }
          else { const r = game.claimStake(ws.addr); send(ws, { type: 'stakeClaimed', reward: r }); }
          persistSoon();
          send(ws, { type: 'stakeInfo', ...game.stakeInfo(ws.addr), balance: game.balanceStr(ws.addr) });
          if (m.type === 'stake' && parseFloat(m.amount) >= cfg.NOTIFY_STAKE_MIN) {
            const pct = stakedPct();
            const totalStr = fmtAmt(ethers.utils.formatUnits(game.totalStaked(), cfg.DECIMALS));
            tg.notifyPhoto(cfg.STAKE_IMAGE, `🔒 <b>New stake</b>\n${short(ws.addr)} staked <b>${fmtAmt(m.amount)} $SWOGE</b>` + `\n📊 Total staked: <b>${totalStr} $SWOGE</b>` + (pct ? ` (${pct}% of supply)` : ''));
          }
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'stakeInfo') return send(ws, { type: 'stakeInfo', ...game.stakeInfo(ws.addr), balance: game.balanceStr(ws.addr) });
      if (m.type === 'balance') return send(ws, { type: 'balance', balance: game.balanceStr(ws.addr) });

      if (m.type === 'withdraw') {
        try {
          const cumulative = game.requestWithdraw(ws.addr, m.amount);
          persistSoon(); // record the deducted balance + cumulative right away
          const voucher = await chain.signVoucher(ws.addr, cumulative);
          send(ws, { type: 'voucher', voucher, vault: cfg.VAULT_ADDRESS, balance: game.balanceStr(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      // ---- casino (jeux contre la banque) ----
      if (m.type === 'casinoState') return send(ws, { type: 'casino', state: game.casinoState(ws.addr) });
      if (m.type === 'casinoDeal') {
        try {
          const st = game.casinoDeal(ws.addr, String(m.game || ''), m.ante, m.side);
          persistSoon();
          send(ws, { type: 'casino', state: st, balance: game.balanceStr(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'casinoDecide') {
        try {
          const st = game.casinoDecide(ws.addr, !!m.play);
          persistSoon();
          send(ws, { type: 'casino', state: st, balance: game.balanceStr(ws.addr),
                     fairness: game.fairness(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }

      // ---- hi-lo ----
      if (m.type === 'hiloState') return send(ws, { type: 'hilo', state: game.hiloState(ws.addr) });
      if (m.type === 'hiloStart') {
        try {
          const st = game.hiloStart(ws.addr, m.bet);
          persistSoon();
          send(ws, { type: 'hilo', state: st, balance: game.balanceStr(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'hiloStep') {
        try {
          const st = game.hiloStep(ws.addr, String(m.dir || ''));
          persistSoon();
          send(ws, { type: 'hilo', state: st, balance: game.balanceStr(ws.addr),
                     fairness: game.fairness(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'hiloCashOut') {
        try {
          const st = game.hiloCashOut(ws.addr);
          persistSoon();
          send(ws, { type: 'hilo', state: st, balance: game.balanceStr(ws.addr),
                     fairness: game.fairness(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }

      // ---- poker (actions nominatives) ----
      if (m.type === 'pokerJoin') {
        try {
          const id = String(m.table || '');
          const r = poker.join(ws.addr, id, m.buyIn, {
            seat: m.seat != null ? m.seat : -1,
            name: game._p(ws.addr).name,
            avatar: m.avatar,
          });
          ws.pokerTable = id;
          persistSoon();
          send(ws, { type: 'pokerJoined', ...r, balance: game.balanceStr(ws.addr) });
          pokerPush(id);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'pokerLeave') {
        const at = poker.where(ws.addr);
        poker.leaveTable(ws.addr);
        persistSoon();
        send(ws, { type: 'pokerLeft', balance: game.balanceStr(ws.addr) });
        if (at) pokerPush(at.tableId);
        return;
      }
      if (m.type === 'pokerAct') {
        try {
          const id = poker.act(ws.addr, String(m.action || ''), Number(m.amount) || 0);
          pokerPush(id);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'pokerSitOut') {
        try {
          poker.sitOut(ws.addr, !!m.out);
          const at = poker.where(ws.addr);
          if (at) pokerPush(at.tableId);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'pokerRebuy') {
        try {
          const stack = poker.rebuy(ws.addr, m.amount);
          persistSoon();
          send(ws, { type: 'pokerRebought', stack, balance: game.balanceStr(ws.addr) });
          const at = poker.where(ws.addr);
          if (at) pokerPush(at.tableId);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
    } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.addr && byAddr.has(ws.addr)) {
      byAddr.get(ws.addr).delete(ws);
      if (!byAddr.get(ws.addr).size) {
        byAddr.delete(ws.addr);
        // Plus aucune fenetre ouverte : on met le joueur en pause plutot que de
        // le lever. Il garde sa place et son tapis s'il revient vite ; sinon le
        // minuteur d'inactivite finira par le sortir et lui rendre ses jetons.
        const at = poker.where(ws.addr);
        if (at) { try { poker.sitOut(ws.addr, true); } catch (e) { /* deja parti */ } }
      }
    }
  });
});

// ---- physics loop ----
let last = process.hrtime.bigint();
const stepInterval = setInterval(() => {
  const now = process.hrtime.bigint();
  let dt = Number(now - last) / 1e9; last = now;
  if (dt > 0.1) dt = 0.1; // clamp after a stall
  const { wins } = table.step(dt);
  for (const w of wins) {
    game.win(w.owner, w.value);
    if (w.value > 0) {
      toAddr(w.owner, { type: 'win', value: w.value, balance: game.balanceStr(w.owner) });
      broadcast({ type: 'ticker', name: w.ownerName, value: w.value });
      if (w.value >= cfg.NOTIFY_WIN_MIN) tg.notify(`🏆 <b>Big win!</b>\n${w.ownerName} just won <b>${w.value} $SWOGE</b> 🐕`);
    }
  }
}, Math.round(1000 / cfg.TABLE.stepHz));

// ---- broadcast loop ----
const bcInterval = setInterval(() => {
  broadcast({ type: 'state', ...table.snapshot() });
}, Math.round(1000 / cfg.BROADCAST_HZ));

// ---- poker : minuteurs de decision + main suivante + diffusion ----
// Une seconde suffit : le minuteur d'action est d'une minute, et l'echeance
// exacte est envoyee au client, qui affiche le decompte lui-meme.
const pokerInterval = setInterval(() => {
  try { poker.tick(Date.now()); pokerPushAll(); }
  catch (e) { console.warn('[poker]', e && e.message); }
}, 1000);

// ---- jackpot pot + daily leaderboard + per-player quest progress ----
const metaInterval = setInterval(() => {
  broadcast({ type: 'meta', jackpot: game.jackpotStr(), leaderboard: game.leaderboard(cfg.LEADERBOARD_SIZE) });
  for (const [addr, set] of byAddr) {
    const qs = game.questState(addr), si = game.stakeInfo(addr), bs = game.bonusState(addr);
    for (const ws of set) { send(ws, { type: 'quests', quests: qs }); send(ws, { type: 'stakeInfo', ...si }); send(ws, { type: 'bonus', bonus: bs }); }
  }
}, 3000);

// ---- persist balances/state periodically (survives redeploys via a volume) ----
const saveInterval = setInterval(persist, cfg.SAVE_MS);

// ---- deposits ----
(async () => {
  try {
    // Resume from the persisted watermark so deposits made while the server was
    // down are still credited (seenTx dedupes anything already counted). On a
    // fresh install, SCAN_FROM_BLOCK (if set) re-credits historical deposits.
    supplyWei = await chain.totalSupply(); // for the % staked in stake notifs
    const tipNow = chain.vault ? await chain.provider.getBlockNumber() : 0;
    let fromBlock = game.lastBlock || cfg.SCAN_FROM_BLOCK || tipNow;
    // only Telegram-notify deposits at/after the current tip, so a historical
    // re-scan (SCAN_FROM_BLOCK / resumed watermark) doesn't spam old deposits.
    const liveFrom = tipNow;
    chain.watchDeposits(fromBlock, (d) => {
      if (game.creditDeposit(d)) {
        console.log(`[deposit] ${d.player} +${d.amount.toString()} (${d.tx})`);
        persistSoon();
        toAddr(d.player, { type: 'deposit', balance: game.balanceStr(d.player) });
        const amt = ethers.utils.formatUnits(d.amount, cfg.DECIMALS);
        if (d.block >= liveFrom && parseFloat(amt) >= cfg.NOTIFY_DEPOSIT_MIN) {
          tg.notifyPhoto(cfg.DEPOSIT_IMAGE, `💰 <b>New deposit</b>\n${short(d.player)} deposited <b>${fmtAmt(amt)} $SWOGE</b>\n<a href="${cfg.EXPLORER}/tx/${d.tx}">view tx ↗</a>`);
        }
      }
    }, (nextBlock) => { game.lastBlock = nextBlock; });
  } catch (e) { console.warn('deposit watch init failed:', e.message); }
})();

server.listen(cfg.PORT, () => {
  console.log(`SWOGE Pusher server on :${cfg.PORT}`);
  console.log(`  vault=${cfg.VAULT_ADDRESS || '(none)'} signer=${chain.signerAddress || '(none)'} serverSeedHash=${game.serverSeedHash.slice(0,16)}…`);
  console.log(`  telegram=${tg.enabled() ? 'ON (chat ' + cfg.TG_CHAT_ID + ')' : 'OFF (set TG_BOT_TOKEN + TG_CHAT_ID)'}`);
  tg.notify('🟢 <b>SWOGE server online</b> — notifications actives'); // startup ping = quick check that TG works
});

function shutdown() {
  clearInterval(stepInterval); clearInterval(bcInterval); clearInterval(metaInterval); clearInterval(saveInterval); clearInterval(pokerInterval);
  persist(); // final save so nothing is lost on redeploy
  server.close(); process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
