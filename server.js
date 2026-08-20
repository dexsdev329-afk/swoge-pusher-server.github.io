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
const sante = require('./sante');
const relay = require('./relay');
const profilpage = require('./profilpage');
const admin = require('./admin');
const session = require('./session');
const paris = require('./paris');
/* L'alimentation du calendrier des paris. Le module ne sort sur le reseau
   que si ODDS_API_KEY est posee — sans elle il le dit au demarrage et ne
   fait rien, le calendrier reste celui du depot. */
const parisImport = require('./paris_import');
const boutique = require('./boutique');
const skins = require('./skins');
let calendrierAuto = null;          // les minuteries de l alimentation
const journal = require('./journal');
const adminlog = require('./adminlog');
const reglages = require('./reglages');
const avatars = require('./avatars');

const table = new Table();
const game = new Game();
const chain = new Chain();

// ---- restore persisted balances (survives Railway redeploys via a volume) ----
/* Si l'etat existe mais n'est pas lisible, store.load() JETTE plutot que de
   rendre null : demarrer a vide ferait ecraser tous les soldes par la premiere
   sauvegarde automatique. On s'arrete franchement, avec le message. */
/* Les surcharges a chaud sont posees AVANT que quoi que ce soit lise `cfg`.
   Chargees apres, le premier tirage de la journee aurait applique la valeur
   d'origine pendant que le panneau affichait la surcharge. */
reglages.charge();

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
/* Les annonces Telegram partent en parse_mode HTML, et le NOM DU JOUEUR est
   une chaine libre de 24 caracteres qu'il choisit lui-meme (setName). Sans
   echappement, un nom contenant un chevron casse le message — au mieux ; au
   pire il y injecte son propre balisage. Il existait deja un `esc` dans ce
   fichier, mais enferme dans une fonction : celui-ci est au niveau du module,
   la ou les annonces en ont besoin. */
const escHtml = (x) => String(x == null ? '' : x)
  .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
/* fmtAmt abrege — 68.6k. C'est ce qu'il faut pour une annonce de gain, ou
   l'ordre de grandeur suffit. Un BULLETIN, lui, se lit au jeton pres : « peut
   rapporter 39.8k » quand le ticket dit 39 774 fait douter du chiffre, et un
   pari se prend sur un chiffre exact. Les paris sportifs utilisent celui-ci. */
const fmtExact = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
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
                    boulier: 'Boulier',
                    crash: 'Crash', p4: 'Connect 4', mp: 'Tic-Tac-Toe', dm: 'Checkers',
                    paris: 'SWOGE Bet' };
/* L'image du jeu accompagne l'annonce. Ce sont les MEMES vignettes que sur la
   page des jeux, extraites une fois dans media/ : une annonce illustree se
   remarque dans un canal, et celle qui montre la table dont on parle se
   remarque a bon escient. Telegram va chercher l'image lui-meme, d'ou une
   adresse publique ; si elle ne repond pas, notifyPhoto retombe sur le texte
   seul et l'annonce part quand meme. */
/* Les sports pour lesquels une image existe reellement dans /media. Une
   liste EN DUR et non une construction de nom : `imageJeu` fabrique une URL
   sans verifier qu'elle repond, et Telegram refuse l'envoi entier quand la
   photo est introuvable. Un sport de plus ici, c'est un fichier de plus a
   deposer — dans cet ordre. */
const IMAGE_SPORT = { foot: 1, tennis: 1, nba: 1, nfl: 1, cricket: 1 };

/**
 * L'image d'un bulletin.
 *
 * Un pari sur UN SEUL sport merite l'image de ce sport : on voit de quoi il
 * s'agit avant d'avoir lu une ligne. Un combine qui melange foot et tennis
 * n'a pas d'image juste — la carte generique est alors la seule honnete.
 *
 * La regle porte sur le nombre de SPORTS, pas sur le nombre de jambes : un
 * combine de trois matchs de foot est tout aussi identifiable qu'un simple,
 * et meritait donc le meme traitement.
 */
function imageBulletin(jambes) {
  const sports = new Set();
  for (const j of (jambes || [])) {
    const m = paris.match(j.match);
    if (m && m.sport) sports.add(m.sport);
  }
  const seul = sports.size === 1 ? [...sports][0] : null;
  return (seul && IMAGE_SPORT[seul]) ? imageJeu('paris-' + seul) : imageJeu('paris');
}

/* ---- POURQUOI UN NUMERO DE TIRAGE DANS L'ADRESSE ----
 *
 * Telegram ne retelecharge pas une photo qu'il a deja vue : il retient
 * l'ADRESSE et renvoie le fichier qu'il en avait tire la premiere fois. Les
 * vignettes ont ete redessinees sans changer de nom de fichier — le site sert
 * bien les nouvelles, mais le canal continuait d'afficher les anciennes,
 * indefiniment.
 *
 * Le numero fait de chaque refonte une adresse neuve. A BUMPER a chaque fois
 * qu'on remplace le contenu de media/jeu-*.jpg ; ne rien changer d'autre. Le
 * serveur qui sert les images ignore la chaine de requete, elle ne coute donc
 * rien de plus qu'un cache vide chez Telegram.
 */
const TIRAGE_VIGNETTES = 2;

function imageJeu(jeu) {
  if (!cfg.GAME_IMAGE_BASE || !jeu) return null;
  return `${cfg.GAME_IMAGE_BASE.replace(/\/+$/, '')}/jeu-${jeu}.jpg?v=${TIRAGE_VIGNETTES}`;
}

/* ---- LE LIEN DE LA TABLE, DANS L'ANNONCE ----
 *
 * Une annonce disait qui avait gagne, combien, et montrait la table — mais
 * n'y menait pas. Le lecteur devait retenir le nom, quitter le canal,
 * retrouver le site, puis la bonne page : trois gestes entre l'envie de jouer
 * et la table, alors que l'annonce arrive justement au moment ou l'envie est
 * la.
 *
 * L'adresse se deduit de celle des images — meme site, un dossier au-dessus.
 * Rien de nouveau a configurer, et si `GAME_IMAGE_BASE` change de domaine, les
 * liens suivent.
 */
const PAGE_JEU = {
  holdem: 'swoge_casino.html?game=holdem', three: 'swoge_casino.html?game=three',
  hilo: 'swoge_casino.html?game=hilo', mines: 'swoge_casino.html?game=mines',
  plinko: 'plinko.html', bj: 'swoge_blackjack.html', smash: 'swoge_smash.html',
  spin: 'swoge_spin.html', boulier: 'boulier.html', crash: 'crash.html',
  p4: 'connect4.html', mp: 'morpion.html', dm: 'dames.html',
  pusher: 'swoge_pusher_live.html', paris: 'swogebet.html',
};
function siteBase() {
  if (!cfg.GAME_IMAGE_BASE) return null;
  return cfg.GAME_IMAGE_BASE.replace(/\/+$/, '').replace(/\/media$/, '');
}
/** La ligne « ouvrir la table », prete a coller au bas d'une annonce. Vide si
 *  le jeu n'a pas de page a lui : mieux vaut pas de lien qu'un lien mort. */
function lienJeu(jeu, libelle) {
  const base = siteBase(), page = PAGE_JEU[jeu];
  if (!base || !page) return '';
  return '\n<a href="' + base + '/' + page + '">' + (libelle || 'Play this table') + ' \u2197</a>';
}

function notifyTableWin(addr, jeu, { net, staked, payout, note }) {
  if (!(net >= cfg.NOTIFY_WIN_MIN)) return;
  tg.notifyPhoto(imageJeu(jeu),
            `🃏 <b>${NOM_TABLE[jeu] || jeu}</b>\n` +
            `${escHtml(game._p(addr).name)} won <b>+${fmtAmt(String(net))} $SWOGE</b> 🐕\n` +
            `Stake ${fmtAmt(String(staked))} · returned ${fmtAmt(String(payout))}` +
            (note ? ` · ${note}` : '') + lienJeu(jeu));
}

/* ---------------------------------------------- un coffre vient de s'ouvrir
 *
 * Les autres annonces racontent un gain en jetons. Celle-ci raconte une
 * TROUVAILLE, et ce qui la rend interessante n'est pas ce que le joueur a
 * gagne : c'est ce qu'il lui RESTE A TROUVER.
 *
 * Deux chiffres, donc, et pas un de plus :
 *
 *   • le numero d'emission — « #7 of 10 ». Sur un mythique, cette ligne dit
 *     a tout le canal qu'il n'en reste que trois au monde. C'est la seule
 *     information qui fait ouvrir un coffre a quelqu'un d'autre ;
 *   • l'avancee du joueur dans SA famille — « Chaos 4/5 ». Un compteur qui
 *     approche de cinq se lit comme une histoire en cours.
 *
 * ---- ce qui est ANNONCE, et ce qui ne l'est pas ----
 *
 * Le seuil est une RARETE et pas un montant : c'est le seul critere qui ait
 * un sens ici, puisqu'un coffre ne rend jamais de jetons.
 *
 * ---- il avait ete regle trop haut ----
 *
 * A « epique et au-dessus », le canal ne recevait plus rien : 3 % des
 * ouvertures d'un coffre de bois, soit UNE ANNONCE TOUTES LES TRENTE-TROIS.
 * On ouvre dix coffres pour essayer, on ne voit rien, et on croit que la
 * fonction est cassee. C'est exactement ce qui s'est passe.
 *
 * Le raisonnement d'origine tenait pourtant — a « rare et au-dessus », cent
 * ouvertures d'un seul joueur font vingt-quatre messages et le mythique s'y
 * perd — mais il repondait a un probleme de GROS TRAFIC sur une boutique qui
 * vient d'ouvrir. Une annonce trop rare est un defaut certain aujourd'hui ;
 * une annonce trop frequente est un risque a partir d'un certain volume.
 *
 * ---- puis descendu jusqu'a zero, parce qu'il n'aurait jamais du exister ----
 *
 * Passe a « rare », le canal restait muet : trois coffres de bois ouverts
 * pour essayer ont sept chances sur dix de ne rendre que des communs. Le
 * seuil ne s'etait pas trompe de valeur, il s'etait trompe d'existence — la
 * demande etait « si quelqu'un achete, une notification apparait avec le
 * fruit qu'il a obtenu », sans condition. J'ai ajoute un filtre que personne
 * n'avait demande, pour resoudre un probleme que personne n'avait, et il a
 * fait passer une fonctionnalite qui marche pour une fonctionnalite cassee.
 *
 * CHAQUE ouverture est donc annoncee. Le reglage reste, inverse : il ne
 * protege plus par defaut, il sert le jour ou le canal sature vraiment —
 * COFFRE_ANNONCE_MIN=rare et on remonte d'un cran sans redeployer. Un
 * garde-fou qu'on active en voyant le probleme vaut mieux qu'un garde-fou
 * pose d'avance contre un probleme imagine.
 *
 * Frequences mesurees, par coffre :
 *   tout      bois 100 %  dore 100 %  mythique 100 %
 *   rare+     bois  24 %  dore  55 %  mythique  90 %
 *   epique+   bois   3 %  dore  17 %  mythique  56 %
 */
const COFFRE_RANGS = ['commun', 'rare', 'epique', 'legendaire', 'mythique'];
const COFFRE_ANNONCE = (() => {
  const mini = String(process.env.COFFRE_ANNONCE_MIN || 'commun').toLowerCase();
  const i = COFFRE_RANGS.indexOf(mini);
  return COFFRE_RANGS.slice(i < 0 ? 0 : i);
})();
function notifyCoffre(addr, g) {
  /* UNE LIGNE COMPLETEE PART TOUJOURS, quelle que soit la rarete du dernier
     fruit. C'est l'annonce la plus forte du canal — il n'y en aura que trois
     dans toute la vie de l'edition — et la retenir parce que la cinquieme
     case etait un commun serait absurde. */
  if (g && g.ligne) {
    const base0 = siteBase();
    tg.notifyPhoto(base0 ? base0 + '/img/shop/tg/' + g.item.cle + '.jpg' : null,
      `\uD83C\uDFC6 <b>${g.ligne.rang === 1 ? 'FIRST' : g.ligne.rang === 2 ? 'SECOND' : 'THIRD'} COMPLETE LINE</b>\n` +
      `${escHtml(g.ligne.nom)} finished the <b>${escHtml(g.ligne.familleNom)}</b> collection — all five tiers\n\n` +
      `Prize: <b>${fmtAmt(String(g.ligne.prix))} $SWOGE</b>\n` +
      (game.boutiqueCourse().restant
        ? `${game.boutiqueCourse().restant} prize(s) left \u2014 first line wins 50M, then 30M, then 10M`
        : `<b>All three prizes are gone.</b> The race is over.`) +
      (base0 ? `\n<a href="${base0}/games.html">Open a chest \u2197</a>` : ''));
  }
  if (!g || !g.item || COFFRE_ANNONCE.indexOf(g.rarete) < 0) return;
  const cat = boutique;
  const fam = cat.famille(g.item.famille);
  const rar = cat.rarete(g.rarete);
  const inv = game._p(addr).objets || {};
  /* Combien de fruits de cette famille le joueur possede, sur cinq. */
  const eus = cat.ITEMS.filter((o) => o.famille === g.item.famille && inv[o.id]).length;

  const reste = g.plafond - g.emis;
  /* L'adresse du dessin se DEDUIT du site, elle ne s'ecrit pas ici : posee en
     dur, elle aurait continue de pointer sur la production le jour ou l'on
     essaie autre chose, et l'annonce aurait montre un fruit qui n'est pas
     celui du serveur qui parle. */
  const base = siteBase();
  /* ---- L'IMAGE PART EN JPEG, PAS EN WEBP ----
   *
   * `sendPhoto` de Telegram accepte JPEG, PNG et GIF. Le WebP n'est accepte
   * que pour les AUTOCOLLANTS : une photo en .webp est refusee, et le module
   * retombe sur un message texte sans image.
   *
   * Le defaut etait invisible de l'interieur — un test de bout en bout a
   * montre trente-neuf appels partis sur quarante ouvertures, tous corrects,
   * tous en .webp. Le code marchait ; c'est Telegram qui refusait au bout du
   * fil.
   *
   * Les trente-six dessins ont donc un double en JPEG, composes sur le fond
   * sombre du site — le JPEG n'a pas de transparence, et sans fond choisi le
   * vide devient noir pur et les fruits sombres disparaissent dedans. */
  /* Le mot et l'embl\u00E8me suivent la SAISON. \u00AB MYTHIC FRUIT \u00BB sous le dessin
     d'une hache aurait fait douter de tout le reste du message. Une table
     plutot qu'un test binaire : la quatrieme saison n'a pas ajoute de
     branche, juste une ligne. */
  const sai = boutique.saison(g.saison) || boutique.SAISONS[0];
  const mot = String(sai.sujet || 'item').toUpperCase();
  const EMBLEME_SUJET = { fruit: '\uD83C\uDF4E', weapon: '\u2694\uFE0F', armor: '\uD83D\uDEE1\uFE0F', ring: '\uD83D\uDC8D' };
  const embleme = EMBLEME_SUJET[sai.sujet] || '\u2728';
  tg.notifyPhoto(base ? base + '/img/shop/tg/' + g.item.cle + '.jpg' : null,
    `${embleme} <b>${escHtml(rar.nom.toUpperCase())} ${mot}</b>\n` +
    `${escHtml(game._p(addr).name)} pulled <b>${escHtml(g.item.nom)}</b> ` +
    `from a ${escHtml(g.coffreNom)}\n\n` +
    `<b>#${g.emis} of ${g.plafond}</b>` +
    (reste > 0 ? ` \u00b7 only ${reste} left` : ' \u00b7 <b>the last one</b>') + `\n` +
    `${escHtml(fam.nom)} collection: <b>${eus}/5</b>` +
    (eus === 5 ? ' \u2705 complete' : '') +
    (base ? `\n<a href="${base}/games.html">Open a chest \u2197</a>` : ''));
}

/* ---- UN SKIN VIENT D'ETRE ACHETE ----
 *
 * Rien a voir avec les saisons \u2014 donc rien a voir avec `notifyCoffre` \u2014
 * mais c'est le meme achat aux yeux du canal : de l'argent depense contre un
 * objet, avec une image. Le dessin part depuis `img/skins/tg/`, converti a
 * part des objets de boutique parce que les deux dossiers n'ont jamais
 * besoin d'etre synchronises entre eux. */
