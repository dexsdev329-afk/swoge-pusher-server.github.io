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
const session = require('./session');
const journal = require('./journal');
const avatars = require('./avatars');

const table = new Table();
const game = new Game();
const chain = new Chain();

// ---- restore persisted balances (survives Railway redeploys via a volume) ----
/* Si l'etat existe mais n'est pas lisible, store.load() JETTE plutot que de
   rendre null : demarrer a vide ferait ecraser tous les soldes par la premiere
   sauvegarde automatique. On s'arrete franchement, avec le message. */
let saved;
try { saved = store.load(); }
catch (e) {
  console.error('\n' + (e && e.message) + '\n');
  process.exit(1);
}
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

/*
 * Gains de TOUS les jeux contre la banque.
 *
 * On annonce le BENEFICE, pas ce qui revient : «a gagne 1000» pour une mise de
 * 900 rendue 1000 ne veut rien dire. Le seuil porte donc lui aussi sur le
 * benefice — sinon une grosse mise a peine gagnante remplirait le canal.
 *
 * C'est exactement ce qui est arrive : le blackjack annoncait le retour brut,
 * mise comprise. Un joueur a la mise maximum de 10 000 declenchait « won
 * 20,000 » a chaque main gagnee — et pas un mot quand il perdait les memes
 * 10 000. Cent annonces plus tard, le canal donnait a voir un tricheur la ou
 * il n'y avait qu'un gros joueur a l'equilibre.
 * La mise et le retour sont rappeles sur la ligne du dessous : celui qui lit
 * n'a pas a deviner ce que couvre le chiffre.
 */
const NOM_TABLE = { holdem: "Casino Hold'em", three: 'Three Card', hilo: 'Hi-Lo', mines: 'Mines',
                    plinko: 'Plinko', bj: 'Blackjack', smash: 'Smash', spin: 'SWOGE Spin',
                    crash: 'Crash', p4: 'Connect 4', mp: 'Tic-Tac-Toe', dm: 'Checkers' };
/* L'image du jeu accompagne l'annonce. Ce sont les MEMES vignettes que sur la
   page des jeux, extraites une fois dans media/ : une annonce illustree se
   remarque dans un canal, et celle qui montre la table dont on parle se
   remarque a bon escient. Telegram va chercher l'image lui-meme, d'ou une
   adresse publique ; si elle ne repond pas, notifyPhoto retombe sur le texte
   seul et l'annonce part quand meme. */
function imageJeu(jeu) {
  if (!cfg.GAME_IMAGE_BASE || !jeu) return null;
  return `${cfg.GAME_IMAGE_BASE.replace(/\/+$/, '')}/jeu-${jeu}.jpg`;
}

function notifyTableWin(addr, jeu, { net, staked, payout, note }) {
  if (!(net >= cfg.NOTIFY_WIN_MIN)) return;
  tg.notifyPhoto(imageJeu(jeu),
            `🃏 <b>${NOM_TABLE[jeu] || jeu}</b>\n` +
            `${game._p(addr).name} won <b>+${fmtAmt(String(net))} $SWOGE</b> 🐕\n` +
            `Stake ${fmtAmt(String(staked))} · returned ${fmtAmt(String(payout))}` +
            (note ? ` · ${note}` : ''));
}

/* Le robinet de developpement ne s'ouvre QUE sur un serveur sans chaine. Un
   serveur de production a forcement un coffre ou un signataire ; s'il en a un,
   la variable d'environnement ne suffit plus. */
const FAUCET_OK = process.env.DEV_FAUCET === '1' && !cfg.VAULT_ADDRESS && !cfg.SIGNER_PRIVATE_KEY;
if (process.env.DEV_FAUCET === '1' && !FAUCET_OK)
  console.warn('[secu] DEV_FAUCET=1 IGNORE : un coffre ou un signataire est configure, l argent est reel.');
if (FAUCET_OK)
  console.warn('[secu] DEV_FAUCET=1 ACTIF : n importe qui peut se crediter 1000 $SWOGE. A ne jamais laisser en production.');

/**
 * Ce qu'un client recoit une fois identifie. Une seule definition pour la
 * connexion par signature ET pour la reprise de session : deux charges
 * distinctes finiraient par diverger, et la page reprise aurait un ecran
 * different de la page connectee.
 */
