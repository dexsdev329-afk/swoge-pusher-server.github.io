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
  const bps = game.totalStaked().mul(10000).div(supplyWei); // 2-dec %
  return (bps.toNumber() / 100).toFixed(2);
}

const clients = new Set();                 // all sockets
const byAddr = new Map();                  // addr -> Set(sockets)

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toAddr(addr, obj) { const set = byAddr.get(addr); if (set) for (const ws of set) send(ws, obj); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === 1) ws.send(s); }

// ---- HTTP (health + tiny info) ----
const server = http.createServer(async (req, res) => {
 try {
  const path = req.url.split('?')[0];
  const key = new URLSearchParams(req.url.split('?')[1] || '').get('key') || '';
  const authed = !cfg.ADMIN_KEY || key === cfg.ADMIN_KEY; // open if no key configured
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  // Private owner dashboard (HTML)
  if (path === '/admin') {
    if (!authed) { res.writeHead(401, { 'content-type': 'text/html' }); return res.end('<h3>401 — add ?key=YOUR_ADMIN_KEY</h3>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(admin.page());
  }
  // Owner solvency view: how much is in the vault, how much is owed to players,
  // and the SURPLUS you can safely ownerWithdraw without touching player funds.
  if (path === '/stats') {
    if (!authed) { res.writeHead(401); return res.end('unauthorized'); }
    const owed = game.totalOwed();
    const pot = await chain.vaultPot();
    const fmt = (w) => (w ? ethers.utils.formatUnits(w, cfg.DECIMALS) : null);
    const surplus = pot && pot.gt(owed) ? pot.sub(owed) : ethers.BigNumber.from(0);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      vaultPot: fmt(pot),                    // $SWOGE currently in the contract
      owedToPlayers: fmt(owed),              // balances + staked + pending yield + jackpot
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
        return send(ws, { type: 'auth', address: rec, balance: game.balanceStr(rec), fairness: game.fairness(rec), quests: game.questState(rec), stake: game.stakeInfo(rec) });
      }
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
      if (m.type === 'stake' || m.type === 'unstake' || m.type === 'claimStake') {
        try {
          if (m.type === 'stake') game.stake(ws.addr, m.amount);
          else if (m.type === 'unstake') game.unstake(ws.addr, m.amount);
          else { const r = game.claimStake(ws.addr); send(ws, { type: 'stakeClaimed', reward: r }); }
          persistSoon();
          send(ws, { type: 'stakeInfo', ...game.stakeInfo(ws.addr), balance: game.balanceStr(ws.addr) });
          if (m.type === 'stake' && parseFloat(m.amount) >= cfg.NOTIFY_STAKE_MIN) {
            const pct = stakedPct();
            tg.notifyPhoto(cfg.STAKE_IMAGE, `🔒 <b>New stake</b>\n${short(ws.addr)} staked <b>${fmtAmt(m.amount)} $SWOGE</b>` + (pct ? `\n📊 Total staked: <b>${pct}%</b> of supply` : ''));
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
    } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.addr && byAddr.has(ws.addr)) { byAddr.get(ws.addr).delete(ws); if (!byAddr.get(ws.addr).size) byAddr.delete(ws.addr); }
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

// ---- jackpot pot + daily leaderboard + per-player quest progress ----
const metaInterval = setInterval(() => {
  broadcast({ type: 'meta', jackpot: game.jackpotStr(), leaderboard: game.leaderboard(cfg.LEADERBOARD_SIZE) });
  for (const [addr, set] of byAddr) {
    const qs = game.questState(addr), si = game.stakeInfo(addr);
    for (const ws of set) { send(ws, { type: 'quests', quests: qs }); send(ws, { type: 'stakeInfo', ...si }); }
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
  clearInterval(stepInterval); clearInterval(bcInterval); clearInterval(metaInterval); clearInterval(saveInterval);
  persist(); // final save so nothing is lost on redeploy
  server.close(); process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