function notifySkinBuy(addr, r) {
  const s = skins.skin(r.id);
  if (!s) return;
  const base = siteBase();
  tg.notifyPhoto(base ? base + '/img/skins/tg/skin_' + s.id + '.jpg' : null,
    `\ud83c\udfad <b>NEW SKIN</b>\n` +
    `${escHtml(game._p(addr).name)} bought <b>${escHtml(s.nom)}</b> ` +
    `for <b>${fmtAmt(String(r.prix))} $SWOGE</b>\n\n` +
    `${'\u2b50'.repeat(s.puissance)}${'\u2606'.repeat(6 - s.puissance)}` +
    (base ? `\n<a href="${base}/games.html">Open the shop \u2197</a>` : ''));
}

/* ------------------------------------------------ un pari vient d'etre pose
 *
 * Les autres annonces racontent un GAIN — elles arrivent apres coup, quand
 * tout est joue. Celle-ci raconte un ENGAGEMENT : un pari sportif reste ouvert
 * jusqu'au coup de sifflet, parfois des heures. C'est la seule annonce du
 * canal qu'on peut encore suivre en direct, et la seule qui donne envie de
 * prendre le meme.
 *
 * ELLE PART A LA POSE, PAS AU REGLEMENT. Annoncer un combine a 32 fois la mise
 * une fois qu'il est perdu n'interesse personne ; l'annoncer pendant que les
 * matchs se jouent, si.
 *
 * LA LEGENDE D'UNE PHOTO TELEGRAM EST BORNEE A 1024 CARACTERES. Huit jambes de
 * noms d'equipes longs peuvent en approcher : au-dela, l'API refuse TOUT le
 * message. On coupe donc la liste et on annonce ce qu'on a coupe, plutot que
 * de risquer une annonce qui ne part pas.
 */
const NOM_ISSUE   = { '1': 'Home', 'N': 'Draw', '2': 'Away' };
const NOM_ISSUE_2 = { '1': 'Player 1', '2': 'Player 2' };
/* Le libelle depend du SPORT, pas du nombre d'issues : la NFL, la NBA et le
   cricket n'en ont que deux eux aussi, mais opposent des EQUIPES. Seul le
   tennis oppose deux personnes. */
const nomIssue = (m, choix) => {
  const duel = m && m.sport === 'tennis' && (m.issues || []).length === 2;
  return (duel ? NOM_ISSUE_2 : NOM_ISSUE)[choix] || choix;
};   // tennis, NBA : pas de domicile
const ICONE_SPORT = { foot: '⚽', tennis: '🎾', nba: '🏀' };

/* L'HEURE DU COUP D'ENVOI FAIT LA DIFFERENCE ENTRE UNE ANNONCE ET UN BULLETIN.
   Quelqu'un qui lit le canal peut encore prendre le meme pari — mais seulement
   si le match n'a pas commence. Sans l'heure, il doit ouvrir la page pour le
   savoir. On l'ecrit en UTC : le canal est international, une heure locale
   serait celle du serveur et de personne d'autre. */
function heureMatch(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const j = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const auj = new Date();
  const memeJour = d.getUTCFullYear() === auj.getUTCFullYear() && d.getUTCMonth() === auj.getUTCMonth()
                && d.getUTCDate() === auj.getUTCDate();
  return memeJour ? `today ${hh}:${mm} UTC` : `${j} ${d.getUTCDate()} ${mo}, ${hh}:${mm} UTC`;
}

function notifyBetPlaced(addr, pari) {
  if (!pari || !(pari.mise >= cfg.NOTIFY_BET_MIN)) return;
  const jambes = pari.jambes || [];
  const n = jambes.length;

  /* Deux lignes par selection : l'affiche, puis le pari. Sur huit jambes, une
     seule ligne par selection depasse la largeur d'un telephone et se replie
     n'importe ou — la deuxieme ligne est ce qui rend la liste lisible. */
  const ligne = (j) => {
    const m = paris.match(j.match);
    if (!m) return null;
    const nom = nomIssue(m, j.choix);
    const ic = ICONE_SPORT[m.sport] || '•';
    const quand = heureMatch(m.debut);
    return `${ic} <b>${escHtml(m.domicile)} – ${escHtml(m.exterieur)}</b>` +
           (m.competition ? `  <i>${escHtml(m.competition)}</i>` : '') + '\n' +
           `      ${escHtml(nom)} @ ${Number(j.cote).toFixed(2)}` + (quand ? ` · ${quand}` : '');
  };

  let lignes = jambes.map(ligne).filter(Boolean);
  /* La legende d'une photo Telegram est bornee a 1024 caracteres, et l'API
     refuse TOUT le message au-dela. On coupe la liste et on annonce ce qu'on a
     coupe, plutot que de laisser croire au combine entier. */
  const LIMITE = 720;
  let coupees = 0;
  while (lignes.join('\n').length > LIMITE && lignes.length > 1) { lignes.pop(); coupees++; }
  if (coupees) lignes.push(`      … and ${coupees} more selection${coupees > 1 ? 's' : ''}`);

  const titre = n > 1 ? `${n}-fold accumulator` : 'Single bet';
  const benefice = Math.max(0, Math.round(pari.rapport - pari.mise));
  tg.notifyPhoto(imageBulletin(jambes),
    `🎟️ <b>SWOGE BET</b> · ${titre}\n` +
    `<b>${escHtml(game._p(addr).name)}</b> just placed a bet\n\n` +
    lignes.join('\n') + '\n\n' +
    `Total odds <b>${Number(pari.cote).toFixed(2)}</b>\n` +
    `Stake <b>${fmtExact(pari.mise)} $SWOGE</b>\n` +
    `Returns <b>${fmtExact(pari.rapport)} $SWOGE</b> <i>(+${fmtExact(benefice)})</i>`);
}

/* ------------------------------------------------- un match vient de tomber
 *
 * Le canal annoncait la POSE et jamais l'issue : on voyait partir des combines
 * a trente fois la mise sans jamais savoir ce qu'ils etaient devenus. Une
 * moitie d'histoire ne tient pas un canal.
 *
 * UNE ANNONCE PAR MATCH REGLE, PAS UNE PAR PARI. Un match populaire regle des
 * centaines de bulletins ; les annoncer un par un noierait le canal le temps
 * d'un coup de sifflet. On donne le total et le plus gros gagnant — c'est ce
 * qu'un tableau d'affichage montre.
 *
 * ET SEULEMENT S'IL Y A UN GAGNANT. Le canal ne publie que des gains ; un
 * « personne n'a gagne » repete a chaque match serait du bruit, et ce n'est
 * pas le genre de nouvelle qu'on va chercher.
 */
function notifyBetsSettled(r) {
  if (!r || !(r.gagnants > 0)) return;
  const m = paris.match(r.match);
  const issue = nomIssue(m, r.resultat);
  const affiche = m ? `${escHtml(m.domicile)} – ${escHtml(m.exterieur)}` : escHtml(r.match);
  const ic = (m && ICONE_SPORT[m.sport]) || '✅';

  let txt = `${ic} <b>SWOGE BET</b> · full time\n` +
            `<b>${affiche}</b> — ${escHtml(issue)}\n\n` +
            `${r.gagnants} winning bet${r.gagnants > 1 ? 's' : ''} · ` +
            `<b>${fmtExact(r.paye)} $SWOGE</b> paid out`;
  if (r.top) {
    const t = r.top;
    txt += `\nBiggest: <b>${escHtml(game._p(t.addr).name)}</b> +${fmtExact(t.rendu - t.mise)} $SWOGE` +
           ` · ${t.jambes > 1 ? t.jambes + '-fold' : 'single'} @ ${Number(t.cote).toFixed(2)}`;
  }
  /* Le reglement porte sur UN match : son sport est connu sans ambiguite. */
  tg.notifyPhoto(imageBulletin([{ match: r.match }]), txt);
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
/* Le dire au demarrage plutot que de le laisser decouvrir par un bouton qui
   renvoie ailleurs : sans cle, le panneau retombe sur un lien vers Relay, ce
   qui marche, mais fait sortir le joueur du site. */
console.log(relay.actif()
  ? '[relay] cle presente : adresses de depot actives (SOL, BTC, USDT-TRON, ETH, Base)'
  : '[relay] pas de RELAY_API_KEY : le panneau enverra les joueurs sur relay.link au lieu\n' +
    '        d afficher une adresse de depot. Posez la variable pour garder le tunnel sur le site.');

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
    /* CE QUI ATTEND LE JOUEUR part avec l'authentification, pas sur demande :
       la pastille doit etre allumee AVANT qu'il pense a regarder, sinon elle
       ne sert a rien — c'est elle qui le ramene, pas le bouton. */
    attente: game.enAttente(rec), offert: game.coffreOffert(rec),
    parfait: game.parfaitEtat(rec),
    stake: game.stakeInfo(rec), bj: game.bjState(rec), niveau: game.niveau(rec),
    casino: game.casinoState(rec), hilo: game.hiloState(rec), mines: game.minesState(rec),
    casinoPay: require('./casino').PAY,
    casinoMin: cfg.CASINO_MIN_BET, casinoMax: cfg.CASINO_MAX_BET,
    /* Les bornes du blackjack partent AVEC l'etat, comme celles du casino. La
       page les cadenassait en dur a quatre endroits : changer la limite
       demandait deux depots au lieu d'une variable. */
    bjMin: cfg.BJ_MIN_BET, bjMax: cfg.BJ_MAX_BET,
    /* Le plafond annexe et les tables de gain suivent le meme chemin : la page
       affiche « 25:1 » parce que le serveur paie 25:1, pas parce qu'un
       graphiste l'a ecrit dans une image. */
    bjSideMax: cfg.BJ_SIDE_MAX_BET,
    bjPay: { pp: cfg.BJ_PP_PAY, tp: cfg.BJ_213_PAY, ins: cfg.BJ_INS_PAY },
    hiloEdgeBps: cfg.HILO_EDGE_BPS,
    minesEdgeBps: cfg.MINES_EDGE_BPS, minesDefaut: cfg.MINES_DEFAUT,
    minesChoix: cfg.MINES_CHOIX, minesBareme: game.minesBareme(),
    plinkoBaremes: game.plinkoBaremes(), plinkoRangees: cfg.PLINKO_RANGEES,
    plinkoRisque: cfg.PLINKO_RISQUE, plinkoEdgeBps: cfg.PLINKO_EDGE_BPS,
    /* Le bareme du boulier et la cagnotte partent avec l'etat : la page ne
       calcule aucune probabilite et n'ecrit aucun lot en dur, sinon les deux
       finissent par diverger et c'est l'affichage qui a tort juste avant de
       miser. */
    boulierBareme: game.boulierBareme(), boulier: game.boulierEtat(Date.now(), rec),
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
/* Qui est present dans le Nexus, la ou les joueurs se croisent. Une simple
   liste de sockets — la position de chacun vit directement sur sa propre
   socket (`ws.nexusEtat`), pas dans un objet a part a tenir synchronise. */
const nexusClients = new Set();
const NEXUS_DIRS = new Set(['up', 'down', 'left', 'right']);
const NEXUS_ANIMS = new Set(['idle', 'run', 'jump']);

/* ---------------------------------------------------- LE MONDE DE COMBAT
 *
 * UN seul monde, partage par tous. Ce n'est pas une limite technique : c'est
 * le sens du jeu. Un monde par joueur, et on ne croise jamais personne ; le
 * Nexus n'aurait plus rien a annoncer, et la mort n'aurait aucun temoin.
 *
 * Il est cree au demarrage et vit tant que le processus vit. Les monstres
 * bougent meme quand personne ne regarde — c'est ce qui fait qu'on entre
 * dans un endroit qui existait avant nous, et non dans un decor qui
 * s'allume a l'ouverture de la porte.
 *
 * `realmClients` tient les sockets presentes dans le monde ; l'etat du
 * joueur, lui, vit dans le Realm sous son adresse. Une socket qui tombe est
 * retiree des deux.
 */
const { Realm } = require('./realm');
const monde = require('./monde');
/* L'ordre des stats part au client avec la carte : c'est celui des colonnes
   de la planche de potions. */
const personnages = require('./personnages');
const realm = new Realm({});
const realmClients = new Set();
/* Depuis quand un joueur n'a pas annonce sa position : c'est ce delai qui
   sert de `dt` a la borne de vitesse. Le mesurer ici plutot que de faire
   confiance a un `dt` envoye par le client est tout l'interet de la borne. */
const realmDernierMouv = new Map();

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
/* ---- le guichet du mode entrainement ----
 * Ces trois fonctions vivent ici, au niveau du module, et pas dans le
 * gestionnaire de messages : elles y servent AVANT d'y etre ecrites (le coup du
 * Connect 4 est traite plus haut que le bloc entrainement), et une `const`
 * flechee declaree plus bas leverait une ReferenceError a l'execution — une
 * panne qui ne se voit ni a la lecture ni au demarrage, seulement au premier
 * coup joue.
 *
 * Le nom du message est celui que la page attend deja : le Connect 4 parle
 * `p4Match`, les cinq autres `duelMatch`. */
function entMsg(jeu) { return jeu === 'p4' ? 'p4Match' : 'duelMatch'; }
function entRepond(ws, jeu, prime) {
  const o = { type: entMsg(jeu), match: game.entrainementEtat(ws.addr, Date.now()) };
  /* La prime a bouge le solde : on le renvoie dans le MEME message. Les pages
     lisent `balance` sur `p4Match` / `duelMatch` depuis toujours — c'est comme
     ca que le gain d'une table payante s'affiche — donc le chiffre en haut de
     l'ecran se met a jour tout seul, sans un mot de code en plus. */
  if (prime) { o.prime = prime; o.balance = game.balanceStr(ws.addr); }
  send(ws, o);
}
/** La table d'entrainement de CE joueur, si l'identifiant recu est le sien.
    C'est ce test qui aiguille un coup vers l'entrainement plutot que vers une
    table payante — et comme il compare a la table du joueur lui-meme, personne
    ne peut jouer sur celle d'un autre. */
function entSienne(ws, id) {
  if (!ws.addr || !id) return null;
  const t = game.entrainement.mienne(ws.addr);
  return t && String(t.id) === String(id) ? t : null;
}

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
const NOM_DUEL = { p4: 'Connect 4', mp: 'Tic-Tac-Toe', dm: 'Checkers',
                   mf: 'Ghost Tic-Tac-Toe', dc: 'Last Number' };
/* Les duels que la page peut demander. Une LISTE, pas une cascade de « dm ou
   sinon mp » : le troisieme jeu passait silencieusement pour un morpion, et
   c'est le genre de defaut qui se decouvre en jouant, pas en lisant. */
const DUELS_OUVERTS = ['mp', 'dm', 'mf', 'dc'];
const duelDemande = (v) => (DUELS_OUVERTS.indexOf(String(v)) >= 0 ? String(v) : 'mp');
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
  const t = Date.now();
  /* UN ETAT PAR DESTINATAIRE. Un seul etat diffuse a tout le monde mettrait
     le nombre cache de l'adversaire dans la page d'en face — au Dernier
     Chiffre, ca donne la partie au second a choisir. Les autres jeux rendent
     exactement le meme objet quel que soit le lecteur ; ca ne coute donc rien
     la ou ce n'est pas necessaire. */
  for (const a of partie.joueurs) {
    if (!a) continue;
    toAddr(a, { type: 'duelMatch', match: game.duelEtat(partie.id, t, a),
                balance: game.balanceStr(a), reglement: reglement || null });
  }
  /* Le spectateur ne recoit NI solde NI reglement : ce n'est pas son argent,
     et lui envoyer un solde le ferait afficher a la place du sien. Il ne
     recoit pas non plus les choix caches — la vue sans destinataire est la
     plus pauvre, et c'est le bon defaut. */
  const etat = game.duelEtat(partie.id, t);
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

/* ==================================================================
 * LA SESSION ADMIN
 * ==================================================================
 *
 * On echange la cle CONTRE UN JETON, une fois, et c'est le jeton qui circule
 * ensuite — dans un cookie que le navigateur joint tout seul.
 *
 * Ce que ca change, concretement :
 *
 *   - la cle n'apparait plus dans aucune adresse, donc plus dans l'historique
 *     ni dans les journaux ;
 *   - `HttpOnly` : aucun script de la page ne peut lire le jeton. Une faille
 *     d'injection ne l'emporte plus ;
 *   - `SameSite=Strict` : le navigateur ne joint pas le cookie aux requetes
 *     venues d'un autre site. Un lien piege ne peut donc plus rien declencher ;
 *   - le jeton EXPIRE. La cle, elle, ne changeait jamais.
 *
 * Les sessions vivent en memoire. Un redemarrage les jette : il faut se
 * reconnecter, ce qui est le bon comportement — un jeton qui survivrait a un
 * redemarrage devrait etre persiste, donc sauvegarde, donc envoye sur Telegram
 * avec la sauvegarde quotidienne.
 */
const sessions = new Map();                 // jeton -> { t, acteur, csrf, ip }
const SESSION_MS = 12 * 3600000;            // douze heures

function purgeSessions() {
  const t = Date.now();
  for (const [k, s] of sessions) if (t - s.t > SESSION_MS) sessions.delete(k);
}

function ouvreSession(acteur, ip) {
  purgeSessions();
  const jeton = crypto.randomBytes(32).toString('hex');
  /* Un SECOND secret, different du jeton : le jeton est dans le cookie que le
     script ne peut pas lire, le csrf est dans la page que le script lit. Les
     deux doivent etre presentes pour ecrire, et un site tiers n'a ni l'un ni
     l'autre — il ne peut pas lire la page (meme origine) pour prendre le csrf. */
  const csrf = crypto.randomBytes(24).toString('hex');
  sessions.set(jeton, { t: Date.now(), acteur: acteur || 'admin', csrf, ip });
  return { jeton, csrf };
}

function sessionValide(jeton) {
  const s = sessions.get(jeton);
  if (!s) return null;
  if (Date.now() - s.t > SESSION_MS) { sessions.delete(jeton); return null; }
  return s;
}

/* Les cookies arrivent dans une seule chaine. On ne prend que le notre, et on
   ne fait confiance a rien : un nom qui contient le notre en prefixe ne doit
   pas passer pour lui. */
function cookieDe(req, nom) {
  const brut = req.headers.cookie;
  if (!brut) return '';
  for (const part of String(brut).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== nom) continue;
    return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/* `Secure` seulement en HTTPS : pose sur du HTTP en local, le navigateur
   refuse le cookie et la connexion echoue sans rien dire. Railway termine le
   TLS devant nous, donc c'est l'en-tete transmis qui fait foi. */
function surHttps(req) {
  const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return p ? p === 'https' : !!req.socket.encrypted;
}

function poseCookie(res, req, jeton) {
  const bouts = ['swadm=' + encodeURIComponent(jeton), 'Path=/', 'HttpOnly',
                 'SameSite=Strict', 'Max-Age=' + Math.floor(SESSION_MS / 1000)];
  if (surHttps(req)) bouts.push('Secure');
  res.setHeader('set-cookie', bouts.join('; '));
}

function retireCookie(res, req) {
  const bouts = ['swadm=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (surHttps(req)) bouts.push('Secure');
  res.setHeader('set-cookie', bouts.join('; '));
}

/* Lit un corps de requete borne. Sans plafond, un POST peut faire allouer
   autant de memoire que l'expediteur en envoie. */
function corps(req, maxOctets) {
  return new Promise((resolve, reject) => {
    const max = maxOctets || 64 * 1024;
    let n = 0; const bouts = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(new Error('body too large')); req.destroy(); return; }
      bouts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(bouts)));
    req.on('error', reject);
  });
}