function charge(ws, rec, extra) {
  return Object.assign({
    type: 'auth', address: rec, balance: game.balanceStr(rec),
    fairness: game.fairness(rec), quests: game.questState(rec),
    stake: game.stakeInfo(rec), bj: game.bjState(rec),
    casino: game.casinoState(rec), hilo: game.hiloState(rec), mines: game.minesState(rec),
    casinoPay: require('./casino').PAY,
    casinoMin: cfg.CASINO_MIN_BET, casinoMax: cfg.CASINO_MAX_BET,
    hiloEdgeBps: cfg.HILO_EDGE_BPS,
    minesEdgeBps: cfg.MINES_EDGE_BPS, minesDefaut: cfg.MINES_DEFAUT,
    minesChoix: cfg.MINES_CHOIX, minesBareme: game.minesBareme(),
    plinkoBaremes: game.plinkoBaremes(), plinkoRangees: cfg.PLINKO_RANGEES,
    plinkoRisque: cfg.PLINKO_RISQUE, plinkoEdgeBps: cfg.PLINKO_EDGE_BPS,
    // La manche du Crash est en cours quoi qu'il arrive : un joueur qui se
    // connecte a la 4e seconde doit voir la courbe la ou elle en est, pas un
    // ecran vide jusqu'a la manche suivante.
    crash: game.crashEtat(Date.now(), rec),
    volcano: { meter: game.volcanoMeterOf(rec) }, bonus: game.bonusState(rec),
    // le jeton qui evite de resigner a la page suivante
    session: session.emettre(game.sessionSecret, rec, cfg.SESSION_TTL_SEC),
    sessionTtl: cfg.SESSION_TTL_SEC,
  }, extra || {});
}

/** Rattache une socket a un joueur. Meme chemin pour les deux facons d'entrer. */
function attacher(ws, rec) {
  ws.addr = rec;
  if (!byAddr.has(rec)) byAddr.set(rec, new Set());
  byAddr.get(rec).add(ws);
}

const clients = new Set();                 // all sockets
const byAddr = new Map();                  // addr -> Set(sockets)

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toAddr(addr, obj) { const set = byAddr.get(addr); if (set) for (const ws of set) send(ws, obj); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === 1) ws.send(s); }

/**
 * Un encaissement au Crash part a tout le monde — c'est ce qui fait le sel du
 * jeu : on voit les autres sortir pendant qu'on tient. Le SOLDE, lui, ne
 * regarde que son proprietaire, donc il ne voyage que vers lui.
 */
function crashDiffuse(ev) {
  const { balance, ...publique } = ev;
  broadcast({ ...publique, name: game._p(ev.addr).name });
  toAddr(ev.addr, { type: 'crashRetrait', ...ev, moi: true });
  notifyTableWin(ev.addr, 'crash', { net: ev.net, staked: ev.mise, payout: ev.payout,
                                     note: `${ev.multi.toFixed(2)}× cash out` });
}


/* ---- connect 4 ----
 * Une partie n'interesse que ses deux joueurs : on pousse l'etat aux DEUX, pas
 * a tout le monde. Le vestibule, lui, est public — c'est ce qui permet de
 * trouver une table.
 */
function p4Pousse(partie, reglement) {
  const etat = game.p4Etat(partie.id, Date.now());
  for (const a of partie.joueurs) {
    if (!a) continue;
    toAddr(a, { type: 'p4Match', match: etat, balance: game.balanceStr(a),
                reglement: reglement || null });
  }
  if (reglement && partie.gagnant) {
    const gagnant = partie.adresseGagnante();
    notifyTableWin(gagnant, 'p4', { net: reglement.gain - partie.mise,
      staked: partie.mise, payout: reglement.gain,
      note: `beat ${game._p(partie.joueurs[partie.gagnant === 1 ? 1 : 0]).name}` });
  }
}
function p4DiffuseLobby() { broadcast({ type: 'p4Lobby', tables: game.p4Lobby() }); }

/*
 * Le morpion et les dames parlent le MEME protocole que le Connect 4, sous
 * d'autres noms de messages. Deux raisons de ne pas avoir simplement ajoute
 * un champ aux messages `p4*` : la page du Connect 4 est deja en service et
 * lit `tables` sans regarder de quel jeu il s'agit — elle afficherait les
 * tables de morpion —, et un vestibule par jeu est de toute facon ce que
 * chaque page veut.
 */
const NOM_DUEL = { p4: 'Connect 4', mp: 'Tic-Tac-Toe', dm: 'Checkers' };
function duelPousse(partie, reglement) {
  const etat = game.duelEtat(partie.id, Date.now());
  for (const a of partie.joueurs) {
    if (!a) continue;
    toAddr(a, { type: 'duelMatch', match: etat, balance: game.balanceStr(a),
                reglement: reglement || null });
  }
  if (reglement && partie.gagnant) {
    const gagnant = partie.adresseGagnante();
    notifyTableWin(gagnant, partie.jeu || 'p4', { net: reglement.gain - partie.mise,
      staked: partie.mise, payout: reglement.gain,
      note: `beat ${game._p(partie.joueurs[partie.gagnant === 1 ? 1 : 0]).name}` });
  }
}
function duelDiffuseLobby(jeu) {
  broadcast({ type: 'duelLobby', jeu, tables: game.duelLobby(jeu) });
}
function duelPousseInvites(addr, jeu) {
  toAddr(addr, { type: 'duelInvites', jeu, invites: game.duelInvitations(addr, Date.now(), jeu) });
}
/* Les revanches sont nominatives : elles ne passent pas par le vestibule
   public, il faut donc les pousser a la personne concernee. */
