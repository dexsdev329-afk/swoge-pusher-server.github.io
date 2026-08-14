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
const fs = require('fs');
const zlib = require('zlib');
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
/* La sauvegarde courante n'ecrit que ce qui a bouge ; elle glisse l'instantane
   complet toutes les cinq minutes. Voir fragments.js pour la mesure qui a
   motive le decoupage. */
function persist() { store.sauveVite(game); }
/* L'instantane COMPLET, tout de suite : avant un export, avant un import, et
   a l'arret. On ne telecharge pas un fichier vieux de cinq minutes. */
function persistComplet() { return store.save(game.serialize()); }
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
if (!cfg.TG_BACKUP_CHAT_ID && !cfg.TG_CHAT_ID)
  console.warn('[secu] aucun canal Telegram : AUCUNE sauvegarde ne quitte cette machine.\n' +
               '       state.json et son .bak sont sur le meme volume — si ce volume disparait,\n' +
               '       tous les soldes disparaissent avec lui.');
if (!cfg.ADMIN_KEY)
  console.warn('[secu] ADMIN_KEY absente : /admin, /players, /stats, /audit, /repare et /burn sont FERMES.\n' +
               '       Posez ADMIN_KEY dans les variables d environnement pour les ouvrir.');

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
    stake: game.stakeInfo(rec), bj: game.bjState(rec), niveau: game.niveau(rec),
    casino: game.casinoState(rec), hilo: game.hiloState(rec), mines: game.minesState(rec),
    casinoPay: require('./casino').PAY,
    casinoMin: cfg.CASINO_MIN_BET, casinoMax: cfg.CASINO_MAX_BET,
    /* Les bornes du blackjack partent AVEC l'etat, comme celles du casino. La
       page les cadenassait en dur a quatre endroits : changer la limite
       demandait deux depots au lieu d'une variable. */
    bjMin: cfg.BJ_MIN_BET, bjMax: cfg.BJ_MAX_BET,
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

/* ------------------------------------------------------- le debit d'entree
 *
 * Une socket peut envoyer aussi vite que le reseau le permet, et rien ne l'en
 * empechait : le seul garde-fou etait la TAILLE d'un message, pas leur
 * nombre. Or Node n'a qu'un fil d'execution — quelques centaines de messages
 * par seconde suffisent a ne plus servir personne, et trois lignes dans une
 * console de navigateur suffisent a les envoyer.
 *
 * Un seau a jetons : vingt messages par seconde en regime, quarante en
 * reserve pour les rafales normales — cliquer vite au Plinko, poser dix
 * jetons d'affilee. Au-dela on ignore ; tres au-dela on ferme, parce qu'a ce
 * stade ce n'est plus un joueur presse.
 */
const DEBIT_PAR_SEC = parseInt(process.env.DEBIT_PAR_SEC || '20', 10);
const DEBIT_RESERVE = parseInt(process.env.DEBIT_RESERVE || '40', 10);
const DEBIT_ROMPT = 400;               // messages refuses avant de fermer

function autorise(ws) {
  const t = Date.now();
  if (ws.jetons === undefined) { ws.jetons = DEBIT_RESERVE; ws.jetonsT = t; ws.refuses = 0; }
  ws.jetons = Math.min(DEBIT_RESERVE, ws.jetons + ((t - ws.jetonsT) / 1000) * DEBIT_PAR_SEC);
  ws.jetonsT = t;
  if (ws.jetons < 1) {
    ws.refuses++;
    /* On le dit UNE FOIS : un message d'erreur par message refuse doublerait
       le trafic qu'on essaie justement de reduire. */
    if (ws.refuses === 1) send(ws, { type: 'error', error: 'slow down' });
    if (ws.refuses > DEBIT_ROMPT) { try { ws.close(1008, 'too many messages'); } catch (e) {} }
    return false;
  }
  ws.jetons -= 1;
  if (ws.refuses) ws.refuses = 0;
  return true;
}

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
/* La fin d'une partie : « finie » se lit au meme endroit pour les trois
   jeux, c'est le module du Connect 4 qui porte les phases. */
const DUEL_FINIE = require('./puissance4').FINIE;

function p4Pousse(partie, reglement) {
  const etat = game.p4Etat(partie.id, Date.now());
  for (const a of partie.joueurs) {
    if (!a) continue;
    toAddr(a, { type: 'p4Match', match: etat, balance: game.balanceStr(a),
                reglement: reglement || null });
  }
  /* Le Connect 4 a son propre chemin de diffusion : sans cette ligne il
     apparaitrait bien dans la liste des parties en cours, mais le plateau du
     spectateur se figerait a l'instant ou il commence a regarder. Ni solde ni
     reglement : ce n'est pas son argent. */
  duelSpectateurs(partie.id, { type: 'duelWatch', match: etat, fini: partie.phase === DUEL_FINIE });
  /* Une partie terminee doit SORTIR de la liste des parties en cours. Sans
     ca elle y reste jusqu'a ce qu'un autre evenement rafraichisse le
     vestibule, et on propose de regarder une partie deja jouee. */
  if (partie.phase === DUEL_FINIE) diffuseTousDuels();
  if (reglement && partie.gagnant) {
    const gagnant = partie.adresseGagnante();
    notifyTableWin(gagnant, 'p4', { net: reglement.gain - partie.mise,
      staked: partie.mise, payout: reglement.gain,
      note: `beat ${game._p(partie.joueurs[partie.gagnant === 1 ? 1 : 0]).name}` });
  }
}
function p4DiffuseLobby() {
  broadcast({ type: 'p4Lobby', tables: game.p4Lobby() });
  diffuseTousDuels();
}