/**
 * LE GARDE DES ECRITURES.
 *
 * Trois conditions, et chacune ferme une porte differente :
 *
 *   1. METHODE POST. `/credit`, `/repare` et `/burn` etaient des GET qui
 *      deplacaient de l'argent : une adresse collee dans un onglet, prechargee
 *      par le navigateur ou laissee dans un historique suffisait a crediter un
 *      joueur. Une methode ne protege de rien a elle seule, mais elle retire
 *      le geste de tout ce qui suit un lien.
 *   2. JETON ANTI-REJEU. Le csrf de la session, envoye en en-tete. Un site
 *      tiers ne peut pas le lire : il faudrait qu'il lise la page, ce que la
 *      politique d'origine lui interdit.
 *   3. MOTIF, pour les gestes qui deplacent de l'argent. La liste est dans
 *      adminlog.js, en un seul endroit.
 *
 * Renvoie `null` si tout va bien, ou une chaine d'erreur.
 */
/* Les parametres d'un geste d'ecriture arrivent maintenant dans le CORPS, pas
   dans l'adresse. Un corps ne va ni dans l'historique du navigateur ni dans les
   journaux d'acces ; `?montant=500000` y allait. On tolere encore la chaine de
   requete en repli pour ne pas casser un script existant — la methode POST et
   le jeton restent exiges de toute facon. */
async function donPost(req) {
  const o = {};
  for (const [k, v] of new URLSearchParams(req.url.split('?')[1] || '')) o[k] = v;
  if (req.method === 'POST') {
    try {
      const b = (await corps(req, 64 * 1024)).toString('utf8');
      if (b) Object.assign(o, JSON.parse(b));
    } catch (e) { /* corps absent ou illisible : la chaine de requete suffit */ }
  }
  return o;
}

function refusEcriture(res, raison) {
  res.writeHead(raison === 'this endpoint needs POST' ? 405 : 400,
                { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ ok: false, error: raison }));
}

function gardeEcriture(req, session, action, motif) {
  if (req.method !== 'POST') return 'this endpoint needs POST';
  if (session) {
    const t = req.headers['x-admin-token'] || '';
    if (!t || !memeCle(t, session.csrf)) return 'stale page — reload the dashboard';
  }
  if (adminlog.motifRequis(action) && !String(motif || '').trim())
    return 'a reason is required for anything that moves money';
  return null;
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
/**
 * L'ARCHIVE : le fichier d'etat, plus les images de profil.
 *
 * Les images ne sont pas dans `state.json` — elles seraient reecrites toutes
 * les dix secondes pour rien. Mais une sauvegarde qui les oublie rend, le jour
 * de la restauration, des comptes complets avec des portraits casses. Elles
 * sont donc recollees ICI, au moment de partir, et nulle part ailleurs.
 *
 * On repart du FICHIER, pas de la memoire : ce qui s'en va est exactement ce
 * qui est sur le disque.
 */
function archiveComplete() {
  const zlib = require('zlib');
  const fsp = require('fs');
  persistComplet();
  const brut = fsp.readFileSync(store.FILE);
  const etat = JSON.parse(brut.toString('utf8'));
  const photos = avatars.exporte();
  if (photos.n) etat.avatars = photos.images;
  /* L'historique : « chaque manche, gardee a vie ». Il n'est pas dans
     `state.json` pour la meme raison que les images — mais une restauration
     qui rend l'argent devant un profil vide n'a rendu que la moitie. */
  const histoire = journal.exporte();
  if (histoire.n) etat.journal = histoire.lignes;
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(etat)), { level: 9 });
  return { gz, etat, photos, histoire, octetsEtat: brut.length };
}