function p4PousseInvites(addr) {
  toAddr(addr, { type: 'p4Invites', invites: game.p4Invitations(addr, Date.now()) });
}

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
  /* L'image d'un joueur. Publique : elle s'affiche deja a la table, la cacher
     derriere une cle n'apporterait rien. Le cache du navigateur evite de la
     redemander a chaque manche. */
  if (path.startsWith('/avatar/')) {
    const a = path.slice('/avatar/'.length).toLowerCase();
    const img = avatars.lit(a);
    if (!img) { res.writeHead(404); return res.end('no avatar'); }
    res.writeHead(200, { 'content-type': img.mime, 'content-length': img.corps.length,
                         'cache-control': 'public, max-age=300',
                         'access-control-allow-origin': '*' });
    return res.end(img.corps);
  }
  /* Retirer l'image d'un joueur — reserve a l'administration : c'est la seule
     reponse possible si quelqu'un met devant les autres joueurs une image qui
     n'a rien a y faire. */
  if (path === '/avatar-remove') {
    if (!authed) { res.writeHead(401); return res.end('unauthorized'); }
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const a = String(qs.get('addr') || '').toLowerCase();
    const fait = avatars.supprime(a);
    if (fait) { const p = game.players.get(a); if (p) p.photo = false; persistSoon(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ removed: fait }));
  }
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
/* Une limite de charge explicite. Par defaut `ws` accepte cent megaoctets par
   message : n'importe qui pouvait faire allouer cent megaoctets au serveur
   avec un seul envoi. Deux cent cinquante-six kilo-octets couvrent largement
   le plus gros message legitime — une photo de profil de 32 Ko encodee. */
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

/* ---- battement de coeur ----
 * Une connexion WebSocket qui ne dit rien pendant plusieurs minutes est
 * fermee par les intermediaires (Railway, proxys mobiles, box). La plupart
 * des jeux parlent sans arret, mais pas le Connect 4 : entre deux coups il
 * peut s'ecouler quarante-cinq secondes de silence complet, et une table qui
 * attend un adversaire ne dit rien du tout. Le joueur se retrouvait alors
 * deconnecte en pleine partie et on lui redemandait son portefeuille.
 *
 * Le ping est celui du PROTOCOLE, pas un message applicatif : le navigateur y
 * repond tout seul, sans une ligne cote client, et rien n'apparait dans le
 * jeu. Un client qui ne repond pas a deux tours est ferme franchement plutot
 * que laisse en zombie.
 */
/* ---- combien de monde ----
 * `enLigne` compte les JOUEURS identifies, pas les sockets : un joueur qui a
 * la page ouverte dans deux onglets reste un joueur, et un visiteur qui n'a
 * pas encore signe n'en est pas un. `total` est le nombre de comptes jamais
 * crees. Les deux chiffres partent ensemble parce qu'ils ne se lisent bien
 * qu'ensemble : « 7 en ligne » ne dit rien sans « sur 1 240 ».
 */
function compte() {
  let enLigne = 0;
  for (const set of byAddr.values()) {
    for (const ws of set) if (ws.readyState === 1) { enLigne++; break; }
  }
  return { type: 'joueurs', enLigne, total: game.players.size };
}
/* Une diffusion groupee : dix connexions en une seconde ne doivent pas
   declencher dix messages a tout le monde. */
let compteT = null;
function diffuseCompte() {
  if (compteT) return;
  compteT = setTimeout(() => { compteT = null; broadcast(compte()); }, 1200);
}
// et un rappel regulier, pour les onglets ouverts depuis longtemps
const compteInterval = setInterval(() => broadcast(compte()), 60000);

const PING_MS = 25000;
const battement = setInterval(() => {
  for (const ws of clients) {
    if (ws.vivant === false) { try { ws.terminate(); } catch (e) {} continue; }
    ws.vivant = false;
    try { ws.ping(); } catch (e) {}
  }
}, PING_MS);