/*
 * TOUTES les tables qui attendent un adversaire, jeux confondus.
 *
 * Le vestibule de chaque page ne montre que son propre jeu — c'est ce qu'on
 * veut quand on est deja sur une page. Mais une table ouverte au morpion
 * n'est vue par personne tant que quelqu'un n'ouvre pas la page du morpion,
 * et une table que personne ne voit ne trouve pas d'adversaire. Ce flux-la
 * part a tout le monde, sur toutes les pages.
 */
/* Les tables qui ATTENDENT, et celles qui SE JOUENT. A quatre heures du
   matin la premiere liste est vide et la seconde ne l'est pas forcement :
   une bulle qui ne montrerait que l'attente ferait paraitre le site mort
   alors qu'une partie est en cours. */
function tousDuels() {
  return { type: 'duelsTous', tables: game.duelLobby(null), enCours: game.duelsEnCours(null) };
}
function diffuseTousDuels() { broadcast(tousDuels()); }

/*
 * Le morpion et les dames parlent le MEME protocole que le Connect 4, sous
 * d'autres noms de messages. Deux raisons de ne pas avoir simplement ajoute
 * un champ aux messages `p4*` : la page du Connect 4 est deja en service et
 * lit `tables` sans regarder de quel jeu il s'agit — elle afficherait les
 * tables de morpion —, et un vestibule par jeu est de toute facon ce que
 * chaque page veut.
 */
const NOM_DUEL = { p4: 'Connect 4', mp: 'Tic-Tac-Toe', dm: 'Checkers' };
/* Les sockets qui REGARDENT une partie sans y jouer. Un spectateur n'existe
   pas pour la partie : il ne mise pas, ne joue pas, et sa presence ne change
   rien au deroulement. Il recoit simplement le meme etat que les joueurs. */
function duelSpectateurs(id, msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients)
    if (ws.duelWatch === id && ws.readyState === 1) ws.send(s);
}

/* Une phrase dite a la table part aux DEUX joueurs et a ceux qui regardent :
   c'est ce qui fait qu'on joue contre une personne et non contre un serveur.
   Elle ne part jamais a qui a coupe le son. */
function duelDiffusePhrase(partie, dit) {
  const msg = { type: 'duelDit', match: partie.id, joueur: dit.joueur, id: dit.id,
                emote: dit.emote, texte: dit.texte, nom: dit.nom };
  const s = JSON.stringify(msg);
  const orateur = partie.joueurs[dit.joueur - 1];
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    /* Couper le son, c'est faire taire l'AUTRE. Celui qui parle voit toujours
       ce qu'il vient de dire, sans quoi il croirait que rien n'est parti. */
    if (ws.duelMute && ws.addr !== orateur) continue;
    const joue = ws.addr && partie.joueurs.indexOf(ws.addr) >= 0;
    if (joue || ws.duelWatch === partie.id) ws.send(s);
  }
}