async function sauvegarde(raison) {
  try {
    /* L'instantane COMPLET : `archiveComplete` ecrit l'etat du moment avant de
       le lire, et les fragments seuls le laisseraient vieux de cinq minutes. */
    const { gz, photos, histoire, octetsEtat } = archiveComplete();
    const bd = game.owedBreakdown();
    const du = bd.balances.add(bd.staked).add(bd.pending).add(bd.jackpot);
    const jour = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    /* Ce qu'on a laisse se DIT. Une sauvegarde qui tronque en silence se
       decouvre le jour de la restauration, c'est-a-dire trop tard. */
    const restees = (photos.laissees ? `\n⚠️ ${photos.laissees} image(s) laissee(s) — plafond atteint` : '') +
                    (histoire.laisses ? `\n⚠️ ${histoire.laisses} journal/journaux laisse(s) — plafond atteint` : '');
    const ok = await tg.sendDocument(gz, `swoge-etat-${jour}.json.gz`,
      `💾 <b>Sauvegarde</b> · ${raison}\n` +
      `${game.players.size} joueurs · ${fmtAmt(ethers.utils.formatUnits(du, cfg.DECIMALS))} $SWOGE dus\n` +
      `${photos.n} photo(s) · ${histoire.n} journal/journaux inclus\n` +
      `${(octetsEtat / 1024).toFixed(0)} Ko d etat → ${(gz.length / 1024).toFixed(0)} Ko compresses` +
      restees);
    console.log(`[backup] ${ok ? 'envoyee' : 'NON ENVOYEE'} (${(gz.length / 1024).toFixed(0)} Ko, ` +
                `${photos.n} photos, ${histoire.n} journaux, ${raison})`);
    return { ok, octets: gz.length, joueurs: game.players.size,
             photos: photos.n, journaux: histoire.n };
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
  /* ---- LA CLE NE VOYAGE PLUS DANS L'ADRESSE ----
   *
   * Elle etait lue dans `?key=`. Une cle dans l'adresse se retrouve dans
   * l'historique du navigateur, dans les journaux de l'hebergeur, dans ceux de
   * tous les intermediaires — et dans l'en-tete `Referer` envoye a chaque
   * ressource externe que la page charge. Ce n'est pas une hypothese : le
   * panneau chargeait ethers depuis un CDN, donc la cle partait chez un tiers
   * a chaque ouverture.
   *
   * Trois chemins la remplacent, dans cet ordre :
   *
   *   1. LE COOKIE de session. C'est celui du navigateur. `HttpOnly` — aucun
   *      script ne peut le lire, donc une faille d'injection ne l'emporte pas.
   *      `SameSite=Strict` — il n'est pas joint aux requetes venues d'un autre
   *      site, ce qui ferme la falsification de requete.
   *   2. L'EN-TETE `x-admin-key`. C'est celui des scripts et de curl. Un
   *      en-tete ne va ni dans l'historique ni dans le `Referer`.
   *   3. `?key=` UNIQUEMENT sur /admin, et seulement pour poser le cookie
   *      avant de rediriger vers une adresse propre. C'est le pont pour le
   *      marque-page existant, et il se ferme derriere lui : la cle quitte la
   *      barre d'adresse a la premiere seconde. Voir plus bas.
   */
  const enTete = req.headers['x-admin-key'] || '';
  const jeton = cookieDe(req, 'swadm');
  const session = jeton ? sessionValide(jeton) : null;
  const authed = !!cfg.ADMIN_KEY && !bloque(req)
              && (!!session || (!!enTete && memeCle(enTete, cfg.ADMIN_KEY)));
  /* Qui a agi, pour le journal. Une session nommee un jour ; « admin » en
     attendant, et « cle » quand le geste vient d'un script. */
  const acteur = session ? session.acteur : (authed ? 'cle' : 'anonyme');
  /* ------------------------------------------------------------- la sante
   *
   * Elle repondait `ok` a tout coup : elle ne disait donc qu'une chose, « un
   * processus ecoute ce port ». Or les pannes qui coutent de l'argent
   * laissent le processus vivant — les ecritures qui echouent, la veille de
   * chaine arretee. Un moniteur branche sur une page qui dit toujours oui ne
   * surveille rien.
   *
   * 503 quand quelque chose de grave se passe : c'est ce code que tous les
   * services de surveillance savent lire, et c'est lui qui fait sonner un
   * telephone. Publique par necessite — un moniteur ne sait pas
   * s'authentifier — donc aucun solde, aucune adresse : des durees et des
   * compteurs. */
  if (path === '/health') {
    const e = sante.etat();
    res.writeHead(e.ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8',
                                      'cache-control': 'no-store' });
    return res.end(JSON.stringify(e, null, 2));
  }
  /* ======================= ARRIVER D'UNE AUTRE CHAINE =======================
   *
   * Publique, et elle doit l'etre : un joueur qui n'a pas encore un jeton s'en
   * sert avant de pouvoir prouver quoi que ce soit. Ce qui la protege, ce n'est
   * pas une cle, c'est son etroitesse — voir relay.js : liste fermee de
   * provenances, destination imposee, montant borne.
   *
   * L'argent ne passe jamais par nous : Relay livre a l'adresse du joueur.
   * Notre cle sert seulement a obtenir l'adresse de depot, et elle reste ici.
   */
  if (path === '/relay/depuis') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*',
                         'cache-control': 'public, max-age=300' });
    return res.end(JSON.stringify({ actif: relay.actif(), provenances: relay.provenances() }));
  }
  if (path === '/relay/depot') {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    res.setHeader('access-control-allow-origin', '*');
    try {
      const r = await relay.adresseDepot(qs.get('de'), qs.get('vers'), qs.get('montant'));
      console.log(`[relay] adresse de depot ${r.symbole} → ${String(qs.get('vers')).slice(0, 10)}…`);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      /* Le 503 a un sens precis : la cle n'est pas posee. La page s'en sert
         pour retomber sur le lien vers Relay au lieu d'afficher une panne. */
      const code = e.statut || 502;
      if (code !== 400) console.warn('[relay] depot :', e.message);
      res.writeHead(code, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e.message || e).slice(0, 200) }));
    }
  }
  /* Le chiffrage en dollars du montant saisi. Route SEPAREE de /relay/depot :
     elle est appelee a chaque frappe (amortie cote page) et ne doit ouvrir
     aucune adresse de depot. Un echec ici n'est pas une panne — la page
     n'affiche pas la ligne, et le depot part quand meme. */
  if (path === '/relay/prix') {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    res.setHeader('access-control-allow-origin', '*');
    try {
      const r = await relay.prix(qs.get('de'), qs.get('vers'), qs.get('montant'));
      res.writeHead(200, { 'content-type': 'application/json',
                           /* Quinze secondes : le cours ne bouge pas assez en
                              quinze secondes pour tromper qui que ce soit, et
                              ca absorbe les allers-retours d'un joueur qui
                              corrige son montant chiffre par chiffre. */
                           'cache-control': 'public, max-age=15' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      const code = e.statut || 502;
      res.writeHead(code, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e.message || e).slice(0, 200) }));
    }
  }
  if (path === '/relay/etat') {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    res.setHeader('access-control-allow-origin', '*');
    try {
      const r = await relay.etat(qs.get('id'));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(e.statut || 502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e.message || e).slice(0, 200) }));
    }
  }

  /* ------------------------------------------------- la page publique d'un joueur
   *
   * `/j/<nom>` — l'adresse qu'un joueur partage. Elle est rendue ICI et non
   * sur le site parce que Telegram, X et Discord lisent la page eux-memes
   * sans executer aucun JavaScript : sans balises `og:` dans le document
   * renvoye, le lien colle reste nu, et un lien nu ne se propage pas.
   *
   * Publique et sans cle : c'est le principe. Elle ne porte que ce qui est
   * deja dehors — nom, niveau, grosses victoires deja annoncees au canal —
   * et jamais un solde. */
  if (path.startsWith('/j/')) {
    const nom = decodeURIComponent(path.slice(3)).trim();
    const addr = game.parNom(nom);
    const vue = addr ? game.profilPage(addr) : null;
    res.writeHead(vue ? 200 : 404, { 'content-type': 'text/html; charset=utf-8',
                                     'cache-control': 'public, max-age=60' });
    return res.end(vue ? profilpage.rend(vue) : profilpage.absent(nom));
  }
  /* Les memes donnees en JSON, pour qui veut les afficher autrement. */
  if (path.startsWith('/api/j/')) {
    const nom = decodeURIComponent(path.slice(7)).trim();
    const addr = game.parNom(nom);
    res.writeHead(addr ? 200 : 404, { 'content-type': 'application/json; charset=utf-8',
                                      'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(addr ? game.profilPage(addr) : { error: 'no such player' }));
  }

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
  /* ---- SE CONNECTER ----
   *
   * La cle part en POST, dans un corps, jamais dans une adresse. On rend un
   * jeton de session dans un cookie que le script ne peut pas lire, et le csrf
   * dans le corps de la reponse — c'est la page qui le gardera en memoire.
   */
  if (path === '/admin/login') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
    if (!cfg.ADMIN_KEY) return refuse(req, res, false);
    if (bloque(req)) { res.writeHead(429, { 'content-type': 'application/json' });
                       return res.end(JSON.stringify({ error: 'too many attempts — wait 10 minutes' })); }
    let don = {};
    try { don = JSON.parse((await corps(req, 4096)).toString('utf8') || '{}'); } catch (e) {}
    if (!memeCle(don.key || '', cfg.ADMIN_KEY)) {
      rate(req, false);
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'wrong key' }));
    }
    rate(req, true);
    const s = ouvreSession('admin', qui(req));
    poseCookie(res, req, s.jeton);
    adminlog.ajoute({ acteur: 'admin', action: 'login', cible: null, ip: qui(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, csrf: s.csrf }));
  }
  if (path === '/admin/logout') {
    const j = cookieDe(req, 'swadm');
    if (j) sessions.delete(j);
    retireCookie(res, req);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  /* La bibliotheque ethers, servie PAR NOUS.
   *
   * Elle venait de cdnjs. Chaque ouverture du panneau envoyait donc a un tiers
   * l'adresse complete de la page — cle comprise, a l'epoque ou elle y etait —
   * dans l'en-tete `Referer`. Et un CDN compromis executait son code sur la
   * page qui signe les transactions du proprietaire. Le fichier est deja dans
   * node_modules ; le servir ne coute rien. */
  if (path === '/admin/ethers.js') {
    if (!authed) return refuse(req, res, false);
    try {
      const p = require.resolve('ethers/dist/ethers.umd.min.js');
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8',
                           'cache-control': 'public, max-age=86400' });
      return res.end(require('fs').readFileSync(p));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/javascript' });
      return res.end('/* ethers introuvable : ' + String(e.message).replace(/\*/g, '') + ' */');
    }
  }
  // Private owner dashboard (HTML)
  if (path === '/admin') {
    /* ---- LE PONT POUR LE MARQUE-PAGE ----
     *
     * `?key=` n'ouvre plus rien nulle part ailleurs. Ici, et ici seulement, il
     * pose le cookie et REDIRIGE vers une adresse propre. La cle quitte la
     * barre d'adresse a la premiere seconde, et les requetes suivantes n'en
     * portent plus. Sans ce pont, le marque-page existant cesserait de
     * fonctionner du jour au lendemain sans dire pourquoi — et la reaction
     * naturelle serait de remettre la cle partout. */
    const q = new URLSearchParams(req.url.split('?')[1] || '').get('key');
    if (q && !session && cfg.ADMIN_KEY && !bloque(req) && memeCle(q, cfg.ADMIN_KEY)) {
      rate(req, true);
      const s = ouvreSession('admin', qui(req));
      poseCookie(res, req, s.jeton);
      adminlog.ajoute({ acteur: 'admin', action: 'login', cible: 'via ?key= (marque-page)',
                        ip: qui(req) });
      console.warn('[secu] connexion par ?key= : la cle est passee dans une adresse. ' +
                   'Mettez votre marque-page sur /admin tout court.');
      res.writeHead(302, { location: '/admin' });
      return res.end();
    }
    /* Pas de session : on rend la PAGE DE CONNEXION, pas une erreur. Un 401 nu
       laisse devant une page blanche quelqu'un qui a simplement une session
       expiree. */
    if (!session && !authed) {
      if (!cfg.ADMIN_KEY) return refuse(req, res, true);
      rate(req, false);
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(admin.connexion());
    }
    rate(req, true);
    /* Le csrf voyage DANS LA PAGE. Un tiers ne peut pas la lire, donc il ne
       peut pas l'obtenir — c'est ce qui rend le jeton utile. */
    const s = session || ouvreSession('admin', qui(req));
    if (!session) poseCookie(res, req, s.jeton);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(admin.page(s.csrf));
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
  /* ======================= CE QUI EST JOUE =======================
   *
   * Privee comme le reste du tableau de bord : elle donne le detail de
   * l'activite, joueurs distincts compris. En HTML plutot qu'en JSON, parce
   * qu'on l'ouvre depuis un telephone pour repondre a une question simple —
   * « est-ce que quelqu'un joue au Plinko ? » — et qu'un JSON brut a lire au
   * pouce ne repond a rien.
   */
  /* ---- CE QUI EST JOUE, EN DONNEES ----
   *
   * `/usage` etait une page HTML separee, referencee nulle part : il fallait
   * connaitre l'adresse par coeur. Trois surfaces d'administration existaient
   * — /admin, /usage, /health — et une seule etait trouvable.
   *
   * On ne la reecrit pas : les chiffres viennent des memes `usageJours()` et
   * `usageJour()`. On les rend en JSON, et l'onglet Jeux du panneau les peint.
   * La page HTML reste en place pour qui l'avait en marque-page.
   */
  if (path === '/usage.json') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const combien = Math.max(1, Math.min(30, parseInt(q.get('jours') || '7', 10) || 7));
    const jours = game.usageJours();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      joursConnus: jours.length,
      jours: jours.slice(0, combien).map((j) => {
        const l = game.usageJour(j);
        return { jour: j, lignes: l,
                 total: l.reduce((t, x) => ({
                   manches: t.manches + x.manches,
                   mise: Number((t.mise + x.mise).toFixed(6)),
                   rendu: Number((t.rendu + x.rendu).toFixed(6)),
                   net: Number((t.net + x.net).toFixed(6)),
                 }), { manches: 0, mise: 0, rendu: 0, net: 0 }) };
      }),
    }, null, 2));
  }
  if (path === '/usage') {
    if (!authed) return refuse(req, res, true);
    rate(req, true);
    const jours = game.usageJours();
    const qs2 = new URLSearchParams(req.url.split('?')[1] || '');
    const combien = Math.max(1, Math.min(30, parseInt(qs2.get('jours') || '7', 10) || 7));
    const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const n = (x) => Number(x || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
    let h = '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>SWOGE — ce qui est joue</title>' +
      '<style>body{margin:0;padding:16px;background:#0B0E16;color:#EAF2FF;' +
      'font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}' +
      'h2{margin:22px 0 8px;font-size:15px;color:#FFC53D}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:6px}' +
      'th,td{padding:6px 6px;text-align:right;border-bottom:1px solid rgba(255,255,255,.08)}' +
      'th:first-child,td:first-child{text-align:left}' +
      'th{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#7E8FAC}' +
      '.n{color:#7CFF9B}.p{color:#F2685E}.v{color:#8DA0C4;font-size:12px}</style>' +
      /* Elle n'est plus un cul-de-sac : ces memes chiffres vivent maintenant
         dans l'onglet Jeux du panneau, avec le reste. */
      '<p class="v"><a href="/admin#jeux" style="color:#FFC53D">&larr; ces chiffres sont dans le panneau, onglet Jeux</a></p>' +
      `<p class="v">${jours.length} jour(s) enregistre(s) · les ${combien} derniers</p>`;
    if (!jours.length) {
      h += '<p class="v">Rien encore. La mesure commence au premier tour joue apres ce deploiement — ' +
           'elle ne peut pas raconter le passe.</p>';
    }
    for (const j of jours.slice(0, combien)) {
      const l = game.usageJour(j);
      const tot = l.reduce((t, x) => ({ m: t.m + x.manches, mise: t.mise + x.mise, net: t.net + x.net }),
                           { m: 0, mise: 0, net: 0 });
      h += `<h2>${esc(j)}</h2><table><tr><th>jeu</th><th>manches</th><th>joueurs</th>` +
           '<th>mise</th><th>retour</th><th>net maison</th></tr>';
      for (const x of l) {
        h += `<tr><td>${esc(x.jeu)}</td><td>${n(x.manches)}</td>` +
             `<td>${n(x.joueurs)}${x.auDela ? '+' : ''}</td><td>${n(x.mise)}</td>` +
             `<td>${x.retour === null ? '—' : x.retour + '%'}</td>` +
             `<td class="${x.net >= 0 ? 'n' : 'p'}">${n(x.net)}</td></tr>`;
      }
      h += `<tr><td><b>tout</b></td><td><b>${n(tot.m)}</b></td><td></td><td><b>${n(tot.mise)}</b></td>` +
           `<td></td><td class="${tot.net >= 0 ? 'n' : 'p'}"><b>${n(tot.net)}</b></td></tr></table>`;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(h);
  }

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
    const d = await donPost(req);
    const a = String(d.addr || '').toLowerCase();
    const nonV = gardeEcriture(req, session, 'repare', d.motif);
    if (nonV) return refusEcriture(res, nonV);
    try {
      const avant = game.balanceStr(a);
      const r = game.repareDepots(a);
      persist();                       // tout de suite, pas dans une seconde
      toAddr(a, { type: 'deposit', balance: game.balanceStr(a) });
      adminlog.ajoute({ acteur, action: 'repare', cible: a, motif: d.motif,
                        avant, apres: game.balanceStr(a), ip: qui(req) });
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
    const nonVB = gardeEcriture(req, session, 'backup', 'x');
    if (nonVB) return refusEcriture(res, nonVB);
    const r = await sauvegarde('a la demande');
    adminlog.ajoute({ acteur, action: 'backup', cible: null,
                      apres: r.ok ? `${r.joueurs} joueurs, ${Math.round((r.octets || 0) / 1024)} Ko`
                                  : 'ECHEC : ' + (r.error || '?'), ip: qui(req) });
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
    /* Le MEME fichier que celui qui part sur Telegram — images de profil
       comprises. `archiveComplete` ecrit l'etat du moment avant de le lire :
       sans ca on exporterait le dernier fichier ecrit, qui peut avoir dix
       secondes de retard — dix secondes de manches et de depots. */
    const { gz, etat, photos, histoire } = archiveComplete();
    const nom = `swoge-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${etat.players.length}j.json.gz`;
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': gz.length,
      'content-disposition': `attachment; filename="${nom}"`,
      'x-swoge-joueurs': String(etat.players.length),
      'x-swoge-photos': String(photos.n),
      'x-swoge-journaux': String(histoire.n),
    });
    console.log(`[export] ${etat.players.length} joueurs, ${photos.n} photos, ${histoire.n} journaux, ` +
                `${(gz.length / 1024).toFixed(1)} Ko → ${qui(req)}`);
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
    /* Le temoin ne sert qu'a chiffrer ce que l'archive DOIT aux joueurs. On
       lui donne les fiches deja lues plutot que de reparser le fichier : avec
       les images et les journaux dedans, une archive fait des dizaines de
       megaoctets, et l'analyser deux fois sur un serveur qui tient tous les
       soldes en memoire n'apporte rien. `hydrate` ne fait que LIRE cette
       liste — il construit des fiches neuves a partir d'elle. */
    const temoin = new (require('./game').Game)();
    temoin.hydrate({ players: etat.players, jackpotPot: etat.jackpotPot });
    const apercu = {
      fichier: { joueurs: etat.players.length, duAuxJoueurs: sommeDue(temoin) },
      actuel: { joueurs: game.players.size, duAuxJoueurs: sommeDue(game) },
    };
    apercu.difference = Number((apercu.fichier.duAuxJoueurs - apercu.actuel.duAuxJoueurs).toFixed(6));

    if (qs.get('confirm') !== 'REPLACE-ALL')
      return repond(200, { remplace: false, ...apercu,
        pourRemplacer: 'repost the same file with &confirm=REPLACE-ALL',
        avertissement: 'this replaces EVERY balance, stake, friendship and history with the file' });

    /* Le garde ne s'applique qu'a la VRAIE restauration. Le premier envoi ne
       fait que regarder le fichier — exiger un motif pour regarder ferait
       taper un motif a quelqu'un qui ne sait pas encore s'il va restaurer. */
    const motifR = qs.get('motif') || req.headers['x-admin-motif'] || '';
    const nonVR = gardeEcriture(req, session, 'restore', motifR);
    if (nonVR) return repond(nonVR === 'this endpoint needs POST' ? 405 : 400,
                             { remplace: false, error: nonVR });

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
      /* On journalise AVANT de remplacer. Si la restauration echoue a
         mi-chemin, la ligne qui dit qu'on a essaye est deja ecrite — et c'est
         precisement le cas ou on aura besoin de le savoir. Le journal admin
         vit hors de state.json, donc la restauration ne l'ecrase pas : c'est
         toute la raison pour laquelle il est dans son propre fichier. */
      adminlog.ajoute({ acteur, action: 'restore', cible: filet, motif: motifR,
                        avant: `${apercu.actuel.joueurs} joueurs, ${apercu.actuel.duAuxJoueurs} dus`,
                        apres: `${apercu.fichier.joueurs} joueurs, ${apercu.fichier.duAuxJoueurs} dus`,
                        ip: qui(req) });
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
    /* Les portraits reviennent avec les comptes. Sans ca, une restauration sur
       un volume neuf rendait des fiches completes qui disaient « j'ai une
       photo » devant une adresse qui repondait 404. Elles repassent par le
       controle des octets : une archive est un fichier comme un autre. */
    let images = { poses: 0, refusees: 0 };
    if (etat.avatars) { try { images = avatars.importe(etat.avatars); } catch (e) {} }
    /* L'historique revient avec les comptes — mais jamais par-dessus celui
       d'un joueur qui en a deja un : voir journal.importe(). */
    let histoire = { poses: 0, gardes: 0 };
    if (etat.journal) { try { histoire = journal.importe(etat.journal); } catch (e) {} }
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
                 `${images.poses} photo(s) reposee(s)` +
                 (images.refusees ? `, ${images.refusees} refusee(s)` : '') +
                 `, ${histoire.poses} journal/journaux repose(s)` +
                 (histoire.gardes ? `, ${histoire.gardes} garde(s) intact(s)` : '') +
                 `, ${fermees} sockets fermees, filet : ${filet}`);
    tg.notify(`♻️ <b>State restored from a backup file</b>\n` +
              `Players: ${r.avant} → <b>${r.apres}</b>\n` +
              `Owed to players: ${fmtAmt(String(apercu.actuel.duAuxJoueurs))} → <b>${fmtAmt(String(apercu.fichier.duAuxJoueurs))} $SWOGE</b>\n` +
              `Everyone was disconnected and will reconnect.`);
    return repond(200, { remplace: true, ...apercu, joueurs: r, photos: images,
                         journaux: histoire, sessionsFermees: fermees,
                         filet, defaire: 'copy that file back over state.json and restart' });
  }

  if (path === '/burn') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const qs = await donPost(req);
    const nonV = gardeEcriture(req, session, 'burn', qs.motif);
    if (nonV) return refusEcriture(res, nonV);
    const g = (k) => qs[k];
    try {
      const avant = game.brule ? ethers.utils.formatUnits(game.brule, cfg.DECIMALS) : '0';
      const r = game.enregistreBrulage(g('amount'), g('tx'));
      persistSoon();
      adminlog.ajoute({ acteur, action: 'burn', cible: String(g('tx') || ''),
                        avant, apres: r.total, motif: qs.motif, ip: qui(req) });
      const lien = `${cfg.EXPLORER.replace(/\/+$/, '')}/tx/${g('tx')}`;
      tg.notify(`🔥 <b>${fmtAmt(String(g('amount')))} $SWOGE burned forever</b>\n` +
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
  /* ================= CREDITER UN JOUEUR =================
   *
   * RESERVE A L ADMIN, comme /repare et /burn : cette route cree des jetons
   * qui ne viennent d'aucun depot. L'enveloppe glissante vit dans le moteur —
   * c'est-a-dire dans l'etat sauvegarde — et pas ici : un plafond garde en
   * memoire du processus se remet a zero a chaque redeploiement, ce qui
   * revient a ne pas avoir de plafond.
   */
  if (path === '/credit/etat') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(game.enveloppeCredit(Date.now())));
  }
  if (path === '/credit') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const d = await donPost(req);
    /* Le motif du credit s'appelait deja `note` et partait au journal du
       joueur. On garde ce nom cote appelant et on le passe AUSSI au journal
       admin : un seul motif saisi, deux endroits qui le portent. */
    const motif = d.motif || d.note || '';
    const nonV = gardeEcriture(req, session, 'credit', motif);
    if (nonV) return refusEcriture(res, nonV);
    try {
      const cible0 = game.trouveJoueur(d.joueur);
      const avant = cible0 ? game.balanceStr(cible0) : null;
      const r = game.crediteJoueur(d.joueur, d.montant, Date.now(), motif);
      adminlog.ajoute({ acteur, action: 'credit', cible: r.addr, motif,
                        avant, apres: r.solde, ip: qui(req) });
      persist();                       // tout de suite : c'est de l'argent
      /* Le joueur voit son solde bouger SANS RECHARGER. Sans ca, il decouvre
         le credit au prochain rafraichissement — ou l'annonce arrive avant
         l'argent, ce qui est pire que l'inverse. */
      toAddr(r.addr, { type: 'balance', balance: r.solde });
      console.log(`[credit] ${r.addr} +${r.montant} $SWOGE ` +
                  `(reste ${r.enveloppe.reste} sur ${r.enveloppe.max})`);
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
    const qs = await donPost(req);
    const nonV = gardeEcriture(req, session, 'avatarRetire', qs.motif);
    if (nonV) return refusEcriture(res, nonV);
    const a = String(qs.addr || '').toLowerCase();
    const fait = avatars.supprime(a);
    if (fait) adminlog.ajoute({ acteur, action: 'avatarRetire', cible: a,
                                motif: qs.motif, avant: 'photo', apres: 'aucune', ip: qui(req) });
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
  /* Regler un match, et rembourser un match. RESERVE A L ADMIN : ces deux
     routes deplacent de l'argent chez des joueurs, et la seconde le rend a
     tout le monde. Elles ne sont jamais accessibles depuis une page. */
  /* Tous les paris, cherchables. C'est le pendant de l'identifiant affiche au
     joueur : quand quelqu'un ecrit « mon pari b41-mfx2 n'a pas ete paye », on
     le retrouve en une recherche au lieu de fouiller un fichier. La recherche
     porte sur l'identifiant du pari, celui du match, l'adresse et le nom. */
  /* Ce qui ATTEND un resultat. C'est la seule liste du panneau qui demande une
     action : tant qu'elle n'est pas vide, des joueurs attendent d'etre payes. */
  /* L'etat de l'alimentation, et de quoi la relancer a la main.
     « Pourquoi n'y a-t-il pas plus de matchs ? » avait trois reponses
     possibles — pas de cle, cle invalide, ligues hors saison — qui ne se
     distinguaient qu'en lisant les journaux de l'hebergeur. Elle se lit
     maintenant dans le panneau. La cle n'est JAMAIS rendue, seulement le
     fait qu'elle soit posee. */
  if (path === '/paris/import') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const q = await donPost(req);
    if (String(q.go) === '1') {
      /* L'import ne deplace pas d'argent — pas de motif exige — mais il change
         ce sur quoi les gens parient. Il reste donc un POST journalise. */
      const nonV = gardeEcriture(req, session, 'parisImport', 'x');
      if (nonV) return refusEcriture(res, nonV);
      try {
        /* Les rencontres ne coutent AUCUN credit : ce bouton est gratuit,
           on peut le presser sans compter. */
        const combien = await parisImport.importeMatchs();
        adminlog.ajoute({ acteur, action: 'parisImport', cible: null,
                          apres: `${combien} rencontre(s)`, ip: qui(req) });
        paris.charge();                       // sinon le serveur sert l'ancien
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ lance: true, rencontres: combien,
                                        etat: parisImport.etatImport() }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ lance: true, error: e.message,
                                        etat: parisImport.etatImport() }));
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(parisImport.etatImport()));
  }

  /* ---- LES TRENTE DERNIERS ENVOIS VERS TELEGRAM ----
   *
   * A brancher des qu'une annonce manque. Elle repond a la seule question qui
   * compte et que le code ne peut pas trancher : est-ce que l'appel est PARTI,
   * et qu'est-ce que Telegram a REPONDU ?
   *
   *   actif:false          → TG_BOT_TOKEN ou TG_CHAT_ID n'est pas pose ici
   *   code:400 desc:"...wrong file identifier/HTTP URL specified"
   *                        → l'image est injoignable ou dans un format refuse
   *   code:403             → le robot n'est pas dans le canal, ou en a ete sorti
   *   code:429             → cadence depassee, les envois s'empilent
   *   code:'reseau'        → l'appel n'est jamais arrive jusqu'a Telegram
   *   aucune ligne du tout → l'annonce n'a pas ete declenchee cote jeu
   *
   * Protegee : le carnet porte des noms de joueurs et des montants. */
  if (path === '/tg/journal') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(tg.journal(), null, 2));
  }

  /* Ce que les joueurs touchent vraiment. Sert a reordonner le menu sur des
     chiffres plutot qu'au jugement. Protegee non parce que c'est sensible —
     il n'y a aucune adresse la-dedans — mais parce que c'est un outil
     d'exploitation, et qu'une page publique de plus est une surface de plus. */
  /* ---- LIRE LE JOURNAL ADMIN ----
   *
   * « Un journal qu'on ne lit pas ne sert qu'apres coup. » Il a donc une route
   * et un onglet. Cherchable sur la cible, le motif, le geste et l'acteur :
   * les quatre questions qu'on se pose devant un chiffre faux. */
  /* ---- LES REGLAGES A CHAUD ----
   *
   * Lire est libre ; ecrire est un POST journalise avec l'avant et l'apres.
   * C'est la ligne de journal qui rend ce pouvoir tenable : un reglage qui
   * change sans laisser de trace est un chiffre qu'on ne saura jamais
   * expliquer trois semaines plus tard. */
  if (path === '/reglages') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ reglages: reglages.etat(), fichier: reglages.FICHIER }, null, 2));
    }
    const d = await donPost(req);
    const nonV = gardeEcriture(req, session, 'reglage', d.motif);
    if (nonV) return refusEcriture(res, nonV);
    const r = reglages.pose(d.cle, d.valeur === undefined ? null : d.valeur);
    if (!r.ok) return refusEcriture(res, r.error);
    adminlog.ajoute({ acteur, action: 'reglage', cible: String(d.cle),
                      avant: String(r.avant), apres: String(r.apres),
                      motif: d.motif || (r.remis ? 'remise a la valeur d origine' : ''),
                      ip: qui(req) });
    console.log(`[reglages] ${d.cle} : ${r.avant} -> ${r.apres}${r.remis ? ' (remis)' : ''}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...r, reglages: reglages.etat() }));
  }
  if (path === '/adminlog') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(adminlog.lit({
      q: q.get('q'), action: q.get('action'),
      limite: q.get('limite'), debut: q.get('debut'),
    }), null, 2));
  }
  /* ---- LA FICHE D'UN JOUEUR ----
   *
   * Le panneau n'avait qu'une ligne depliable. « Je n'ai pas recu mon gain »
   * n'avait donc pas de reponse en moins de dix minutes — c'est le message le
   * plus frequent qu'un exploitant recoit, et celui que le panneau soutenait
   * le moins. Tout ce qu'il faut pour repondre tient ici, y compris le journal
   * du joueur, qui existait deja dans journal.js et que rien n'affichait. */
  if (path === '/player') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const a = String(q.get('addr') || '').toLowerCase();
    const cible = /^0x[0-9a-f]{40}$/.test(a) ? a : game.trouveJoueur(q.get('addr'));
    if (!cible) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown player' }));
    }
    let histo = { evenements: [] };
    try { histo = journal.lit(cible, { limite: 120 }); }
    catch (e) { histo = { evenements: [], erreur: e.message }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...game.ficheAdmin(cible), journal: histo }, null, 2));
  }
  if (path === '/taps') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(game.tapsAdmin(), null, 2));
  }

  /* L'etat de la boutique : ce qui reste, et qui detient quoi. */
  if (path === '/boutique/etat') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(game.boutiqueAdmin()));
  }
  if (path === '/paris/aregler') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ matchs: game.parisAregler(Date.now()) }));
  }

  if (path === '/paris/liste') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const r = game.tousParis({
      q: q.get('q'), etat: q.get('etat') || 'tous',
      debut: Number(q.get('debut')) || 0,
      limite: Math.min(200, Number(q.get('limite')) || 50),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }

  if (path === '/paris/regle' || path === '/paris/rembourse') {
    if (!authed) return refuse(req, res, false);
    rate(req, true);
    const q = await donPost(req);
    const geste = path === '/paris/regle' ? 'pariRegle' : 'pariRembourse';
    const nonV = gardeEcriture(req, session, geste, q.motif);
    if (nonV) return refusEcriture(res, nonV);
    try {
      const r = path === '/paris/regle'
        ? game.regleMatch(q.match, q.resultat)
        : game.rembourseMatch(q.match);
      persist();
      if (path === '/paris/regle') notifyBetsSettled(r);
      /* `avant` porte le RESULTAT CHOISI, pas un solde : c'est la seule chose
         qui puisse etre fausse dans ce geste, et la seule qu'on voudra relire
         quand un joueur contestera. */
      adminlog.ajoute({ acteur, action: geste, cible: String(q.match || ''),
                        avant: geste === 'pariRegle' ? String(q.resultat) : null,
                        apres: `${r.payes || 0} paye(s), ${r.total || 0} $SWOGE`,
                        motif: q.motif, ip: qui(req) });
      console.log('[paris]', JSON.stringify(r));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
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
      owedJackpot: fmt(bd.jackpot),          //   les deux cagnottes progressives
      owedJackpotPusher: fmt(bd.jackpotPusher),
      owedJackpotBoulier: fmt(bd.jackpotBoulier),
      ownerSurplus: fmt(pot ? surplus : null), // <-- safe amount you can withdraw
      jackpot: game.jackpotStr(), cagnotteBoulier: game.boulierPotStr(),
      totalStaked: fmt(game.totalStaked()),
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
/* Une exception non rattrapee etait SEULEMENT affichee. Personne ne lit les
   journaux d'un serveur qui repond encore : elle n'apprenait donc rien a
   personne. On la compte, et /health la rapporte. On ne tue pas le processus
   pour autant — un serveur de jeu qui survit a une exception isolee vaut mieux
   qu'un serveur qui redemarre et coupe toutes les parties en cours. */
process.on('unhandledRejection', (e) => {
  console.warn('[unhandledRejection]', e && e.message);
  sante.noteIncident('rejet', e && e.message);
});
process.on('uncaughtException', (e) => {
  /* ---- NE PAS SURVIVRE A UN PORT OCCUPE ----
   *
   * Laisser vivre le processus est le bon choix pour une exception isolee au
   * milieu d'une manche. Ca ne l'est PAS pour une erreur d'ecoute : le serveur
   * n'ecoute alors sur rien et reste en vie comme un processus en bonne sante
   * qui ne sert personne. Sur l'hebergeur, c'est la silhouette d'un
   * deploiement « reussi » qui ne repond a aucun joueur.
   *
   * Le test se fait ICI et pas sur `server.on('error')` : `ws` pose son propre
   * ecouteur d'erreur sur le meme serveur, il passe AVANT, et il releve —
   * l'exception arrive donc au processus sans que le notre ait ete appele.
   * Mesure faite : deux ecouteurs, et seul le premier compte.
   *
   * Trouve en enchainant des tests : un serveur orphelin gardait le port, le
   * suivant echouait en silence, et l'attente d'un port qui ne s'ouvrirait
   * jamais passait pour un test qui rame. */
  if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES') &&
      /listen/i.test(String(e.message || ''))) {
    console.error(`\n[fatal] impossible d ecouter sur le port ${cfg.PORT} : ` +
                  (e.code === 'EADDRINUSE' ? 'il est deja pris par un autre processus.'
                                           : 'permission refusee.') +
                  '\n        Ce serveur ne peut rien servir : il s arrete plutot que de faire semblant.\n');
    process.exit(1);
  }
  console.warn('[uncaughtException]', e && e.message);
  sante.noteIncident('exception', e && e.message);
});
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
  /* ---- « ton filleul vient de te rapporter » ----
   *
   * Sans ca, l'ecran d'invitation se consulte une fois puis s'oublie : les
   * gains murissent en silence, et rien ne rappelle jamais qu'inviter paie.
   * Une note par filleul et par jour, deja limitee a la source.
   *
   * On renvoie l'etat COMPLET du parrainage avec, pour que l'ecran se
   * rafraichisse d'un coup s'il est ouvert. */
  for (const g of game.gainsParrainRecents()) {
    try {
      toAddr(g.parrain, { type: 'referral', ...game.parrainage(g.parrain),
                          rapporte: g.filleul || 'A friend' });
    } catch (e) {}
  }

  const m = game.montéesRecentes();
  for (const x of m) {
    toAddr(x.addr, { type: 'levelUp', niveau: x.a, palier: x.palier,
                     nouveauPalier: x.nouveauPalier, profil: game.niveau(x.addr) });
    /* Le canal n'est prevenu que pour un PALIER franchi : cent annonces de
       niveau par jour ne se lisent plus, dix passages de palier se fetent. */
    if (x.nouveauPalier && x.a >= 20) {
      const p = game._p(x.addr);
      const legende = `⬆️ <b>${p.name} reached ${x.palier}</b> — level ${x.a}\n` +
                `${fmtAmt(String(Math.round(require('./game').Game.volumePour(x.a))))} $SWOGE wagered for life. ` +
                `Only a handful will ever see level 100.`;
      /* AVEC SON VISAGE. Un palier franchi est la seule chose du jeu qui se
         merite sur la duree ; annonce en texte nu, ca ressemble a un journal
         systeme. Avec la tete du joueur, ca ressemble a quelqu'un.
       *
         L'image est celle qu'il a televersee, sinon son badge de palier. Elle
         est prise par son ADRESSE PUBLIQUE — la meme que sert la page de
         profil — donc Telegram va la chercher tout seul, sans qu'on ait a
         charger un fichier depuis le disque.
       *
         `notifyPhoto` retombe sur le texte si Telegram refuse l'image : les
         badges sont en WEBP, que sendPhoto n'accepte pas toujours. Une annonce
         sans photo vaut mieux que pas d'annonce. */
      let image = null;
      try {
        image = require('./profilpage').urlVisage({
          adresse: String(x.addr).toLowerCase(), photo: !!p.photo, visage: p.visage,
        });
      } catch (e) {}
      tg.notifyPhoto(image, legende);
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

      /* ---- LE TABLEAU DES COTES EST PUBLIC ----
         Il est lu AVANT la porte d'authentification, volontairement. Un
         visiteur qui arrive doit pouvoir regarder les matchs et les cotes
         sans avoir branche quoi que ce soit — demander de se connecter pour
         voir un tableau d'affichage, c'est demander de payer pour lire le
         menu. Poser un pari, en revanche, est de l'autre cote de la porte. */
      // ---- les paris sportifs ----
      if (m.type === 'parisListe') {
        return send(ws, { type: 'parisListe',
                          sports: require('./paris').catalogue().sports,
                          matchs: game.parisOuverts(Date.now()),
                          min: cfg.PARI_MIN, max: cfg.PARI_MAX,
                          jambesMax: cfg.PARI_JAMBES_MAX, gainMax: cfg.PARI_GAIN_MAX,
                          mesParis: ws.addr ? game.mesParis(ws.addr, 40) : [] });
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
      if (m.type === 'bj_bet' || m.type === 'bj_hit' || m.type === 'bj_stand' || m.type === 'bj_double' || m.type === 'bj_insure') {
        // SWOGE Blackjack — same shared balance, provably-fair, server-authoritative.
        try {
          let st;
          if (m.type === 'bj_bet') st = game.bjBet(ws.addr, m.amount, m.annexes);
          else if (m.type === 'bj_insure') st = game.bjInsure(ws.addr, m.amount);
          else if (m.type === 'bj_hit') st = game.bjHit(ws.addr);
          else if (m.type === 'bj_stand') st = game.bjStand(ws.addr);
          else st = game.bjDouble(ws.addr);
          persistSoon();
          /* La mise engagee vaut le double quand la main a ete doublee : sans
             ca l'annonce compterait la seconde mise comme du benefice. Les
             paris annexes entrent dans le meme compte — un 21+3 a cent fois la
             mise est precisement ce que la table a envie de voir passer, et
             l'annoncer sans sa mise en gonflerait le net. */
          if (st.stage === 'done') {
            const a = st.annexes || {};
            const miseAnn = (a.pp ? a.pp.mise : 0) + (a.tp ? a.tp.mise : 0) + (a.ins ? a.ins.mise : 0);
            const gainAnn = (a.pp ? a.pp.gain : 0) + (a.tp ? a.tp.gain : 0) + (a.ins ? a.ins.gain : 0);
            const engage = (st.doubled ? st.bet * 2 : st.bet) + miseAnn;
            const rendu = st.payout + gainAnn;
            notifyTableWin(ws.addr, 'bj', { net: rendu - engage, staked: engage,
                                            payout: rendu, note: st.result });
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
          send(ws, { type: 'questClaimed', id: m.id, reward, balance: game.balanceStr(ws.addr),
                     quests: game.questState(ws.addr), niveau: game.niveau(ws.addr),
                     attente: game.enAttente(ws.addr) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      /* Les touches. Aucune reponse : c'est une statistique, pas une action —
         un accuse de reception doublerait le trafic pour rien. */
      if (m.type === 'tap') { game.noteTaps(m.taps); return; }

      /* ---- LE MARCHE ----
       *
       * Quatre messages, et chacun renvoie la VITRINE a jour plutot qu'un
       * simple accuse : une annonce peut disparaitre entre l'affichage et le
       * clic — quelqu'un d'autre l'a achetee — et la page doit le voir tout
       * de suite au lieu de proposer un bouton mort. */
      if (m.type === 'market') {
        return send(ws, { type: 'market', ...game.marcheListe(ws.addr, m.season) });
      }
      if (m.type === 'marketSell' || m.type === 'marketCancel' || m.type === 'marketBuy') {
        let r = null, err = null;
        try {
          if (m.type === 'marketSell') r = game.marcheVend(ws.addr, m.item, m.price, m.qty);
          else if (m.type === 'marketCancel') r = game.marcheAnnule(ws.addr, m.id);
          else r = game.marcheAchete(ws.addr, m.id);
        } catch (e) { err = e.message; }
        if (!err) persistSoon();
        /* Une ligne fermee par un ACHAT s'annonce comme une ligne fermee par
           un coffre : c'est le meme exploit, et le canal ne doit pas laisser
           croire que seul le hasard y mene. */
        if (r && r.ligne) notifyCoffre(ws.addr, { ligne: r.ligne, item: boutique.item(r.item),
                                                  rarete: (boutique.item(r.item) || {}).rarete,
                                                  saison: (boutique.item(r.item) || {}).saison });
        return send(ws, { type: 'market', ...game.marcheListe(ws.addr, m.season),
                          fait: r || undefined, error: err || undefined,
                          balance: game.balanceStr(ws.addr),
                          ...(r && !err ? game.boutiqueEtat(ws.addr, m.season) : {}) });
      }
      /* ---- LE RACHAT INSTANTANE ----
       *
       * Meme forme que le marche, et pour la meme raison : la reponse renvoie
       * l'etat de la boutique, pas un simple « c'est fait ». Un rachat fait
       * bouger trois choses a la fois — le solde, l'inventaire et le nombre
       * d'exemplaires en circulation — et la planche doit les voir ensemble,
       * sans quoi elle afficherait un plafond faux jusqu'au prochain clic. */
      if (m.type === 'buyback') {
        let r = null, err = null;
        try { r = game.boutiqueRachat(ws.addr, m.item, m.qty); }
        catch (e) { err = e.message; }
        if (!err) persistSoon();
        return send(ws, { type: 'buyback', fait: r || undefined, error: err || undefined,
                          balance: game.balanceStr(ws.addr),
                          ...(r && !err ? game.boutiqueEtat(ws.addr, m.season) : {}) });
      }
      if (m.type === 'quests') return send(ws, { type: 'quests', quests: game.questState(ws.addr),
                                                parfait: game.parfaitEtat(ws.addr),
                                                attente: game.enAttente(ws.addr) });
      /* LA JOURNEE PARFAITE. Un message a part et pas un effet de bord de la
         derniere quete reclamee : le coffre doit partir sur un geste, pour
         qu'on le voie s'ouvrir. */
      if (m.type === 'perfectDay') {
        try {
          const r = game.reclameParfait(ws.addr);
          persistSoon();
          if (r.gagne) notifyCoffre(ws.addr, r.gagne);
          return send(ws, { type: 'perfectDay', ...r, parfait: game.parfaitEtat(ws.addr),
                            niveau: game.niveau(ws.addr), balance: game.balanceStr(ws.addr),
                            ...(r.gagne ? game.boutiqueEtat(ws.addr, r.gagne.saison) : {}),
                            attente: game.enAttente(ws.addr) });
        } catch (e) { return send(ws, { type: 'error', error: e.message }); }
      }
      if (m.type === 'bonusState') return send(ws, { type: 'bonus', bonus: game.bonusState(ws.addr),
                                                    attente: game.enAttente(ws.addr),
                                                    offert: game.coffreOffert(ws.addr) });
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
          send(ws, { type: 'streakClaimed', day: r.day, reward: r.reward, xp: r.xp,
                     balance: game.balanceStr(ws.addr), bonus: game.bonusState(ws.addr),
                     niveau: game.niveau(ws.addr), attente: game.enAttente(ws.addr) });
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
      /* LA BOUTIQUE. Deux messages : lire, et ouvrir un coffre.
         `shop` sans rien est une lecture pure — le catalogue et l'inventaire.
         `shopOpen` debite et tire. On repond TOUJOURS par un `shop` complet
         apres l'ouverture, pour que la page n'ait pas a recoller l'inventaire
         elle-meme : elle recoit l'objet gagne ET l'etat qui en decoule. */
      /* ---- LE COFFRE DU JOUR ----
       *
       * Deux messages et pas un : demander l'etat ne doit jamais ouvrir. Un
       * seul message qui ferait les deux ouvrirait le coffre a la premiere
       * connexion du jour, sans que le joueur ait rien touche — et l'ouverture
       * d'un coffre est precisement ce qu'on veut qu'il vienne faire. */
      if (m.type === 'freeChest') {
        return send(ws, { type: 'freeChest', ...game.coffreOffert(ws.addr),
                          attente: game.enAttente(ws.addr) });
      }
      if (m.type === 'freeChestOpen') {
        let gagne;
        try {
          gagne = game.ouvreCoffreOffert(ws.addr);
        } catch (e) { return send(ws, { type: 'freeChest', ...game.coffreOffert(ws.addr),
                                        attente: game.enAttente(ws.addr), error: e.message }); }
        persistSoon();
        notifyCoffre(ws.addr, gagne);
        return send(ws, { type: 'shop', ...game.boutiqueEtat(ws.addr, gagne.saison),
                          balance: gagne.balance, gagne,
                          offert: game.coffreOffert(ws.addr), attente: game.enAttente(ws.addr) });
      }
      if (m.type === 'pending') {
        return send(ws, { type: 'pending', attente: game.enAttente(ws.addr),
                          offert: game.coffreOffert(ws.addr) });
      }
      if (m.type === 'shop') {
        /* L'etat du coffre offert part AVEC la boutique : la carte est en tete
           du panneau, et la demander a part ferait apparaitre le reste avant
           elle — un panneau qui se remplit par morceaux dans le desordre. */
        return send(ws, { type: 'shop', ...game.boutiqueEtat(ws.addr, m.season),
                          balance: game.balanceStr(ws.addr),
                          offert: game.coffreOffert(ws.addr), attente: game.enAttente(ws.addr) });
      }
      if (m.type === 'shopOpen') {
        let gagne;
        try {
          gagne = game.boutiqueAchat(ws.addr, m.chest);
        } catch (e) { return send(ws, { type: 'shop', ...game.boutiqueEtat(ws.addr, m.season),
                                        balance: game.balanceStr(ws.addr), error: e.message }); }
        persistSoon();
        notifyCoffre(ws.addr, gagne);
        /* L'etat rendu est celui de la saison du COFFRE, pas de la saison
           demandee : on vient d'ouvrir une caisse d'armes, la planche qui
           s'affiche derriere doit etre celle des armes. */
        return send(ws, { type: 'shop', ...game.boutiqueEtat(ws.addr, gagne.saison),
                          balance: gagne.balance, gagne });
      }
      /* ---- LES SKINS ----
       *
       * Rien a voir avec les saisons : pas de tirage, pas de coffre, pas de
       * `season` dans le message. Un catalogue fixe, disponible en
       * permanence, et un achat direct. */
      if (m.type === 'skins') {
        return send(ws, { type: 'skins', ...game.skinsEtat(ws.addr) });
      }
      if (m.type === 'skinBuy') {
        let r = null, err = null;
        try { r = game.acheteSkin(ws.addr, m.id); }
        catch (e) { err = e.message; }
        if (!err) { persistSoon(); notifySkinBuy(ws.addr, r); }
        return send(ws, { type: 'skins', ...game.skinsEtat(ws.addr),
                          balance: game.balanceStr(ws.addr), error: err || undefined,
                          achete: err ? undefined : r.id });
      }
      if (m.type === 'skinChoisi') {
        try { game.choisitSkin(ws.addr, m.id); }
        catch (e) { return send(ws, { type: 'skins', ...game.skinsEtat(ws.addr), error: e.message }); }
        persistSoon();
        return send(ws, { type: 'skins', ...game.skinsEtat(ws.addr) });
      }
      /* ---- LE PERSONNAGE ----
       *
       * Un skin, sa progression et son equipement. `m.skin` designe LEQUEL —
       * un joueur en possede jusqu'a six, chacun avec sa propre fiche. */
      if (m.type === 'personnage') {
        const r = game.personnageEtat(ws.addr, m.skin);
        return send(ws, { type: 'personnage', skin: m.skin, etat: r });
      }
      /* Les quatre emplacements d'equipement partagent une seule route : le
         type de message dit lequel, `ROUTES_EQUIPE` dit quelle methode
         appeler. Un cinquieme emplacement (une armure de dos, disons)
         n'ajoutera qu'une ligne ici, jamais un nouveau bloc if. */
      const ROUTES_EQUIPE = {
        equipeFruit: (a, s, i) => game.equipeFruit(a, s, i),
        equipeArme: (a, s, i) => game.equipeArme(a, s, i),
        equipeArmure: (a, s, i) => game.equipeArmure(a, s, i),
        equipeBague: (a, s, i) => game.equipeBague(a, s, i),
      };
      if (ROUTES_EQUIPE[m.type]) {
        let r = null, err = null;
        try { r = ROUTES_EQUIPE[m.type](ws.addr, m.skin, m.item); }
        catch (e) { err = e.message; }
        if (!err) persistSoon();
        return send(ws, { type: 'personnage', skin: m.skin, etat: r,
                          error: err || undefined });
      }
      /* La liste de ce qu'il y a a equiper — fruits, armes, armures et
         bagues possedes, quelle que soit la saison ouverte dans la boutique
         en ce moment. */
      if (m.type === 'equipable') {
        return send(ws, { type: 'equipable', ...game.equipablesPour(ws.addr) });
      }
      /* ---- LE NEXUS : QUI EST LA, ET OU ----
       *
       * Le skin n'est JAMAIS pris a la parole du client : il vient de
       * `skinActif`, la meme valeur que rend `skins`. Un joueur ne peut donc
       * pas se faire passer pour un autre personnage aux yeux des autres —
       * il n'y a tout simplement pas de champ ou l'ecrire. */
      if (m.type === 'nexusJoin') {
        if (!ws.addr) return;
        ws.nexusEtat = { x: 1280, y: 1228, dir: 'down', anim: 'idle' };
        nexusClients.add(ws);
        return;
      }
      if (m.type === 'nexusMove') {
        if (!ws.addr || !nexusClients.has(ws)) return;
        const x = Number(m.x), y = Number(m.y);
        ws.nexusEtat = {
          x: Number.isFinite(x) ? Math.max(-2000, Math.min(6000, x)) : 0,
          y: Number.isFinite(y) ? Math.max(-2000, Math.min(6000, y)) : 0,
          dir: NEXUS_DIRS.has(m.dir) ? m.dir : 'down',
          anim: NEXUS_ANIMS.has(m.anim) ? m.anim : 'idle',
        };
        return;
      }
      /* ---- LE MONDE DE COMBAT ----
       *
       * Trois messages, et pas un de plus : entrer, dire ou l'on est, tirer.
       * Le client ne dit JAMAIS qu'il a touche, tue, ou perdu de la vie —
       * c'est le serveur qui constate. Des objets payes en vrai $SWOGE
       * disparaissent a la mort ; laisser le navigateur annoncer un resultat
       * reviendrait a lui laisser decider s'il les garde.
       */
      /* ---- RANGER AU COFFRE, ET REPRENDRE ----
       * Le seul geste qui change le RISQUE d'un objet : le sac part avec le
       * personnage s'il meurt, le coffre survit. On renvoie l'inventaire
       * complet pour que le panneau n'ait rien a deviner. */
      /* ---- LES POTIONS ----
       * Achat a prix fixe, et consommation. Boire SOIGNE dans le monde :
       * c'est la seule chose que ce message change, et c'est le serveur qui
       * la pose sur le joueur en jeu — le client ne fait que demander. */
      if (m.type === 'potionAchat') {
        if (!ws.addr) return;
        let err = null, r = null;
        try { r = game.achetePotion(ws.addr, m.cle, m.qte); persistSoon(); }
        catch (e) { err = e.message; }
        return send(ws, { type: 'equipable', ...game.equipablesPour(ws.addr),
                          balance: game.balanceStr(ws.addr),
                          achat: r || undefined, error: err || undefined });
      }
      if (m.type === 'potionBoit') {
        if (!ws.addr) return;
        let r = null;
        try { r = game.boitPotion(ws.addr, m.cle); persistSoon(); }
        catch (e) { return send(ws, { type: 'equipable', ...game.equipablesPour(ws.addr),
                                      error: e.message }); }
        /* Si on est dans le monde, la vie soignee est celle du COMBAT — pas
           un chiffre d'interface. Hors du monde, la potion serait bue pour
           rien : on la refuse plutot que de la gaspiller en silence. */
        const j = realm.joueurs.get(ws.addr);
        let pv = null, mp = null;
        if (j && r.quoi === 'hp') { j.pv = Math.min(j.pvMax, j.pv + r.soigne); pv = j.pv; }
        /* La potion de mana rendait un chiffre d'interface et rien d'autre :
           la reserve du COMBAT ne bougeait pas. Tant que le mana ne servait a
           rien, ca ne se voyait pas ; maintenant qu'il paie le pouvoir du
           fruit, une potion bue pour rien serait dix $SWOGE jetes. */
        if (j && r.quoi === 'mp') { j.mp = Math.min(j.mpMax, j.mp + r.soigne); mp = j.mp; }
        return send(ws, { type: 'potionBue', ...r, pv, mp,
                          potions: game.potionsPour(ws.addr) });
      }
      if (m.type === 'rangeCoffre' || m.type === 'sortCoffre') {
        if (!ws.addr) return;
        let err = null;
        try {
          if (m.type === 'rangeCoffre') game.rangeAuCoffre(ws.addr, m.item);
          else game.sortDuCoffre(ws.addr, m.item);
          persistSoon();
        } catch (e) { err = e.message; }
        return send(ws, { type: 'equipable', ...game.equipablesPour(ws.addr),
                          error: err || undefined });
      }
      if (m.type === 'realmJoin') {
        if (!ws.addr) return;
        const p = game._p(ws.addr);
        const skin = p.skinActif;
        /* Sans personnage, pas de monde : on n'y entre pas « en spectateur »,
           et arriver sans stats donnerait un joueur a zero point de vie. */
        if (!skin || !p.skins || !p.skins[skin]) {
          return send(ws, { type: 'realmRefus', raison: 'no-character' });
        }
        const etat = game.personnageEtat(ws.addr, skin);
        if (!etat) return send(ws, { type: 'realmRefus', raison: 'no-character' });
        const arme = etat.equipArme;
        const j = realm.rejoint(ws.addr, {
          skin, nom: p.name || null,
          stats: etat.stats,
          famille: (arme && arme.famille) || 'poing',
          degats: (arme && arme.degats) || monde.DEGATS_POING,
          /* Le POUVOIR vient du fruit, et le fruit est deja dans la fiche.
             On envoie sa stat principale plutot que le pouvoir lui-meme :
             la regle « quelle stat donne quel pouvoir » appartient a
             monde.js, et la dupliquer ici la ferait deriver. */
          statFruit: (etat.equipFruit && etat.equipFruit.stat) || null,
        });
        ws.realmSkin = skin;
        realmClients.add(ws);
        realmDernierMouv.set(ws.addr, Date.now());
        /* La carte et les armes partent A L'ENTREE, pas dans le `hello` : un
           joueur qui ne met jamais les pieds dans le monde n'a pas a
           telecharger sa description. */
        return send(ws, { type: 'realmEntre',
                          monde: { w: monde.MONDE.w, h: monde.MONDE.h, tuile: monde.TUILE },
                          anneaux: monde.ANNEAUX, centre: monde.CENTRE,
                          armes: monde.ARMES, especes: monde.MONSTRES,
                          /* La table des pouvoirs part a l'entree, comme celle
                             des armes : le client doit pouvoir ecrire « 60 MP »
                             sur le bouton sans connaitre le chiffre par coeur. */
                          pouvoirs: monde.POUVOIRS,
                          /* La duree de la paralysie part avec le reste : la
                             page dessine un anneau qui se referme, et elle a
                             besoin du total pour savoir ou il en est. Un
                             chiffre en dur cote page finirait par ne plus
                             etre celui que le serveur applique. */
                          paralysie: monde.PARALYSIE,
                          /* La table complete des etats : la page a besoin du
                             facteur de ralentissement pour freiner elle-meme,
                             et des durees pour dessiner ce qui reste. Un
                             chiffre ecrit cote page finirait par ne plus etre
                             celui qu'on subit. */
                          effets: monde.EFFETS,
                          /* La regle des sacs part avec le reste : la page
                             dessine la minute qui s'ecoule et le halo de
                             ramassage. Sans ces chiffres elle les inventerait,
                             et elle finirait par promettre un rayon que le
                             serveur n'accorde pas — le pire des mensonges,
                             celui qui donne l'impression d'un bug. */
                          sac: monde.SAC,
                          /* L'ORDRE des stats, parce que c'est celui des
                             colonnes de objets/potions_stat.webp : rouge = hp,
                             bleue = mp, epee = att, bouclier = def, ailes =
                             spd, verte = dex, coeur = vit, oeil = wis. La page
                             dessine la bonne fiole en cherchant l'index de la
                             stat dans cette liste. L'ecrire en dur la-bas
                             aurait fait deux ordres a garder d'accord, et le
                             desaccord serait silencieux : une potion de
                             defense sous l'image d'une potion de vitesse. */
                          stats: personnages.STATS,
                          moi: { x: Math.round(j.x), y: Math.round(j.y),
                                 pv: j.pv, pvMax: j.pvMax,
                                 mp: j.mp, mpMax: j.mpMax,
                                 pouvoir: j.pouvoir || null,
                                 /* Sa vitesse des l'entree : sans elle, la page
                                    court a 260 pendant la fraction de seconde
                                    qui precede le premier `realmEtat`, et un
                                    personnage lent se fait ramener en arriere
                                    des son premier pas. */
                                 v: Math.round(j.vitesse),
                                 famille: j.famille } });
      }
      if (m.type === 'realmLeave') {
        if (!ws.addr) return;
        realm.quitte(ws.addr);
        realmClients.delete(ws);
        realmDernierMouv.delete(ws.addr);
        return send(ws, { type: 'realmSorti' });
      }
      /* ---- RAMASSER ----
       * Le client dit « je ramasse », rien d'autre : ni quel sac, ni ce qu'il
       * contient. La distance, le choix du sac et le contenu se tranchent
       * ici. Laisser le client nommer le sac aurait suffi a s'attribuer
       * n'importe quoi depuis l'autre bout de la carte — et les sacs sont
       * exactement ce qu'on aurait interet a voler. */
      if (m.type === 'realmRamasse') {
        if (!ws.addr || !realmClients.has(ws)) return;
        const skin = ws.realmSkin;
        const plafondPotion = (cle) => {
          const l = game.potionsPour(ws.addr).filter((x) => x.cle === cle)[0];
          return l ? l.quantite < l.max : false;
        };
        /* On REFUSE avant de prendre : une potion d'attaque prise a son
           plafond serait bue pour rien et la place serait videe. Refusee,
           elle reste dans le sac, qui finit sa minute. */
        const r = realm.ramasse(ws.addr, null, (o) => {
          if (o.stat) return game.supRestant(ws.addr, skin, o.stat) > 0 ? true : 'plein';
          if (o.potion) return plafondPotion(o.potion) ? true : 'plein';
          return true;
        }, m.i, m.place);
        if (!r) return send(ws, { type: 'realmRamasse', rien: true });
        if (r.refuse) {
          return send(ws, { type: 'realmRamasse', refus: r.raison,
                            sac: r.sac, stat: r.stat, potion: r.potion });
        }
        try {
          if (r.stat) {
            const b = game.boitStat(ws.addr, skin, r.stat);
            persistSoon();
            /* La fiche repart EN ENTIER, dans la forme que la page connait
               deja ({skin, etat}) : la stat vient de changer, et le panneau
               doit le montrer sans qu'on la lui recalcule. Inventer ici une
               forme de message que personne n'ecoute aurait donne une potion
               bue dont l'effet n'apparait qu'au prochain rechargement. */
            send(ws, { type: 'personnage', skin, etat: game.personnageEtat(ws.addr, skin) });
            /* `vide` dit a la page de refermer la grille : sans lui, une fiole
               resterait dessinee sur une place qui n'existe plus, et le clic
               suivant irait dans le vide. */
            return send(ws, { type: 'realmRamasse', sac: r.sac, stat: r.stat, vide: r.vide, ...b });
          }
          if (r.potion) {
            const b = game.donnePotion(ws.addr, r.potion);
            persistSoon();
            /* La pile complete voyage AVEC la reponse, comme elle le fait
               deja sur `potionBue` : c'est le meme besoin, et un second type
               de message pour la meme chose se serait desynchronise. */
            return send(ws, { type: 'realmRamasse', sac: r.sac, potion: r.potion,
                              vide: r.vide, ...b,
                              potions: game.potionsPour(ws.addr) });
          }
          return send(ws, { type: 'realmRamasse', sac: r.sac });
        } catch (e) {
          return send(ws, { type: 'realmRamasse', refus: e.message, sac: r.sac });
        }
      }
      if (m.type === 'realmMove') {
        if (!ws.addr || !realmClients.has(ws)) return;
        const t = Date.now();
        const avant = realmDernierMouv.get(ws.addr) || t;
        realmDernierMouv.set(ws.addr, t);
        realm.bouge(ws.addr, m.x, m.y,
                    NEXUS_DIRS.has(m.dir) ? m.dir : 'down',
                    NEXUS_ANIMS.has(m.anim) ? m.anim : 'idle',
                    (t - avant) / 1000);
        return;
      }
      if (m.type === 'realmTir') {
        if (!ws.addr || !realmClients.has(ws)) return;
        const a = Number(m.a);
        if (!Number.isFinite(a)) return;
        realm.tire(ws.addr, a);
        return;
      }
      /* La barre d'espace. Le client n'envoie RIEN d'autre que « j'appuie » :
         quelle cible, quels degats, combien de mana, c'est ici que ca se
         tranche — sinon la console suffirait a lancer un eclair par image.
         La reponse part toujours, meme sur un refus : une touche qui ne
         repond pas se lit comme un bug, pas comme un manque de mana. */
      if (m.type === 'realmPouvoir') {
        if (!ws.addr || !realmClients.has(ws)) return;
        const ev = { touches: [], kills: [] };
        const r = realm.pouvoir(ws.addr, ev);
        if (!r) return;
        send(ws, { type: 'realmPouvoir', ...r });
        /* Un eclair qui tue rapporte l'XP par le meme chemin qu'une fleche :
           `gagneXpCombat`, pas un raccourci a cote. */
        for (const k of ev.kills) {
          try {
            const g = game.gagneXpCombat(k.addr, ws.realmSkin, k.xp);
            if (g) {
              send(ws, { type: 'realmKill', espece: k.espece, xp: k.xp,
                         total: g.total, niveau: g.niveau, monte: g.monte });
              if (g.monte) persistSoon();
            }
          } catch (e) { console.error('[realm pouvoir xp]', e && e.message); }
        }
        for (const t of ev.touches) {
          /* Le POINT du coup part avec : sans lui, la page sait qu'elle a touche
         mais pas OU, et ne peut poser aucun eclat. C'est ce qui faisait que
         le geste le plus frequent du jeu — tirer sur un monstre — ne
         produisait rien a l'ecran, seulement un son. */
      send(ws, { type: 'realmTouche', espece: t.espece, perte: t.perte, pv: t.pv,
                 x: Math.round(t.x), y: Math.round(t.y) });
        }
        return;
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
        /* Les paris ne se servent PAS depuis le journal. Un pari change
           d'etat apres avoir ete ecrit — pose, puis gagne, perdu ou
           rembourse — et un journal ne se reecrit pas : la ligne « pose »
           dirait « en cours » pour toujours. On les prend donc dans le
           moteur, ou l'etat est celui d'aujourd'hui. */
        if (m.kind === 'bo' || m.kind === 'bs') {
          const regles = m.kind === 'bs';
          const tous = game.mesParis(ws.addr, 5000).filter((p) => !!p.regle === regles);
          /* Ici le curseur est un RANG dans la liste, pas une position dans
             un fichier : la liste est reconstruite a chaque demande. */
          const debut = Number.isFinite(Number(m.cursor)) ? Math.max(0, Number(m.cursor)) : 0;
          const page = tous.slice(debut, debut + Math.min(50, Number(m.limit) || 25));
          return send(ws, {
            type: 'history', kind: m.kind,
            items: page.map((p) => Object.assign({ k: 'pa' }, p)),
            cursor: debut + page.length,
            more: debut + page.length < tous.length,
            summary: { lignes: tous.length, mot: 'bet',
                       depuis: tous.length ? tous[tous.length - 1].t : null },
          });
        }
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

      // ---- boulier ----
      if (m.type === 'boulierEtat') {
        send(ws, { type: 'boulier', etat: game.boulierEtat(Date.now(), ws.addr),
                   bareme: game.boulierBareme() });
        return;
      }
      if (m.type === 'boulierJoue') {
        try {
          const r = game.boulierInscrit(ws.addr, m.grids, Date.now());
          persistSoon();
          send(ws, { type: 'boulier', etat: r.etat, balance: game.balanceStr(ws.addr) });
          /* La salle change des qu'un joueur s'inscrit : le compteur, la mise
             totale et le classement bougent pour TOUT LE MONDE, pas seulement
             pour celui qui vient de payer. C'est la moitie de l'interet d'un
             tirage partage. */
          boulierDiffuse();
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
             c'est la seule facon qu'un joueur seul trouve quelqu'un.
             AVEC L'IMAGE DU JEU, comme les annonces de gain. Une table qui
             attend est le seul message du canal qui demande une reponse tout
             de suite — deux lignes de texte au milieu d'annonces illustrees
             passaient inapercues, et une table que personne ne rejoint finit
             par etre annulee. */
          tg.notifyPhoto(imageJeu('p4'),
                    `\u2694\ufe0f <b>Connect 4</b>\n${escHtml(game._p(ws.addr).name)} is waiting for an opponent\n` +
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
          /* Le Connect 4 nomme sa colonne `col` la ou les cinq autres duels
             envoient `coup`. On accepte les deux : la page d'entrainement est
             la meme page, et lui demander de changer de vocabulaire selon
             l'adversaire serait une regle de plus a retenir. */
          const ent = entSienne(ws, m.id);
          if (ent) {
            const r = game.entrainementJouer(ws.addr, m.col != null ? m.col : m.coup, Date.now());
            if (r.prime && r.prime.prime > 0) persistSoon();
            return entRepond(ws, ent.jeu, r.prime);
          }
          const r = game.p4Jouer(ws.addr, m.id, m.col, Date.now());
          if (r.reglement) persistSoon();
          p4Pousse(r.partie, r.reglement);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'p4Resign') {
        try {
          const ent = entSienne(ws, m.id);
          if (ent) { game.entrainementAbandonner(ws.addr, Date.now()); return entRepond(ws, ent.jeu); }
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
        /* Pas de table payante ? On regarde l'entrainement avant de repondre
           « rien ». Sans ca, rafraichir la page pendant une partie contre le
           bot l'efface de l'ecran alors qu'elle tourne toujours, et le joueur
           croit l'avoir perdue. */
        if (!id) {
          const ent = ws.addr ? game.entrainement.mienne(ws.addr) : null;
          if (ent && ent.jeu === 'p4') return entRepond(ws, 'p4');
        }
        return send(ws, { type: 'p4Match', match: id ? game.p4Etat(id, Date.now()) : null });
      }

      // ---- morpion et dames (memes regles d'argent que le Connect 4) ----
      if (m.type === 'duelCreate') {
        try {
          const jeu = duelDemande(m.jeu);
          const partie = game.duelCreer(jeu, ws.addr, m.bet, Date.now());
          persistSoon();
          send(ws, { type: 'duelMatch', match: game.duelEtat(partie.id, Date.now(), ws.addr),
                     balance: game.balanceStr(ws.addr) });
          duelDiffuseLobby(jeu);
          /* Meme annonce illustree que le Connect 4. La cle du duel EST celle
             de l'image — 'mp', 'dm', 'mf', 'dc' — donc un cinquieme jeu
             ajoute a DUELS_OUVERTS est annonce avec sa vignette sans qu'on
             touche a cette ligne. */
          tg.notifyPhoto(imageJeu(jeu),
                    `\u2694\ufe0f <b>${NOM_DUEL[jeu]}</b>\n${escHtml(game._p(ws.addr).name)} is waiting for an opponent\n` +
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
          send(ws, { type: 'duelMatch', match: game.duelEtat(partie.id, Date.now(), ws.addr),
                     balance: game.balanceStr(ws.addr) });
          duelPousseInvites(partie.reserve, partie.jeu);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'duelCancel') {
        try {
          const partie = game.duelAnnuler(ws.addr, m.id, Date.now());
          persistSoon();
          send(ws, { type: 'duelMatch', match: game.duelEtat(partie.id, Date.now(), ws.addr),
                     balance: game.balanceStr(ws.addr) });
          if (partie.reserve) duelPousseInvites(partie.reserve, partie.jeu);
          else duelDiffuseLobby(partie.jeu);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'duelInvites') return duelPousseInvites(ws.addr, duelDemande(m.jeu));
      if (m.type === 'duelPlay') {
        try {
          /* La table d'entrainement passe par le meme message que la table
             payante : la page n'a donc rien a savoir, et il n'y a pas deux
             chemins de coup a garder d'accord. L'aiguillage tient dans
             l'identifiant, qui n'appartient qu'a ce joueur. */
          const ent = entSienne(ws, m.id);
          if (ent) {
            const r = game.entrainementJouer(ws.addr, m.coup, Date.now());
            if (r.prime && r.prime.prime > 0) persistSoon();
            return entRepond(ws, ent.jeu, r.prime);
          }
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
          const ent = entSienne(ws, m.id);
          if (ent) { game.entrainementAbandonner(ws.addr, Date.now()); return entRepond(ws, ent.jeu); }
          const r = game.duelAbandonner(ws.addr, m.id, Date.now());
          persistSoon();
          duelPousse(r.partie, r.reglement);
          duelDiffuseLobby(r.partie.jeu);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'parie') {
        if (!ws.addr) return send(ws, { type: 'error', error: 'connect first' });
        try {
          /* Un bulletin, une ou plusieurs selections. Le simple reste accepte
             tel quel : les pages en service l'envoient encore. */
          const pari = Array.isArray(m.selections)
            ? game.parieCombine(ws.addr, m.selections, m.mise, Date.now())
            : game.parie(ws.addr, m.match, m.choix, m.mise, Date.now());
          persistSoon();
          notifyBetPlaced(ws.addr, pari);
          send(ws, { type: 'pariPose', pari, balance: game.balanceStr(ws.addr),
                     matchs: game.parisOuverts(Date.now()),
                     mesParis: game.mesParis(ws.addr, 40) });
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
            if (m.type === 'duelsTous') return send(ws, tousDuels());
      if (m.type === 'duelLobby') {
        const jeu = duelDemande(m.jeu);
        return send(ws, { type: 'duelLobby', jeu, tables: game.duelLobby(jeu) });
      }
      if (m.type === 'duelState') {
        const mienne = game.duelMienne(ws.addr);
        const id = m.id || (mienne && mienne.id);
        /* Meme raison qu'au Connect 4 : une partie d'entrainement en cours
           survit a un rafraichissement de page. */
        if (!id) {
          const ent = ws.addr ? game.entrainement.mienne(ws.addr) : null;
          if (ent && ent.jeu !== 'p4') return entRepond(ws, ent.jeu);
        }
        return send(ws, { type: 'duelMatch', match: id ? game.duelEtat(id, Date.now(), ws.addr) : null });
      }

      // ---- le mode entrainement : les memes jeux, contre un bot, gratuits ----
      /*
       * ---- POURQUOI CES REPONSES S'APPELLENT « p4Match » ET « duelMatch » ----
       *
       * Les six pages savent deja peindre une table de duel : le plateau, les
       * deux visages, la pendule, le vainqueur. Leur envoyer un message d'un
       * NOUVEAU type aurait demande d'ecrire, dans chacune des six, un second
       * afficheur a cote du premier — six copies a garder d'accord, sur des
       * pages de trois mega-octets.
       *
       * On renvoie donc l'etat d'entrainement sous le nom que la page attend
       * deja, et elle le dessine sans savoir que l'adversaire est un bot. Ce
       * n'est pas un deguisement : c'est LA MEME CHOSE — le meme moteur de
       * regles, le meme etat, la meme pendule. Seuls la mise (zero) et
       * l'adversaire changent, et l'etat le dit (`entrainement`, `gratuit`,
       * `botJeton`) pour les pages qui voudront l'annoncer.
       *
       * Aucun de ces messages n'appelle persistSoon() : une table
       * d'entrainement ne se sauvegarde pas, et faire ecrire le magasin pour
       * des parties qui ne valent rien userait le disque pour rien.
       */
      if (m.type === 'entrainementStart') {
        if (!ws.addr) return send(ws, { type: 'error', error: 'connect first' });
        try {
          const t = game.entrainementOuvrir(ws.addr, m.jeu, Date.now());
          entRepond(ws, t.jeu);
        } catch (e) { send(ws, { type: 'error', error: e.message }); }
        return;
      }
      if (m.type === 'entrainementQuit') {
        const t = ws.addr ? game.entrainement.mienne(ws.addr) : null;
        const jeu = t ? t.jeu : 'p4';
        if (ws.addr) game.entrainementFermer(ws.addr);
        return send(ws, { type: entMsg(jeu), match: null });
      }
      if (m.type === 'entrainementState') {
        if (!ws.addr) return send(ws, { type: 'duelMatch', match: null });
        const t = game.entrainement.mienne(ws.addr);
        return entRepond(ws, t ? t.jeu : 'p4');
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
    nexusClients.delete(ws);
    if (ws.addr) { realm.quitte(ws.addr); realmDernierMouv.delete(ws.addr); }
    realmClients.delete(ws);
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
        tg.notifyPhoto(imageJeu('pusher'), `🏆 <b>Coin Pusher</b>\n${w.ownerName} just won <b>${w.value} $SWOGE</b> 🐕` + lienJeu('pusher'));
    }
  }
}, Math.round(1000 / cfg.TABLE.stepHz));

// ---- broadcast loop ----
const bcInterval = setInterval(() => {
  broadcast({ type: 'state', ...table.snapshot() });
}, Math.round(1000 / cfg.BROADCAST_HZ));

/* ---- le Nexus : un instantane complet, pas des evenements a tenir a jour
 *
 * Chaque tick porte TOUT le monde present, aux memes clients. Un depart ne
 * demande donc aucun message dedie : le prochain instantane ne contient
 * simplement plus la socket fermee. C'est plus simple qu'un couple
 * entree/sortie a garder synchronise, et l'echelle visee — quelques joueurs
 * a la fois dans un hall — rend le cout d'un instantane complet negligeable. */
const nexusInterval = setInterval(() => {
  if (!nexusClients.size) return;
  const joueurs = [];
  for (const ws of nexusClients) {
    if (ws.readyState !== 1 || !ws.addr || !ws.nexusEtat) continue;
    const e = ws.nexusEtat;
    const p = game._p(ws.addr);
    /* Le NOM part avec la position : la liste « joueurs a proximite » du
       panneau montre des gens, pas des adresses. Il vient du serveur pour la
       meme raison que le skin — c'est lui qui sait qui est qui, et un nom
       envoye par le client se choisirait tout seul. */
    joueurs.push({ addr: ws.addr, x: Math.round(e.x), y: Math.round(e.y),
                    dir: e.dir, anim: e.anim, skin: p.skinActif || 'andy',
                    nom: p.name || null });
  }
  const s = JSON.stringify({ type: 'nexusEtat', joueurs });
  for (const ws of nexusClients) if (ws.readyState === 1) ws.send(s);
}, 150);
if (nexusInterval.unref) nexusInterval.unref();

/* ---------------------------------------------- LA BOUCLE DU MONDE
 *
 * Dix fois par seconde : on avance les monstres et les projectiles, on
 * applique les CONSEQUENCES, puis on envoie a chacun ce qu'il voit.
 *
 * `realm.pas()` ne touche a rien qui compte — il RETOURNE des evenements.
 * C'est ici qu'on credite de l'XP et qu'on fait mourir un personnage, parce
 * que seul ce fichier a le droit d'appeler game.js. La simulation reste ainsi
 * testable sans solde ni fichier d'etat.
 *
 * La boucle tourne meme sans personne : les monstres continuent de vivre, et
 * on entre dans un endroit qui existait avant nous.
 */
let realmHorloge = Date.now();
const realmInterval = setInterval(() => {
  const t = Date.now();
  const dt = Math.min(0.5, (t - realmHorloge) / 1000);
  realmHorloge = t;
  let ev;
  try { ev = realm.pas(dt); } catch (e) { console.error('[realm]', e && e.message); return; }

  /* ---- CE QU'ON A TUE DEVIENT DE L'XP ----
     Le client n'a rien annonce : il a demande a tirer, le serveur a constate
     la mort du monstre. C'est toute la difference entre un jeu ou l'on peut
     se donner des niveaux et un jeu ou l'on ne peut pas. */
  for (const k of ev.kills) {
    const ws = [...realmClients].find((c) => c.addr === k.addr);
    if (!ws) continue;
    try {
      const r = game.gagneXpCombat(k.addr, ws.realmSkin, k.xp);
      if (r) {
        send(ws, { type: 'realmKill', espece: k.espece, xp: k.xp,
                   total: r.total, niveau: r.niveau, monte: r.monte });
        if (r.monte) persistSoon();
      }
    } catch (e) { console.error('[realm xp]', e && e.message); }
  }

  /* ---- ET CE QUI NOUS TUE COUTE TOUT ----
     `meurt` detruit l'equipement porte, vide le sac, remet le personnage a
     zero et encaisse la fame. On sort le joueur du monde APRES : le laisser
     dedans avec zero point de vie le ferait mourir en boucle. */
  for (const mort of ev.morts) {
    const ws = [...realmClients].find((c) => c.addr === mort.addr);
    realm.quitte(mort.addr);
    realmDernierMouv.delete(mort.addr);
    if (ws) realmClients.delete(ws);
    try {
      const r = game.meurt(mort.addr, ws ? ws.realmSkin : null);
      persistSoon();
      if (ws && ws.readyState === 1) {
        send(ws, { type: 'realmMort', par: mort.par, ...r });
        /* La fiche repart avec : l'equipement vient d'etre detruit et le
           niveau remis a zero. Sans ce renvoi, le panneau continuerait
           d'afficher des objets que le joueur ne possede plus. */
        send(ws, { type: 'skins', ...game.skinsEtat(ws.addr) });
      }
    } catch (e) { console.error('[realm mort]', e && e.message); }
  }

  /* ---- LES COUPS PORTES ----
     On les annonce au TIREUR seul : c'est son coup, et diffuser chaque
     touche a tout le monde ferait un vacarme sans rapport avec ce que
     chacun fait. */
  for (const t of ev.touches) {
    const ws = [...realmClients].find((c) => c.addr === t.addr);
    if (ws && ws.readyState === 1) {
      /* Le POINT du coup part avec : sans lui, la page sait qu'elle a touche
         mais pas OU, et ne peut poser aucun eclat. C'est ce qui faisait que
         le geste le plus frequent du jeu — tirer sur un monstre — ne
         produisait rien a l'ecran, seulement un son. */
      send(ws, { type: 'realmTouche', espece: t.espece, perte: t.perte, pv: t.pv,
                 x: Math.round(t.x), y: Math.round(t.y) });
    }
  }

  if (ev.degats.length) {
    for (const d of ev.degats) {
      const ws = [...realmClients].find((c) => c.addr === d.addr);
      if (ws && ws.readyState === 1) {
        /* `paralyse` part avec le coup : c'est le seul moment ou la page
           apprend qu'elle vient de perdre le deplacement, et perdre le
           controle sans un mot se lit comme une panne. */
        send(ws, { type: 'realmCoup', perte: d.perte, pv: d.pv, par: d.par,
                   /* `quoi` dit si c'est une morsure, un projectile ou la
                      brulure : la page ne joue pas le meme son pour les
                      trois, et une brulure qui grognerait comme une morsure
                      donnerait l'impression d'etre mordu par du vide. */
                   quoi: d.quoi || 'contact',
                   effet: d.effet || null, duree: d.duree || 0,
                   /* Le mana vole part avec le coup : la page doit pouvoir le
                      dire au moment ou ca arrive, pas laisser la barre baisser
                      sans explication. */
                   mp: d.mp || 0,
                   paralyse: d.paralyse || 0 });
      }
    }
  }

  /* La carte se repeuple doucement, jamais sous le nez de quelqu'un. */
  if (realmClients.size) realm.repeuple(900);

  /* Chacun recoit SA vue : on ne diffuse pas un instantane commun comme le
     Nexus le fait. Quarante monstres a dix images par seconde pour chaque
     client, dont trente-cinq hors de son ecran, serait du trafic pur — et le
     monde fait quatre fois la taille du hall. */
  for (const ws of realmClients) {
    if (ws.readyState !== 1 || !ws.addr) continue;
    const vue = realm.etatPour(ws.addr, 1400);
    if (vue) ws.send(JSON.stringify({ type: 'realmEtat', ...vue }));
  }
}, 100);
if (realmInterval.unref) realmInterval.unref();

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
/* La pendule des tables d'entrainement. Elle vit a cote de celle des duels
   plutot que dedans : les duels sauvegardent et diffusent au salon, une table
   d'entrainement ne fait ni l'un ni l'autre, et les melanger ferait ecrire le
   magasin pour des parties qui ne valent rien. */
const entrainementInterval = setInterval(() => {
  try {
    for (const f of game.entrainementTick(Date.now())) {
      const o = { type: entMsg(f.partie.jeu),
                  match: game.entrainementEtat(f.addr, Date.now()) };
      if (f.prime) { o.prime = f.prime; o.balance = game.balanceStr(f.addr); }
      toAddr(f.addr, o);
    }
  } catch (e) { console.error('entrainement tick', e && e.message); }
}, 1000);
if (entrainementInterval.unref) entrainementInterval.unref();

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

/* ---- boulier : la salle partagee ----
 * Une seconde suffit : les trois phases durent dix secondes ou plus, et le
 * decompte est calcule par le navigateur depuis l'echeance qu'on lui envoie.
 * Le TIRAGE, lui, part en une seule fois — les trente boules sont dans
 * l'evenement, et c'est le navigateur qui les lache une par une. */
function boulierDiffuse() {
  const now = Date.now();
  for (const [addr, set] of byAddr)
    for (const ws2 of set) send(ws2, { type: 'boulier', etat: game.boulierEtat(now, addr) });
  /* Les spectateurs non connectes voient la salle aussi : c'est ce qui donne
     envie de s'asseoir. Ils n'ont pas de `moi`, donc pas d'adresse a passer. */
  const publique = { type: 'boulier', etat: game.boulierEtat(now) };
  for (const ws2 of wss.clients) if (!ws2.addr && ws2.readyState === 1) send(ws2, publique);
}

const boulierInterval = setInterval(() => {
  try {
    const evs = game.boulierTick(Date.now());
    if (!evs.length) return;
    for (const ev of evs) {
      if (ev.type === 'boulierTirage') {
        persistSoon();
        /* Chacun recoit SES lignes : les grilles des autres ne le regardent
           pas, et cinquante grilles par joueur diffusees a tout le monde
           feraient un message par manche que personne ne lit. */
        for (const r of ev.resultats) {
          toAddr(r.addr, { type: 'boulierMien', manche: ev.manche, mise: r.mise,
                           lignes: r.lignes, payout: r.payout, net: r.net,
                           cagnotteGagnee: r.cagnotteGagnee, balance: r.balance });
          if (r.cagnotteGagnee > 0) {
            /* Un plein s'annonce meme sous le seuil habituel : c'est
               l'evenement que la salle entiere attend, et il tombe une fois
               sur 190 402. */
            tg.notifyPhoto(imageJeu('boulier'),
              `\ud83c\udfb1 <b>BOULIER JACKPOT</b>\n` +
              `${escHtml(game._p(r.addr).name)} hit <b>10/10</b> and took ` +
              `<b>${fmtAmt(String(r.cagnotteGagnee))} $SWOGE</b> \ud83d\udc15`);
          } else {
            const best = r.lignes.reduce((a2, l) => (l.n > a2 ? l.n : a2), 0);
            notifyTableWin(r.addr, 'boulier', { net: r.net, staked: r.mise, payout: r.payout,
              note: `${best}/10 on ${r.lignes.length} grid${r.lignes.length > 1 ? 's' : ''}` });
          }
        }
        delete ev.resultats;      // ils sont partis en prive, pas en diffusion
      }
      broadcast(ev);
    }
    boulierDiffuse();
  } catch (e) { console.warn('[boulier]', e && e.message); }
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
    }, (nextBlock) => { game.lastBlock = nextBlock; sante.noteBloc(); });
  } catch (e) { console.warn('deposit watch init failed:', e.message); }
})();

server.listen(cfg.PORT, () => {
  console.log(`SWOGE Pusher server on :${cfg.PORT}`);
  console.log(`  vault=${cfg.VAULT_ADDRESS || '(none)'} signer=${chain.signerAddress || '(none)'} serverSeedHash=${game.serverSeedHash.slice(0,16)}…`);
  console.log(`  telegram=${tg.enabled() ? 'ON (chat ' + cfg.TG_CHAT_ID + ')' : 'OFF (set TG_BOT_TOKEN + TG_CHAT_ID)'}`);
  tg.notify('🟢 <b>SWOGE server online</b> — notifications actives'); // startup ping = quick check that TG works
  sante.demarre({ jeu: game, tg });

  /* ---- le calendrier des paris s'alimente tout seul ----
   *
   * Sans cle, rien ne part sur le reseau et le calendrier reste celui du
   * depot : c'est le comportement d'avant, inchange.
   *
   * Les rencontres ne coutent AUCUN credit (endpoint /events), donc on peut
   * les reprendre deux fois par jour. Les scores coutent, donc une fois par
   * jour et seulement pour les ligues qui ont une rencontre finie. Le detail
   * du budget est dans EXPLOITATION.md, section 8.
   *
   * Le reglement, lui, reste A LA MAIN — c'est la meme raison qu'ailleurs
   * dans ce fichier : un service de resultats qui se trompe paie les
   * mauvaises personnes sans que personne ne le sache. On se contente donc
   * d'envoyer la liste sur Telegram, avec le score et la commande a lancer.
   * Une liste ecrite dans un journal que personne ne lit laisserait les paris
   * ouverts indefiniment. */
  /* Le rappel est nomme et pose sur `global` pour qu'un test puisse le
     jouer : sinon il n'est atteignable qu'apres une vraie minuterie et un
     vrai appel reseau, c'est-a-dire jamais en test. C'est le SEUL chemin par
     lequel le serveur paie tout seul — il doit pouvoir etre exerce. */
  const reglementAuto = (finis) => {
    /* Le tri est fait par le module d'import, qui ne connait pas le moteur —
       il ne peut donc pas payer tout seul. Le paiement se fait ICI, par le
       meme appel que la route d'admin. */
    const { auto, mains } = parisImport.trieReglements(
      finis, (id) => game.engagementMatch(id), Date.now());

    const faits = [], rates = [];
    for (const f of auto) {
      try {
        const r = game.regleMatch(f.id, f.resultat);
        faits.push({ f, r });
        notifyBetsSettled(r);
        console.log('[paris] auto', JSON.stringify({ match: f.id, score: f.score, ...r }));
      } catch (e) {
        /* « already settled » arrive normalement : un reglement a la main est
           passe avant. Ce n'est pas une panne, mais ca se dit. */
        rates.push({ f, erreur: e.message });
        console.log('[paris] auto REFUSE', f.id, ':', e.message);
      }
    }
    if (faits.length) persist();

    const l = [];
    for (const { f, r } of faits) {
      l.push(`✅ ${escHtml(f.domicile)} <b>${escHtml(f.score)}</b> ${escHtml(f.exterieur)}` +
             ` · <code>${escHtml(f.id)}</code> → <b>${escHtml(f.resultat)}</b>` +
             ` · ${r.gagnants} payé(s), ${fmtExact(r.paye)} $SWOGE`);
    }
    /* Ce qui n'a PAS ete regle doit ressortir aussi visiblement que le
       reste, avec sa raison : sinon on croit que tout est fait. */
    for (const f of mains) {
      l.push(`⏸️ ${escHtml(f.domicile)} <b>${escHtml(f.score)}</b> ${escHtml(f.exterieur)}` +
             ` · <code>${escHtml(f.id)}</code> → <b>${escHtml(f.resultat)}</b>` +
             ` · <i>${escHtml(f.raison)}</i>`);
    }
    for (const { f, erreur } of rates) {
      l.push(`⚠️ <code>${escHtml(f.id)}</code> · ${escHtml(erreur)}`);
    }
    if (!l.length) return;

    const tete = faits.length
      ? `⚽ <b>${faits.length} rencontre(s) réglée(s) automatiquement</b>`
      : `⚽ <b>${mains.length} rencontre(s) à régler à la main</b>`;
    const pied = mains.length
      ? `\n\nPour celles en attente : <code>/paris/regle?match=…&amp;resultat=…</code>`
      : '';
    tg.notify(tete + '\n\n' + l.slice(0, 14).join('\n') +
              (l.length > 14 ? `\n• … et ${l.length - 14} autre(s)` : '') + pied);
  };
  global.__swogeReglementAuto = reglementAuto;
  calendrierAuto = parisImport.planifie(reglementAuto);
});

function shutdown() {
  clearInterval(niveauInterval); clearInterval(prixInterval); clearInterval(backupInterval); clearInterval(graineInterval); clearInterval(purgeInterval); clearInterval(stepInterval); clearInterval(bcInterval); clearInterval(metaInterval); clearInterval(saveInterval); clearInterval(pokerInterval); clearInterval(crashInterval); clearInterval(p4Interval); clearInterval(battement); clearInterval(compteInterval);
  if (calendrierAuto) calendrierAuto.arrete();
  persistComplet(); // instantane complet : rien ne se perd au redeploiement
  /* Le journal ecrit en differe pour ne pas ouvrir mille descripteurs : ce
     qui attend encore doit partir maintenant, sinon les dernieres manches
     jouees avant un redeploiement n'auront jamais existe. */
  journal.draine(() => { server.close(); process.exit(0); }, 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