wss.on('connection', (ws) => {
  ws.addr = null;
  ws.vivant = true;
  ws.on('pong', () => { ws.vivant = true; });
  ws.nonce = crypto.randomBytes(16).toString('hex'); // login challenge
  clients.add(ws);
  send(ws, {
    type: 'hello',
    loginNonce: ws.nonce,
    serverSeedHash: game.serverSeedHash,
    dropCost: cfg.DROP_COST, minWithdraw: cfg.MIN_WITHDRAW,
    vault: cfg.VAULT_ADDRESS || null, token: cfg.SWOGE_TOKEN, chainId: cfg.CHAIN_ID,
    jackpot: game.jackpotStr(), leaderboard: game.leaderboard(cfg.LEADERBOARD_SIZE),
    joueurs: compte(),
    // l'explorateur, pour que l'historique puisse pointer vers la transaction
    explorer: cfg.EXPLORER,
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
        attacher(ws, rec); diffuseCompte();
        if (m.name) game.setName(rec, m.name);
        if (m.tgId) game.linkTelegram(rec, m.tgId); // map Telegram id → account for the Adsgram reward postback
        /* Nouveau joueur ? On regarde AVANT d'accorder le bonus : `grantWelcome`
           rend 0 aussi bien pour un habitue que pour un nouveau venu le jour ou
           le bonus vaudrait zero. La question posee est « est-ce sa premiere
           arrivee », pas « a-t-il touche quelque chose ». */
        const nouveau = !game._p(rec).welcomeGranted;
        const welcome = game.grantWelcome(rec);      // one-time demo credit for a brand-new player
        if (welcome > 0) persistSoon();
        if (nouveau && cfg.NOTIFY_NEW_PLAYER) {
          const n = game.players.size;
          tg.notifyPhoto(cfg.NEW_PLAYER_IMAGE,
            `🐕 <b>New swoler</b>\n${game._p(rec).name} just joined the gym\n` +
            `That makes <b>${n.toLocaleString('en-US')}</b> player${n > 1 ? 's' : ''} on $SWOGE`);
        }
        return send(ws, charge(ws, rec, { welcomeGranted: welcome }));
      }

      /* Reprise de session : le jeton remplace la signature. C'est ce qui evite
         de refaire tout le chemin de connexion a chaque changement de page —
         telecharger le SDK, reveiller la session distante, resigner. Un jeton
         faux, perime ou bricole est simplement refuse, et la page retombe sur
         la connexion normale. */
      if (m.type === 'resume') {
        const rec = session.lire(game.sessionSecret, m.token);
        if (!rec) return send(ws, { type: 'resumeFailed' });
        attacher(ws, rec); diffuseCompte();
        if (m.tgId) game.linkTelegram(rec, m.tgId);
        return send(ws, charge(ws, rec, { resumed: true }));
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
        notifyTableWin(ws.addr, 'smash', { net: r.payout - r.bet, staked: r.bet,
                                           payout: r.payout, note: `${r.mult}×` });
        return send(ws, { type: 'spinResult', mult: r.mult, payout: r.payout, bet: r.bet, balance: game.balanceStr(ws.addr), fairness: game.fairness(ws.addr) });
      }
      if (m.type === 'volcanoSpin' || m.type === 'volcanoBuyBonus') {
        // SWOGE Spin (Volcano). Server-authoritative, provably fair, RTP ~70%.
        // Shares the same balance as every other game.
        try {
          const r = m.type === 'volcanoSpin' ? game.volcanoSpin(ws.addr, m.bet) : game.volcanoBuyBonus(ws.addr, m.bet);
          if (r.error) return send(ws, { type: 'need_deposit', balance: game.balanceStr(ws.addr) });
          persistSoon();
          notifyTableWin(ws.addr, 'spin', { net: r.payout - r.bet, staked: r.bet, payout: r.payout });
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
          /* La mise engagee vaut le double quand la main a ete doublee : sans
             ca l'annonce compterait la seconde mise comme du benefice. */
          if (st.stage === 'done') {
            const engage = st.doubled ? st.bet * 2 : st.bet;
            notifyTableWin(ws.addr, 'bj', { net: st.payout - engage, staked: engage,
                                            payout: st.payout, note: st.result });
          }
          send(ws, { type: 'bj', state: st });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      /* Robinet de developpement : 1000 $SWOGE a la demande, sans limite.
         C'est exactement ce dont un joueur a besoin pour "gagner a tous les
         coups", et il ne tenait qu'a une variable d'environnement. Il est
         desormais IMPOSSIBLE de l'ouvrir sur un serveur relie a la chaine :
         des qu'un coffre ou un signataire est configure, l'argent est reel et
         le robinet reste ferme quoi que dise DEV_FAUCET. */
      if (m.type === 'devCredit') {
        if (!FAUCET_OK) return send(ws, { type: 'error', error: 'disabled' });
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
      /* L'historique du joueur. On rend une PAGE, pas tout : un joueur de la
         premiere heure a des dizaines de milliers de manches, et les lui
         envoyer d'un bloc bloquerait sa page comme le serveur. Le curseur est
         un horodatage — « ce qui precede cet instant » — plutot qu'un numero
         de page : rien ne se decale si une manche se termine entre deux
         demandes. */
      /* ---- profil : nom, visage, amis, virement ---- */
      if (m.type === 'setProfile') {
        try {
          const out = { type: 'profile' };
          if (m.name !== undefined) out.name = game.setPublicName(ws.addr, m.name);
          if (m.avatar !== undefined) out.avatar = game.setVisage(ws.addr, m.avatar);
          persistSoon();
          out.profile = game.profilPublic(ws.addr);
          out.avatars = require('./game').Game.VISAGES;
          send(ws, out);
          /* Le nom s'affiche chez les AUTRES : les tables partagees doivent le
             reprendre tout de suite, sinon un joueur se renomme et reste
             affiche sous l'ancien nom jusqu'a la manche suivante. */
          broadcast({ type: 'profilePublic', profile: game.profilPublic(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'profile') {
        return send(ws, { type: 'profile', profile: game.profilPublic(ws.addr),
                          avatars: require('./game').Game.VISAGES,
                          friends: game.amis(ws.addr),
                          pending: game.amisEnAttente(ws.addr),
                          unread: game.transfertsNonLus(ws.addr),
                          stats: game.stats(ws.addr) });
      }
      /* Le parrainage. Le lien s'attache une fois pour la vie ; le reste
         n'est que de la lecture et un encaissement. */
      if (m.type === 'referral') {
        if (m.bind) {
          try {
            const r = game.lieParrain(ws.addr, m.bind);
            persistSoon();
            /* Le parrain doit VOIR arriver son filleul : c'est la seule
               recompense immediate d'un lien partage, le reste vient plus
               tard et par petits bouts. */
            toAddr(r.parrain, { type: 'referral', ...game.parrainage(r.parrain),
                                nouveau: game._p(ws.addr).name });
          } catch (e) { return send(ws, { type: 'referral', ...game.parrainage(ws.addr), error: e.message }); }
        }
        return send(ws, { type: 'referral', ...game.parrainage(ws.addr) });
      }
      /* Le classement du mois : qui a fait tourner le plus de volume. */
      if (m.type === 'leaderboard') {
        return send(ws, { type: 'leaderboard', ...game.classementMois(ws.addr, 50) });
      }
      if (m.type === 'referralClaim') {
        try {
          const r = game.reclameParrainage(ws.addr);
          persistSoon();
          return send(ws, { type: 'referralClaimed', ...r, ...game.parrainage(ws.addr) });
        } catch (e) { return send(ws, { type: 'error', error: e.message }); }
      }
      /* Le joueur a regarde ses envois recus : la pastille tombe. */
      if (m.type === 'seenTransfers') {
        game.vuTransferts(ws.addr); persistSoon();
        return send(ws, { type: 'unread', unread: 0 });
      }
      /* La photo de profil televersee. Elle n'est PAS ouverte a tous : elle
         s'affiche chez les autres joueurs, donc on demande d'avoir depose au
         moins une fois — ce qui donne un compte a qui parler si l'image pose
         probleme, et coute assez cher pour decourager le jetable. */
      if (m.type === 'avatarUpload') {
        try {
          if (cfg.AVATAR_REQUIRE_DEPOSIT && !game._p(ws.addr).hasDeposited)
            throw new Error('deposit once to upload your own picture');
          const r = avatars.enregistre(ws.addr, m.data);
          game._p(ws.addr).photo = true;
          persistSoon();
          send(ws, { type: 'profile', profile: game.profilPublic(ws.addr),
                     avatars: require('./game').Game.VISAGES, uploaded: r.octets });
          broadcast({ type: 'profilePublic', profile: game.profilPublic(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'avatarRemove') {
        avatars.supprime(ws.addr);
        game._p(ws.addr).photo = false;
        persistSoon();
        send(ws, { type: 'profile', profile: game.profilPublic(ws.addr),
                   avatars: require('./game').Game.VISAGES });
        broadcast({ type: 'profilePublic', profile: game.profilPublic(ws.addr) });
        return;
      }
      if (m.type === 'friendSearch') {
        return send(ws, { type: 'friendSearch', q: m.q || '',
                          results: game.chercheJoueurs(m.q, ws.addr, 8) });
      }
      if (m.type === 'friendRequest' || m.type === 'friendAccept' ||
          m.type === 'friendDecline' || m.type === 'friendRemove') {
        try {
          let etat, autre = null;
          if (m.type === 'friendRequest') { const r = game.amiDemande(ws.addr, m.address); etat = r.etat; autre = r.vers; }
          else if (m.type === 'friendAccept') { const r = game.amiAccepte(ws.addr, m.address); etat = r.etat; autre = r.avec; }
          else if (m.type === 'friendDecline') etat = game.amiRefuse(ws.addr, m.address);
          else etat = game.amiRetire(ws.addr, m.address);
          persistSoon();
          send(ws, { type: 'friends', friends: etat, pending: game.amisEnAttente(ws.addr) });
          /* L'autre doit voir la demande arriver SANS recharger : c'est tout
             l'interet d'une pastille de notification. */
          if (autre) toAddr(autre, { type: 'friends', friends: game.amis(autre),
                                     pending: game.amisEnAttente(autre),
                                     nouvelle: m.type === 'friendRequest' ? game._p(ws.addr).name : null });
          if (m.type === 'friendRemove' && m.address)
            toAddr(String(m.address).toLowerCase(), { type: 'friends',
              friends: game.amis(String(m.address).toLowerCase()),
              pending: game.amisEnAttente(String(m.address).toLowerCase()) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'transfer') {
        try {
          const r = game.transfere(ws.addr, m.address, m.amount);
          persistSoon();
          send(ws, { type: 'transferSent', ...r, balance: game.balanceStr(ws.addr) });
          // le destinataire voit son solde monter sans avoir a recharger
          toAddr(r.vers, { type: 'transferGot', amount: r.montant,
                           from: ws.addr, fromName: game._p(ws.addr).name,
                           unread: game.transfertsNonLus(r.vers),
                           balance: game.balanceStr(r.vers) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'history') {
        const genres = { dep: 'dep', wd: 'wd', r: 'r', st: 'st', tr: 'tr' };
        const r = journal.lit(ws.addr, {
          genre: genres[m.kind] || null,
          /* `m.cursor` absent vaut « depuis la fin ». Attention : Number(null)
             rend 0, et 0 est une position VALIDE — le debut du fichier. Sans
             le test d'existence, une premiere demande sans curseur lisait
             « tout ce qui precede l'octet 0 », c'est-a-dire rien. */
          curseur: (m.cursor === null || m.cursor === undefined || !Number.isFinite(Number(m.cursor)))
            ? null : Number(m.cursor),
          limite: Number(m.limit) || 25,
        });
        return send(ws, { type: 'history', kind: m.kind || 'all',
                          items: r.evenements, cursor: r.curseur, more: r.encore,
                          summary: journal.resume(ws.addr) });
      }

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
          // Une main peut se conclure des la donne (Pair Plus / bonus AA paye
          // alors que le joueur se couche) : le gain doit s'annoncer ici aussi.
          if (st.stage === 'done' && st.result) notifyTableWin(ws.addr, st.game, st.result);
          send(ws, { type: 'casino', state: st, balance: game.balanceStr(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'casinoDecide') {
        try {
          const st = game.casinoDecide(ws.addr, !!m.play);
          persistSoon();
          if (st.result) notifyTableWin(ws.addr, st.game, st.result);
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
          // Le multiplicateur atteint est ce qui rend l'annonce interessante :
          // «+3000» dit combien, «x16.20 en 4 pas» dit comment.
          notifyTableWin(ws.addr, 'hilo', { net: st.net, staked: st.mise, payout: st.payout,
                                            note: `${st.multi.toFixed(2)}× in ${st.pas} step${st.pas > 1 ? 's' : ''}` });
          send(ws, { type: 'hilo', state: st, balance: game.balanceStr(ws.addr),
                     fairness: game.fairness(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }

      // ---- mines ----
      if (m.type === 'minesState') return send(ws, { type: 'mines', state: game.minesState(ws.addr) });
      if (m.type === 'minesStart') {
        try {
          const st = game.minesStart(ws.addr, m.bet, m.mines);
          persistSoon();
          send(ws, { type: 'mines', state: st, balance: game.balanceStr(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'minesPick') {
        try {
          const st = game.minesPick(ws.addr, m.pos);
          persistSoon();
          send(ws, { type: 'mines', state: st, balance: game.balanceStr(ws.addr),
                     fairness: game.fairness(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'minesCashOut') {
        try {
          const st = game.minesCashOut(ws.addr);
          persistSoon();
          // le nombre de bombes et de cases dit tout du risque pris
          notifyTableWin(ws.addr, 'mines', { net: st.net, staked: st.mise, payout: st.payout,
                                             note: `${st.multi.toFixed(2)}× on ${st.ouvertes.length} tile${st.ouvertes.length > 1 ? 's' : ''}, ${st.nbMines} mine${st.nbMines > 1 ? 's' : ''}` });
          send(ws, { type: 'mines', state: st, balance: game.balanceStr(ws.addr),
                     fairness: game.fairness(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }

      // ---- plinko ----
      if (m.type === 'plinkoDrop') {
        try {
          const r = game.plinkoDrop(ws.addr, m.bet, m.rows, m.risk);
          persistSoon();
          notifyTableWin(ws.addr, 'plinko', { net: r.net, staked: r.mise, payout: r.payout,
                                              note: `${r.multi.toFixed(2)}× on ${r.rangees} rows, ${r.risque} risk` });
          send(ws, { type: 'plinko', drop: r, balance: game.balanceStr(ws.addr),
                     fairness: game.fairness(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }

      // ---- crash ----
      if (m.type === 'crashBet') {
        try {
          const r = game.crashMise(ws.addr, m.bet, m.auto, Date.now());
          send(ws, { type: 'crashBet', ...r });
          // La table est le spectacle : les autres doivent voir la mise arriver.
          broadcast({ type: 'crashJoueur', addr: ws.addr, name: game._p(ws.addr).name,
                      mise: r.mise, auto: r.auto, manche: r.manche });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'crashCashOut') {
        try {
          const ev = game.crashRetrait(ws.addr, Date.now());
          crashDiffuse(ev);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'crashState') {
        return send(ws, { type: 'crash', ...game.crashEtat(Date.now(), ws.addr) });
      }

      // ---- connect 4 (un contre un) ----
      if (m.type === 'p4Create') {
        try {
          const partie = game.p4Creer(ws.addr, m.bet, Date.now());
          persistSoon();
          // le solde accompagne la reponse : sans lui, le joueur voit sa table
          // creee mais son solde inchange, et croit que la mise n'est pas partie
          send(ws, { type: 'p4Match', match: game.p4Etat(partie.id, Date.now()),
                     balance: game.balanceStr(ws.addr) });
          p4DiffuseLobby();
          /* On previent le canal : une table sans adversaire ne sert a rien, et
             c'est la seule facon qu'un joueur seul trouve quelqu'un. */
          tg.notify(`\u2694\ufe0f <b>Connect 4</b>\n${game._p(ws.addr).name} is waiting for an opponent\n` +
                    `Stake <b>${fmtAmt(String(partie.mise))} $SWOGE</b> \u00b7 winner takes the pot`);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'p4Join') {
        try {
          const partie = game.p4Rejoindre(ws.addr, m.id, Date.now());
          persistSoon();
          p4Pousse(partie);
          p4DiffuseLobby();
          // le solde a pu changer deux fois : la mise part, et une table a soi
          // qu'on abandonne en s'asseyant ici est remboursee
          send(ws, { type: 'balance', balance: game.balanceStr(ws.addr) });
          for (const a of partie.joueurs) if (a) p4PousseInvites(a);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      /* La revanche : une table nominative, adressee au seul adversaire de la
         partie qu'on vient de finir, avec une somme qu'on choisit. */
      if (m.type === 'p4Rematch') {
        try {
          const partie = game.p4Revanche(ws.addr, m.id, m.bet, Date.now());
          persistSoon();
          send(ws, { type: 'p4Match', match: game.p4Etat(partie.id, Date.now()),
                     balance: game.balanceStr(ws.addr) });
          p4PousseInvites(partie.reserve);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'p4Cancel') {
        try {
          const partie = game.p4Annuler(ws.addr, m.id, Date.now());
          persistSoon();
          send(ws, { type: 'p4Match', match: game.p4Etat(partie.id, Date.now()),
                     balance: game.balanceStr(ws.addr) });
          if (partie.reserve) p4PousseInvites(partie.reserve);
          else p4DiffuseLobby();
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'p4Invites') return p4PousseInvites(ws.addr);
      if (m.type === 'p4Play') {
        try {
          const r = game.p4Jouer(ws.addr, m.id, m.col, Date.now());
          if (r.reglement) persistSoon();
          p4Pousse(r.partie, r.reglement);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'p4Resign') {
        try {
          const r = game.p4Abandonner(ws.addr, m.id, Date.now());
          persistSoon();
          p4Pousse(r.partie, r.reglement);
          p4DiffuseLobby();
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'p4Lobby') return send(ws, { type: 'p4Lobby', tables: game.p4Lobby() });
      if (m.type === 'p4State') {
        const mienne = game.p4Mienne(ws.addr);
        const id = m.id || (mienne && mienne.id);
        return send(ws, { type: 'p4Match', match: id ? game.p4Etat(id, Date.now()) : null });
      }

      // ---- morpion et dames (memes regles d'argent que le Connect 4) ----
      if (m.type === 'duelCreate') {
        try {
          const jeu = m.jeu === 'dm' ? 'dm' : 'mp';
          const partie = game.duelCreer(jeu, ws.addr, m.bet, Date.now());
          persistSoon();
          send(ws, { type: 'duelMatch', match: game.duelEtat(partie.id, Date.now()),
                     balance: game.balanceStr(ws.addr) });
          duelDiffuseLobby(jeu);
          tg.notify(`\u2694\ufe0f <b>${NOM_DUEL[jeu]}</b>\n${game._p(ws.addr).name} is waiting for an opponent\n` +
                    `Stake <b>${fmtAmt(String(partie.mise))} $SWOGE</b> \u00b7 winner takes the pot`);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'duelJoin') {
        try {
          const { partie } = game.duelRejoindre(ws.addr, m.id, Date.now());
          persistSoon();
          duelPousse(partie);
          duelDiffuseLobby(partie.jeu);
          send(ws, { type: 'balance', balance: game.balanceStr(ws.addr) });
          for (const a of partie.joueurs) if (a) duelPousseInvites(a, partie.jeu);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'duelRematch') {
        try {
          const partie = game.duelRevanche(ws.addr, m.id, m.bet, Date.now());
          persistSoon();
          send(ws, { type: 'duelMatch', match: game.duelEtat(partie.id, Date.now()),
                     balance: game.balanceStr(ws.addr) });
          duelPousseInvites(partie.reserve, partie.jeu);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'duelCancel') {
        try {
          const partie = game.duelAnnuler(ws.addr, m.id, Date.now());
          persistSoon();
          send(ws, { type: 'duelMatch', match: game.duelEtat(partie.id, Date.now()),
                     balance: game.balanceStr(ws.addr) });
          if (partie.reserve) duelPousseInvites(partie.reserve, partie.jeu);
          else duelDiffuseLobby(partie.jeu);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'duelInvites') return duelPousseInvites(ws.addr, m.jeu === 'dm' ? 'dm' : 'mp');
      if (m.type === 'duelPlay') {
        try {
          const r = game.duelJouer(ws.addr, m.id, m.coup, Date.now());
          if (r.reglement) persistSoon();
          duelPousse(r.partie, r.reglement);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'duelResign') {
        try {
          const r = game.duelAbandonner(ws.addr, m.id, Date.now());
          persistSoon();
          duelPousse(r.partie, r.reglement);
          duelDiffuseLobby(r.partie.jeu);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'duelLobby') {
        const jeu = m.jeu === 'dm' ? 'dm' : 'mp';
        return send(ws, { type: 'duelLobby', jeu, tables: game.duelLobby(jeu) });
      }
      if (m.type === 'duelState') {
        const mienne = game.duelMienne(ws.addr);
        const id = m.id || (mienne && mienne.id);
        return send(ws, { type: 'duelMatch', match: id ? game.duelEtat(id, Date.now()) : null });
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
        diffuseCompte();          // un joueur de moins a l'ecran
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
      // le Pusher aussi montre sa table : c'est le seul gain qui n'y passait pas
      if (w.value >= cfg.NOTIFY_WIN_MIN)
        tg.notifyPhoto(imageJeu('pusher'), `🏆 <b>Coin Pusher</b>\n${w.ownerName} just won <b>${w.value} $SWOGE</b> 🐕`);
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

/* ---- crash : la manche partagee ----
 * 100 ms suffisent, et ce n'est PAS un compromis sur l'equite : un retrait
 * automatique est paye au multiplicateur de sa cible, pas a celui du tick qui
 * le remarque. La cadence ne joue que sur le delai d'affichage. La courbe, elle,
 * n'est jamais diffusee : le navigateur la calcule depuis l'heure de depart. */
/* Les echeances du Connect 4 : le coup, et la table qui n'a jamais trouve
   preneur. Une seconde suffit — l'echeance exacte est envoyee au navigateur,
   qui affiche le decompte lui-meme. */
const p4Interval = setInterval(() => {
  try {
    const evs = game.p4Tick(Date.now());
    if (!evs.length) return;
    persistSoon();
    const jeux = new Set();
    for (const e of evs) {
      const jeu = e.partie.jeu || 'p4';
      jeux.add(jeu);
      if (jeu === 'p4') p4Pousse(e.partie, e.reglement || null);
      else duelPousse(e.partie, e.reglement || null);
      if (e.type === 'p4Expire') {
        for (const a of e.partie.joueurs)
          if (a) toAddr(a, { type: jeu === 'p4' ? 'p4Expire' : 'duelExpire',
                             id: e.partie.id, balance: game.balanceStr(a) });
        // une revanche qui expire doit disparaitre de l'ecran de celui a qui
        // elle etait adressee, pas seulement de celui qui l'avait envoyee
        if (e.partie.reserve) {
          if (jeu === 'p4') p4PousseInvites(e.partie.reserve);
          else duelPousseInvites(e.partie.reserve, jeu);
        }
      }
    }
    p4DiffuseLobby();
    for (const j of jeux) if (j !== 'p4') duelDiffuseLobby(j);
  } catch (e) { console.warn('[p4]', e && e.message); }
}, 1000);

const crashInterval = setInterval(() => {
  try {
    for (const ev of game.crashTick(Date.now())) {
      if (ev.type === 'crashRetrait') { crashDiffuse(ev); continue; }
      broadcast(ev);
      if (ev.type === 'crashFin') {
        // Chaque perdant apprend son solde : il a ete debite a la mise, mais
        // c'est maintenant que la manche est finie pour lui.
        for (const addr of ev.perdants)
          toAddr(addr, { type: 'crashPerdu', manche: ev.manche, point: ev.point,
                         balance: game.balanceStr(addr) });
      }
    }
  } catch (e) { console.warn('[crash]', e && e.message); }
}, 100);

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
  clearInterval(stepInterval); clearInterval(bcInterval); clearInterval(metaInterval); clearInterval(saveInterval); clearInterval(pokerInterval); clearInterval(crashInterval); clearInterval(p4Interval); clearInterval(battement); clearInterval(compteInterval);
  persist(); // final save so nothing is lost on redeploy
  /* Le journal ecrit en differe pour ne pas ouvrir mille descripteurs : ce
     qui attend encore doit partir maintenant, sinon les dernieres manches
     jouees avant un redeploiement n'auront jamais existe. */
  journal.draine(() => { server.close(); process.exit(0); }, 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