function duelPousse(partie, reglement) {
  const etat = game.duelEtat(partie.id, Date.now());
  for (const a of partie.joueurs) {
    if (!a) continue;
    toAddr(a, { type: 'duelMatch', match: etat, balance: game.balanceStr(a),
                reglement: reglement || null });
  }
  /* Le spectateur ne recoit NI solde NI reglement : ce n'est pas son argent,
     et lui envoyer un solde le ferait afficher a la place du sien. */
  duelSpectateurs(partie.id, { type: 'duelWatch', match: etat, fini: partie.phase === DUEL_FINIE });
  if (partie.phase === DUEL_FINIE) diffuseTousDuels();
  if (reglement && partie.gagnant) {
    const gagnant = partie.adresseGagnante();
    notifyTableWin(gagnant, partie.jeu || 'p4', { net: reglement.gain - partie.mise,
      staked: partie.mise, payout: reglement.gain,
      note: `beat ${game._p(partie.joueurs[partie.gagnant === 1 ? 1 : 0]).name}` });
  }
}
function duelDiffuseLobby(jeu) {
  broadcast({ type: 'duelLobby', jeu, tables: game.duelLobby(jeu),
              enCours: game.duelsEnCours(jeu) });
  diffuseTousDuels();
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

/* La comparaison se fait en temps CONSTANT. Comparer deux chaines avec `===`
   s'arrete au premier caractere different : le temps de reponse raconte alors
   combien de caracteres sont justes, et une cle se devine lettre par lettre.
   Le cout est le meme, autant le faire correctement. */
function memeCle(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) { try { crypto.timingSafeEqual(y, y); } catch (e) {} return false; }
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

/* Et on ne laisse pas essayer indefiniment. Une cle de dix caracteres se
   devine en quelques heures a mille essais par seconde ; a dix essais par
   dix minutes, il faut des siecles. */
const essais = new Map();                  // ip -> { n, t }
const ESSAIS_MAX = 10, ESSAIS_FENETRE = 600000;
/* DERRIERE UN PROXY, toutes les requetes arrivent avec l'adresse du proxy.
   Compter dessus reviendrait a bloquer TOUT LE MONDE — le proprietaire
   compris — des qu'un inconnu essaie dix cles. On prend donc l'adresse
   transmise quand il y en a une. Elle est falsifiable, donc contournable :
   c'est assume. Ce qui protege vraiment, c'est la longueur de la cle ; ce
   compteur ne fait que ralentir, et il ne doit surtout pas se retourner
   contre celui qu'il protege. */
function qui(req) {
  const t = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return t || req.socket.remoteAddress || '?';
}
function bloque(req) {
  const ip = qui(req);
  const e = essais.get(ip);
  if (!e) return false;
  if (Date.now() - e.t > ESSAIS_FENETRE) { essais.delete(ip); return false; }
  return e.n >= ESSAIS_MAX;
}
function rate(req, ok) {
  const ip = qui(req);
  if (ok) { essais.delete(ip); return; }
  const e = essais.get(ip);
  if (!e || Date.now() - e.t > ESSAIS_FENETRE) essais.set(ip, { n: 1, t: Date.now() });
  else { e.n++; if (e.n === ESSAIS_MAX) console.warn(`[secu] ${ip} bloque apres ${ESSAIS_MAX} cles admin refusees`); }
}

/**
 * POURQUOI la cle n'est pas vue.
 *
 * « Posez ADMIN_KEY sur le serveur » est un message inutile quand on VIENT de
 * la poser : il ne distingue pas les trois causes reelles, et elles n'appellent
 * pas du tout la meme action.
 *
 *   1. la variable existe chez l'hebergeur mais le process a demarre AVANT
 *      qu'elle soit posee — il faut redeployer, pas re-saisir ;
 *   2. le NOM est approchant — « admin_key », « ADMIN KEY », un espace de fin
 *      colle au collage. Le process ne le trouvera jamais ;
 *   3. la valeur est vide ou n'est que des espaces.
 *
 * On ne rend AUCUNE valeur : seulement des noms qui, une fois normalises,
 * valent ADMINKEY, et l'heure de demarrage du process.
 */
/* Les noms de variables viennent de l'environnement. C'est l'operateur qui les
   pose, donc le risque est mince — mais on les recrache dans une page HTML, et
   « mince » n'est pas une raison de ne pas echapper. */
function ech(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function diagnosticCle() {
  const norme = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const proches = Object.keys(process.env).filter((k) => norme(k) === 'ADMINKEY' && k !== 'ADMIN_KEY');
  const brut = process.env.ADMIN_KEY;
  const minutes = Math.round(process.uptime() / 60);
  const d = { proches, minutes, demarre: new Date(Date.now() - process.uptime() * 1000).toISOString() };
  if (proches.length) {
    d.cause = 'name';
    d.message = 'This process sees a variable named ' + proches.map((k) => JSON.stringify(k)).join(', ') +
      ' but none named exactly ADMIN_KEY. The name must match exactly — check for a lowercase letter, ' +
      'a space, or a trailing character pasted with it.';
  } else if (brut !== undefined) {
    d.cause = 'empty';
    d.message = 'ADMIN_KEY exists but is empty or only whitespace.';
  } else {
    d.cause = 'restart';
    d.message = 'This process has no ADMIN_KEY at all. It started ' + minutes + ' minute(s) ago, at ' +
      d.demarre + '. If you added the variable after that, the service has to be redeployed or ' +
      'restarted — environment variables are read once, when the process boots.';
  }
  return d;
}

/** La reponse a un acces refuse. Elle distingue les deux cas, parce qu'ils
 *  n'appellent pas la meme action : configurer une cle, ou en donner une. */
function refuse(req, res, html) {
  const type = html ? 'text/html' : 'application/json';
  if (!cfg.TG_BACKUP_CHAT_ID && !cfg.TG_CHAT_ID)
    console.warn('[secu] aucun canal Telegram : AUCUNE sauvegarde ne quitte cette machine.\n' +
                 '       state.json et son .bak sont sur le meme volume — si ce volume disparait,\n' +
                 '       tous les soldes disparaissent avec lui.');
  if (!cfg.ADMIN_KEY) {
    const d = diagnosticCle();
    console.warn('[secu] acces admin refuse — ' + d.cause + ' : ' + d.message);
    res.writeHead(503, { 'content-type': type });
    return res.end(html
      ? '<!doctype html><meta charset="utf-8"><title>Dashboard closed</title>' +
        '<style>body{margin:0;background:#070B14;color:#EAF2FF;font:15px/1.6 ui-monospace,Menlo,Consolas,monospace;' +
        'display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}' +
        'main{max-width:620px}h3{color:#FFC53D;font-size:17px;margin:0 0 14px;letter-spacing:.5px}' +
        'p{color:#C3CEE2;margin:0 0 12px}b{color:#EAF2FF}code{background:#111726;border:1px solid #232C42;' +
        'padding:1px 6px;border-radius:4px;color:#FFD97A}small{color:#8494B4}</style>' +
        '<main><h3>503 — this dashboard is closed</h3>' +
        '<p>' + ech(d.message) + '</p>' +
        (d.cause === 'restart'
          ? '<p><b>On Railway:</b> add the variable, then <b>Deploy</b> (or restart the service). ' +
            'Saving a variable alone does not reach a process that is already running.</p>'
          : '') +
        '<p><small>Process started ' + ech(d.demarre) + ' · ' + d.minutes + ' min ago. ' +
        'No value is shown on this page, ever.</small></p></main>'
      : JSON.stringify({ error: 'ADMIN_KEY is not configured on the server', ...d }, null, 2));
  }
  rate(req, false);
  res.writeHead(401, { 'content-type': type });
  return res.end(html
    ? '<h3>401 — add ?key=YOUR_ADMIN_KEY</h3>'
    : JSON.stringify({ error: 'unauthorized' }));
}

/* ==================================================================
 * LA SAUVEGARDE HORS MACHINE
 *
 * state.json et son .bak vivent sur LE MEME volume : cela protege d'une
 * ecriture ratee, de rien d'autre. Si le volume disparait, tous les soldes
 * partent avec lui et il ne reste RIEN pour reconstruire. C'est le seul
 * risque encore ouvert capable de tuer le projet en une soiree.
 *
 * L'archive part donc chez un tiers — le canal Telegram prive du
 * proprietaire — horodatee, telechargeable depuis un telephone, et sans
 * aucune infrastructure a payer ni a maintenir.
 * ================================================================== */
async function sauvegarde(raison) {
  const zlib = require('zlib');
  const fsp = require('fs');
  try {
    /* L'instantane COMPLET : on lit `state.json` juste apres, et les fragments
       seuls le laisseraient vieux de cinq minutes. */
    persistComplet();
    const brut = fsp.readFileSync(store.FILE);
    const gz = zlib.gzipSync(brut, { level: 9 });
    const bd = game.owedBreakdown();
    const du = bd.balances.add(bd.staked).add(bd.pending).add(bd.jackpot);
    const jour = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const ok = await tg.sendDocument(gz, `swoge-etat-${jour}.json.gz`,
      `💾 <b>Sauvegarde</b> · ${raison}\n` +
      `${game.players.size} joueurs · ${fmtAmt(ethers.utils.formatUnits(du, cfg.DECIMALS))} $SWOGE dus\n` +
      `${(brut.length / 1024).toFixed(0)} Ko → ${(gz.length / 1024).toFixed(0)} Ko compresses`);
    console.log(`[backup] ${ok ? 'envoyee' : 'NON ENVOYEE'} (${(gz.length / 1024).toFixed(0)} Ko, ${raison})`);
    return { ok, octets: gz.length, joueurs: game.players.size };
  } catch (e) {
    console.warn('[backup] echec :', e.message);
    return { ok: false, error: e.message };
  }
}

// ---- HTTP (health + tiny info) ----
const server = http.createServer(async (req, res) => {
 try {
  const path = req.url.split('?')[0];
  /* ---------------------------------------------- l'acces au tableau de bord
   *
   * ON ECHOUE FERME. Avant, une cle absente de la configuration ouvrait tout :
   * l'oubli d'une variable d'environnement — la faute la plus banale d'un
   * deploiement — publiait le solde de chaque joueur, son adresse, son total
   * depose, et laissait n'importe qui appeler /repare ou /burn. Un oubli ne
   * doit jamais elargir un acces.
   *
   * La cle se donne dans l'adresse ou dans l'en-tete `x-admin-key`. L'en-tete
   * est preferable : une cle dans l'adresse se retrouve dans l'historique du
   * navigateur et dans les journaux de tous les serveurs traverses.
   */
  const key = new URLSearchParams(req.url.split('?')[1] || '').get('key')
            || req.headers['x-admin-key'] || '';
  const authed = !!cfg.ADMIN_KEY && memeCle(key, cfg.ADMIN_KEY) && !bloque(req);
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  /* ------------------------------------------------------- la preuve d'equite
   *
   * PUBLIQUE, et elle doit l'etre : une preuve derriere une cle n'est pas une
   * preuve. On y trouve l'empreinte en cours, les graines DEJA RETIREES DU
   * SERVICE avec leur periode, et les formules jeu par jeu. La graine en cours
   * n'y figure jamais — la publier laisserait predire les manches a venir. */
  if (path === '/fairness') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
                         'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(game.equite(), null, 2));
  }
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
    if (!authed) return refuse(req, res, true);
    rate(req, true);
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
  /* Le brulage. Le serveur ne brule pas lui-meme : les jetons sont dans le
     coffre, et seule la cle du proprietaire peut les en sortir. La page
     d'administration fait la transaction avec son portefeuille, puis vient
     deposer la PREUVE ici — un hash que n'importe qui peut verifier. C'est
     alors, et alors seulement, que le canal l'annonce. */
  /* Le controle des depots d'un joueur : ce que dit le journal, ce que dit
     l'etat, et l'ecart. C'est le seul endroit qui permette de repondre a
     « j'ai depose et ca n'est pas arrive » autrement qu'en croyant sur
     parole — les deux fichiers sont ecrits separement, ils se contredisent
     quand quelque chose s'est perdu. */
  if (path === '/audit') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const a = String(qs.get('addr') || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) { res.writeHead(400); return res.end('addr=0x…'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(game.verifieDepots(a), null, 2));
  }
  /* La reparation. Plafonnee par l'ecart constate : on ne peut rien creer
     avec, seulement rendre ce que l'etat a perdu. */
  if (path === '/repare') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const a = String(qs.get('addr') || '').toLowerCase();
    try {
      const r = game.repareDepots(a);
      persist();                       // tout de suite, pas dans une seconde
      toAddr(a, { type: 'deposit', balance: game.balanceStr(a) });
      console.log(`[repare] ${a} +${r.rendu} $SWOGE (depot perdu, retrouve au journal)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(r, null, 2));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  /* Une sauvegarde a la demande — avant chaque operation risquee. Celle qu'on
     declenche soi-meme vaut mieux que celle qu'on aurait voulu avoir. */
  if (path === '/backup') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const r = await sauvegarde('a la demande');
    res.writeHead(r.ok ? 200 : 500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  /* ================= TELECHARGER TOUTES LES DONNEES =================
   *
   * Le meme fichier que celui qui part sur Telegram, mais dans le navigateur.
   * Une sauvegarde qui dort sur la machine qu'elle protege ne protege rien :
   * celle-ci finit sur un disque a soi. */
  if (path === '/export') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    /* On ecrit l'etat DU MOMENT avant de l'envoyer : sans ca on exporterait le
       dernier fichier ecrit, qui peut avoir dix secondes de retard — dix
       secondes de manches et de depots. */
    persistComplet();
    const brut = fs.readFileSync(store.FILE);
    const etat = JSON.parse(brut.toString('utf8'));
    const gz = zlib.gzipSync(brut, { level: 9 });
    const nom = `swoge-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${etat.players.length}j.json.gz`;
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': gz.length,
      'content-disposition': `attachment; filename="${nom}"`,
      'x-swoge-joueurs': String(etat.players.length),
    });
    console.log(`[export] ${etat.players.length} joueurs, ${(gz.length / 1024).toFixed(1)} Ko → ${qui(req)}`);
    return res.end(gz);
  }

  /* ===================== REMETTRE LE FICHIER =====================
   *
   * Le jour ou l'on en a besoin, on est dans le pire moment possible. Cette
   * route est donc ecrite pour ce moment-la, pas pour un jour calme :
   *
   *   1. elle REGARDE d'abord. Sans ?confirm=REPLACE-ALL elle ne remplace
   *      rien : elle dit ce que l'archive contient et ce qu'on perdrait ;
   *   2. elle GARDE l'etat actuel avant d'y toucher, dans un fichier date. Une
   *      restauration ratee se defait ;
   *   3. elle REFUSE une archive vide par-dessus un casino peuple, sauf a le
   *      demander explicitement — c'est la signature d'un mauvais fichier ;
   *   4. elle FERME les sockets : un joueur dont la page garde en memoire un
   *      solde d'avant la restauration verrait deux chiffres differents et
   *      croirait qu'on lui a pris quelque chose.
   */
  if (path === '/import') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const repond = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj, null, 2));
    };
    if (req.method !== 'POST')
      return repond(405, { error: 'POST the .json or .json.gz file as the request body' });

    // ---- lire le corps, sans laisser quelqu'un remplir la memoire
    const MAX = 200 * 1024 * 1024;
    const bouts = []; let taille = 0, trop = false;
    for await (const b of req) {
      taille += b.length;
      if (taille > MAX) { trop = true; break; }
      bouts.push(b);
    }
    if (trop) return repond(413, { error: 'file too large' });
    if (!taille) return repond(400, { error: 'empty body — POST the backup file itself' });
    let brut = Buffer.concat(bouts);

    // ---- gzip ou JSON : on reconnait au nombre magique, pas au nom
    if (brut[0] === 0x1f && brut[1] === 0x8b) {
      try { brut = zlib.gunzipSync(brut); }
      catch (e) { return repond(400, { error: 'the .gz archive is damaged and was NOT restored: ' + e.message }); }
    }
    let etat;
    try { etat = JSON.parse(brut.toString('utf8')); }
    catch (e) { return repond(400, { error: 'not readable JSON: ' + e.message }); }
    if (!etat || !Array.isArray(etat.players))
      return repond(400, { error: 'this file is not a SWOGE state (no players list)' });

    /* ---- CE QU'ON VERRAIT CHANGER. On le calcule avant de decider, et on le
       rend meme quand on remplace : c'est la ligne qu'on relira plus tard. */
    const sommeDue = (g) => {
      const b = g.owedBreakdown();
      return Number(ethers.utils.formatUnits(b.balances.add(b.staked).add(b.pending).add(b.jackpot), cfg.DECIMALS));
    };
    const temoin = new (require('./game').Game)();
    temoin.hydrate(JSON.parse(brut.toString('utf8')));
    const apercu = {
      fichier: { joueurs: etat.players.length, duAuxJoueurs: sommeDue(temoin) },
      actuel: { joueurs: game.players.size, duAuxJoueurs: sommeDue(game) },
    };
    apercu.difference = Number((apercu.fichier.duAuxJoueurs - apercu.actuel.duAuxJoueurs).toFixed(6));

    if (qs.get('confirm') !== 'REPLACE-ALL')
      return repond(200, { remplace: false, ...apercu,
        pourRemplacer: 'repost the same file with &confirm=REPLACE-ALL',
        avertissement: 'this replaces EVERY balance, stake, friendship and history with the file' });

    if (!etat.players.length && game.players.size > 0 && qs.get('force') !== '1')
      return repond(400, { remplace: false, ...apercu,
        error: `the file has 0 players and the live casino has ${game.players.size}. ` +
               'That is what a wrong file looks like. Add &force=1 if you really mean it.' });

    // ---- 1) on garde l'etat actuel, date, avant d'y toucher
    let filet = null;
    try {
      persistComplet();          // le filet doit contenir TOUT l'etat
      filet = store.FILE + '.avant-restauration-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(store.FILE, filet);
    } catch (e) {
      return repond(500, { remplace: false, error: 'could NOT snapshot the current state, so nothing was replaced: ' + e.message });
    }

    /* ---- 2) ON DETACHE TOUT LE MONDE AVANT DE REMPLACER, pas apres.
       Mesure faite : en fermant les sockets APRES, une manche encore en vol —
       une bille du pusher, une mise au Crash — appelait _p() sur un joueur que
       la restauration venait de retirer, et le ressuscitait. La fiche etait
       vide, donc sans un jeton dessus et jamais ecrite dans le fichier, mais
       un etat restaure qui contient un joueur absent de l'archive n'est plus
       l'archive. On coupe le lien d'abord : une socket sans adresse ne peut
       plus rien toucher. */
    let fermees = 0;
    for (const ws of clients) { try { ws.addr = null; ws.close(4001, 'state restored'); fermees++; } catch (e) {} }
    byAddr.clear();

    // ---- 3) on remplace pour de bon
    let r;
    try { r = game.remplace(etat); }
    catch (e) { return repond(400, { remplace: false, filet, error: e.message }); }
    /* Les tables en cours n'appartiennent a aucun des deux etats : elles ont
       ete ouvertes avec des soldes qui n'existent plus. On les vide. */
    try { poker.tables.clear(); } catch (e) {}
    /* `reconstruire` : les fragments sont relus AVANT state.json. Sans cette
       demande, le redemarrage suivant rendrait l'etat d'avant la restauration
       — les joueurs effacés reviendraient, avec leur solde. */
    store.save(game.serialize(), { force: qs.get('force') === '1', reconstruire: true });
    game.sales = new Set();          // tout vient d'etre ecrit

    console.warn(`[import] RESTAURATION : ${r.avant} → ${r.apres} joueurs, ` +
                 `du ${apercu.actuel.duAuxJoueurs} → ${apercu.fichier.duAuxJoueurs} $SWOGE, ` +
                 `${fermees} sockets fermees, filet : ${filet}`);
    tg.notify(`♻️ <b>State restored from a backup file</b>\n` +
              `Players: ${r.avant} → <b>${r.apres}</b>\n` +
              `Owed to players: ${fmtAmt(String(apercu.actuel.duAuxJoueurs))} → <b>${fmtAmt(String(apercu.fichier.duAuxJoueurs))} $SWOGE</b>\n` +
              `Everyone was disconnected and will reconnect.`);
    return repond(200, { remplace: true, ...apercu, joueurs: r, sessionsFermees: fermees,
                         filet, defaire: 'copy that file back over state.json and restart' });
  }

  if (path === '/burn') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    try {
      const r = game.enregistreBrulage(qs.get('amount'), qs.get('tx'));
      persistSoon();
      const lien = `${cfg.EXPLORER.replace(/\/+$/, '')}/tx/${qs.get('tx')}`;
      tg.notify(`🔥 <b>${fmtAmt(String(qs.get('amount')))} $SWOGE burned forever</b>\n` +
                `Every withdrawal burns 1% — it leaves circulation for good.\n` +
                `Total burned: <b>${fmtAmt(r.total)} $SWOGE</b>\n` +
                `<a href="${lien}">view the transaction ↗</a>`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...r }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  if (path === '/avatar-remove') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const a = String(qs.get('addr') || '').toLowerCase();
    const fait = avatars.supprime(a);
    if (fait) { const p = game.players.get(a); if (p) p.photo = false; persistSoon(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ removed: fait }));
  }
  if (path === '/players') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
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
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const qs2 = new URLSearchParams(req.url.split('?')[1] || '');
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
      /* Combien de temps le coffre tient au rythme actuel. L'alarme de
         solvabilite ne sonne qu'une fois passe dessous ; ceci previent. */
      autonomie: game.autonomie(pot),
      capaciteStaking: game.capaciteStaking(),
      /* Preleve sur les retraits depuis toujours. Cette somme est DEJA dans le
         coffre et compte deja dans le surplus : ce n'est pas un montant a
         retirer en plus, c'est le chiffre a bruler si on veut le bruler. */
      fraisRetraitsCumules: fmt(game.fraisCumules || ethers.BigNumber.from(0)),
      /* Ce qui attend d'etre brule, ce qui l'a deja ete, et les preuves. */
      aBruler: fmt(game.aBruler()),
      dejaBrule: fmt(game.brule || ethers.BigNumber.from(0)),
      brulages: (game.brulages || []).slice(0, 10),
      adresseBrulage: cfg.BURN_ADDRESS,
      /* Le compte du mois : le seul endroit qui reponde a « le casino a-t-il
         gagne de l argent ». Les depots n y sont PAS un gain. */
      comptes: game.comptes(qs2.get('mois') || null),
      tunnel: game.tunnelJours(14),
      moisConnus: game.moisConnus(),
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

/* Les fiches qui n'ont jamais rien fait quittent aussi la memoire. Elles ne
   sont deja plus ecrites sur le disque ; les garder en RAM laisserait quand
   meme un script les empiler jusqu'a l'etouffement. Les adresses connectees
   sont protegees : retirer la fiche de quelqu'un qui est devant son ecran lui
   reprendrait son credit d'essai au milieu de sa visite. */
/* ------------------------------------------------- la rotation de la graine
 *
 * On regarde toutes les dix minutes plutot que de programmer un rendez-vous a
 * la semaine : le serveur redemarre a chaque deploiement, et un rendez-vous
 * lointain ne survivrait a aucun d'eux. Si une main est en cours, on repasse
 * plus tard — mieux vaut tourner avec une heure de retard que couper une
 * manche en deux et la rendre invérifiable.
 */
/* Toutes les heures on regarde s'il est temps ; le rendez-vous quotidien ne
   survivrait a aucun redeploiement. */
let derniereSauvegarde = 0;
const backupInterval = setInterval(() => {
  if (!cfg.TG_BACKUP_CHAT_ID && !cfg.TG_CHAT_ID) return;
  if (Date.now() - derniereSauvegarde < cfg.BACKUP_HEURES * 3600000) return;
  derniereSauvegarde = Date.now();
  sauvegarde('quotidienne');
}, 3600000);

/* Le prix du classement se verse quand le mois a TOURNE, une seule fois. On
   regarde toutes les dix minutes : un rendez-vous au 1er a minuit ne
   survivrait pas au premier redeploiement, et le mois precedent ne bouge
   plus — le verser avec une heure de retard ne change rien pour personne. */
const prixInterval = setInterval(() => {
  try {
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    const passe = require('./game').Game.moisCle(d);
    if (!game.compta || !game.compta[passe]) return;
    if (game.prixVerses && game.prixVerses[passe]) return;
    const r = game.verseClassement(passe);
    persist();
    console.log(`[prix] classement ${passe} : ${r.total} $SWOGE a ${r.gagnants.length} joueurs`);
    tg.notify(`🏆 <b>${passe} leaderboard paid out</b>\n` +
      `<b>${fmtAmt(String(r.total))} $SWOGE</b> shared between the top ${r.gagnants.length} — ` +
      `1% of everything the house made last month.\n` +
      r.gagnants.slice(0, 3).map((g, i) =>
        `${['🥇', '🥈', '🥉'][i]} ${g.name} — ${fmtAmt(String(g.prix))}`).join('\n') +
      `\n\nThis month's pot is already growing. Play to climb.`);
    r.gagnants.forEach((g) => toAddr(g.address, { type: 'balance', balance: game.balanceStr(g.address) }));
  } catch (e) {
    if (!/already paid|nothing to share/.test(e.message)) console.warn('[prix]', e.message);
  }
}, 600000);

const graineInterval = setInterval(() => {
  try {
    const age = Date.now() - (game.graineDepuis || 0);
    if (age < cfg.FAIRNESS_ROTATE_HOURS * 3600000) return;
    const r = game.tourneGraine();          // jette si une main tourne encore
    persist();
    console.log(`[equite] graine tournee, ${r.revelee.n} manche(s) revelees : ${r.revelee.h.slice(0, 16)}…`);
    tg.notify(`🎲 <b>Seed rotated — you can now verify</b>\n` +
              `The previous server seed is public. Recompute any of the ` +
              `<b>${r.revelee.n}</b> rounds played under it and check we did not touch a thing.\n` +
              `<a href="${cfg.PUBLIC_URL || ''}/fairness">the seeds and the formulas ↗</a>`);
  } catch (e) {
    /* Une main en cours n'est pas une erreur : on redemande dans dix minutes. */
    if (!/hand\(s\) still running/.test(e.message)) console.warn('[equite]', e.message);
  }
}, 600000);

/* Les montees de niveau, ramassees deux fois par seconde. On ne les annonce
   pas depuis le coeur d'une manche : une fenetre qui s'ouvre pendant que la
   bille tombe couvre le jeu au pire moment. */
const niveauInterval = setInterval(() => {
  const m = game.montéesRecentes();
  for (const x of m) {
    toAddr(x.addr, { type: 'levelUp', niveau: x.a, palier: x.palier,
                     nouveauPalier: x.nouveauPalier, profil: game.niveau(x.addr) });
    /* Le canal n'est prevenu que pour un PALIER franchi : cent annonces de
       niveau par jour ne se lisent plus, dix passages de palier se fetent. */
    if (x.nouveauPalier && x.a >= 20) {
      const nom = game._p(x.addr).name;
      tg.notify(`⬆️ <b>${nom} reached ${x.palier}</b> — level ${x.a}\n` +
                `${fmtAmt(String(Math.round(require('./game').Game.volumePour(x.a))))} $SWOGE wagered for life. ` +
                `Only a handful will ever see level 100.`);
    }
  }
}, 500);

const purgeInterval = setInterval(() => {
  try {
    const n = game.purge(new Set(byAddr.keys()));
    if (n) console.log(`[purge] ${n} fiche(s) vide(s) retiree(s) de la memoire`);
  } catch (e) { console.warn('[purge]', e && e.message); }
}, 3600000);

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
    // les tables qui attendent, pour que la pastille soit juste avant meme
    // que le joueur se connecte
    duels: game.duelLobby(null), duelsEnCours: game.duelsEnCours(null),
    /* Les phrases viennent du SERVEUR : une liste ecrite en dur dans la page
       finirait par diverger de celle qui est acceptee, et le joueur cliquerait
       sur des boutons refuses sans comprendre pourquoi. */
    phrases: cfg.PHRASES, phraseMax: cfg.PHRASE_MAX,
    // l'explorateur, pour que l'historique puisse pointer vers la transaction
    explorer: cfg.EXPLORER,
  });

  game.noteTunnel('pages');            // une page de plus s'est ouverte
  ws.on('message', async (buf) => {
    if (!autorise(ws)) return;
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
        game.noteTunnel('connexions', rec);
        const nouveau = !game._p(rec).welcomeGranted;
        if (nouveau) game.noteTunnel('nouveaux', rec);
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

      /* Regarder un duel, comme on regarde une table de poker : c'est PUBLIC,
         et ca ne demande pas d'etre connecte. Un visiteur qui tombe sur le
         site doit pouvoir voir qu'il s'y passe quelque chose avant d'avoir
         branche quoi que ce soit. */
      if (m.type === 'duelWatch') {
        const id = String(m.id || '');
        const etat = game.duelEtat(id, Date.now());
        if (!etat) return send(ws, { type: 'error', error: 'that duel is over' });
        ws.duelWatch = id;
        /* Une partie deja jouee se regarde encore quelques minutes : on dit
           alors la verite tout de suite, plutot que d'annoncer « en cours »
           un plateau qui ne bougera plus jamais. */
        return send(ws, { type: 'duelWatch', match: etat, fini: etat.phase === DUEL_FINIE });
      }
      if (m.type === 'duelUnwatch') { ws.duelWatch = null; return; }
      /* Se taire : le choix vaut pour la socket, donc pour l'onglet ouvert.
         Meme toutes faites, quinze phrases d'affilee agacent, et il faut
         pouvoir les couper sans quitter la partie. */
      if (m.type === 'duelMute') { ws.duelMute = !!m.on; return send(ws, { type: 'duelMute', on: ws.duelMute }); }
      if (m.type === 'duelsEnCours')
        return send(ws, { type: 'duelsTous', tables: game.duelLobby(null),
                          enCours: game.duelsEnCours(null) });

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
          /* La salle a change de taille pour TOUT LE MONDE. Sans cette ligne,
             les autres joueurs voient une jauge d'il y a une heure et tapent
             un montant qui sera refuse. */
          broadcast({ type: 'stakePool', capacite: game.capaciteStaking() });
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
          /* Un nom se PAIE, et le paiement doit etre ecrit tout de suite : un
             redemarrage entre le debit et la sauvegarde periodique ferait
             repayer le joueur. Meme raison que pour un depot. */
          if (m.name !== undefined) persist(); else persistSoon();
          out.profile = game.profilPublic(ws.addr);
          out.avatars = require('./game').Game.VISAGES;
          out.prixNom = game.prixNom(ws.addr);
          out.balance = game.balanceStr(ws.addr);
          send(ws, out);
          /* Le nom s'affiche chez les AUTRES : les tables partagees doivent le
             reprendre tout de suite, sinon un joueur se renomme et reste
             affiche sous l'ancien nom jusqu'a la manche suivante. */
          broadcast({ type: 'profilePublic', profile: game.profilPublic(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'profile') {
        return send(ws, { type: 'profile', profile: game.profilPublic(ws.addr), prixNom: game.prixNom(ws.addr),
                          avatars: require('./game').Game.VISAGES,
                          friends: game.amis(ws.addr),
                          pending: game.amisEnAttente(ws.addr),
                          unread: game.transfertsNonLus(ws.addr),
                          niveau: game.niveau(ws.addr),
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
        return send(ws, { type: 'leaderboard', ...game.classementMois(ws.addr, 50),
                          prix: game.prixClassement() });
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
          if (!game.peutTeleverser(ws.addr))
            throw new Error('deposit once, or reach level 5, to upload your own picture');
          const r = avatars.enregistre(ws.addr, m.data);
          game._p(ws.addr).photo = true;
          persistSoon();
          send(ws, { type: 'profile', profile: game.profilPublic(ws.addr), prixNom: game.prixNom(ws.addr),
                     avatars: require('./game').Game.VISAGES, uploaded: r.octets });
          broadcast({ type: 'profilePublic', profile: game.profilPublic(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'avatarRemove') {
        avatars.supprime(ws.addr);
        game._p(ws.addr).photo = false;
        persistSoon();
        send(ws, { type: 'profile', profile: game.profilPublic(ws.addr), prixNom: game.prixNom(ws.addr),
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
          /* `duelRejoindre` rend `{ partie, retirees }` depuis que le morpion
             et les dames partagent ce chemin. Lire la reponse comme si elle
             etait la partie prenait bien les deux mises, puis jetait avant
             d'avoir prevenu qui que ce soit : la table demarrait pour de vrai,
             sans que personne ne voie le plateau. */
          const { partie } = game.p4Rejoindre(ws.addr, m.id, Date.now());
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
      /* Parler a la table. Le client envoie un identifiant ; le serveur verifie
         qu'il existe, que la personne est bien assise a cette table, et qu'elle
         n'a pas deja trop parle. Aucun texte ne traverse le reseau. */
      if (m.type === 'duelSay') {
        try {
          const dit = game.duelDire(ws.addr, m.id, m.phrase, Date.now());
          duelDiffusePhrase(dit.partie, dit);
          if (dit.reste <= 3) send(ws, { type: 'duelSayLeft', reste: dit.reste });
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
      if (m.type === 'duelsTous') return send(ws, tousDuels());
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
    /* Le plafond de staking se calcule sur l'offre REELLE lue sur la chaine
       des qu'on l'a. La valeur du fichier de config n'est qu'un filet : si le
       jeton etait brule ou remis en circulation, un plafond fige sur un
       chiffre ecrit a la main finirait par ne plus vouloir dire 20 %. */
    if (supplyWei && !supplyWei.isZero()) game.offreTotale = supplyWei;
    const tipNow = chain.vault ? await chain.provider.getBlockNumber() : 0;
    let fromBlock = game.lastBlock || cfg.SCAN_FROM_BLOCK || tipNow;
    // only Telegram-notify deposits at/after the current tip, so a historical
    // re-scan (SCAN_FROM_BLOCK / resumed watermark) doesn't spam old deposits.
    const liveFrom = tipNow;
    chain.watchDeposits(fromBlock, (d) => {
      if (game.creditDeposit(d)) {
        /* TOUT DE SUITE, et pas dans une seconde : c'est l'evenement le plus
           cher du serveur. Une seconde de retard, c'est la fenetre pendant
           laquelle un redeploiement fait disparaitre un depot deja credite —
           la ligne reste au journal, et le solde ne l'a jamais vue. */
        persist();
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
  clearInterval(niveauInterval); clearInterval(prixInterval); clearInterval(backupInterval); clearInterval(graineInterval); clearInterval(purgeInterval); clearInterval(stepInterval); clearInterval(bcInterval); clearInterval(metaInterval); clearInterval(saveInterval); clearInterval(pokerInterval); clearInterval(crashInterval); clearInterval(p4Interval); clearInterval(battement); clearInterval(compteInterval);
  persistComplet(); // instantane complet : rien ne se perd au redeploiement
  /* Le journal ecrit en differe pour ne pas ouvrir mille descripteurs : ce
     qui attend encore doit partir maintenant, sinon les dernieres manches
     jouees avant un redeploiement n'auront jamais existe. */
  journal.draine(() => { server.close(); process.exit(0); }, 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
