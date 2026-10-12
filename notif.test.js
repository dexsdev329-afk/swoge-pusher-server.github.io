'use strict';
/*
 * Les annonces Telegram des tables contre la banque.
 *
 * On ne teste pas «la fonction construit bien une phrase» : on demarre le VRAI
 * serveur, on joue par WebSocket comme le ferait un navigateur, et on capture
 * ce qui part vers api.telegram.org en remplacant fetch. C'est le seul moyen
 * de prouver que le message est envoye sur le bon chemin de code — un test qui
 * appellerait le helper directement passerait meme si personne ne l'appelle.
 */
const assert = require('assert');

// Doit etre en place AVANT que config.js soit charge par le serveur.
process.env.TG_BOT_TOKEN = 'jeton-de-test';
process.env.TG_CHAT_ID = '-100999';
process.env.NOTIFY_WIN_MIN = '1';          // tout gain compte, on veut le chemin
process.env.PORT = String(8790 + (process.pid % 120));
process.env.DEV_FAUCET = '1';
process.env.RPC_URL = '';                  // pas de chaine : rien a surveiller
// etat jetable : le test ne doit pas ecrire dans data/state.json
process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/swoge-notif-');
/* Le Crash en $SWOGEBET (11/10/2026) : des manches courtes, pour qu'un
   encaissement automatique arrive en quelques secondes. Seul le Crash les lit. */
process.env.CRASH_ATTENTE_MS = '1200';
process.env.CRASH_APRES_MS = '300';
/* La maison passee au module communaute (12/10/2026) : un compte maison connu,
   et un portefeuille de deploiement V4 deja sur le volume (cle JETABLE, tiree
   ici, dans un dossier temporaire) — ni l un ni l autre ne doit etre un
   detenteur. Avant config.js, qui lit COMPTES_MAISON une fois. */
process.env.COMPTES_MAISON = '0x' + '12'.repeat(20);
const DEPLOYEUR_ESSAI = require('ethers').Wallet.createRandom();
require('fs').writeFileSync(require('path').join(process.env.DATA_DIR, 'deployeur_v4.json'),
  JSON.stringify({ cle: DEPLOYEUR_ESSAI.privateKey, cree: new Date().toISOString() }), { mode: 0o600 });

/* telegram.js serialise ses envois avec 400 ms d'ecart pour rester sous la
   limite de debit : un message declenche maintenant peut partir bien plus tard.
   On ne vide donc JAMAIS `envois` en cours de route — on note un index avant
   le coup, on laisse la file s'ecouler, puis on lit la tranche. Vider entre
   deux essais faisait disparaitre le message qu'on attendait. */
const envois = [];
/* Attendre une duree fixe ne suffit pas : 30 messages en file, c'est 12 s
   d'ecoulement. On attend donc que le compteur cesse de bouger. */
async function vider(calme = 700, max = 40000) {
  const fin = Date.now() + max;
  let dernierN = -1, stable = Date.now();
  while (Date.now() < fin) {
    if (envois.length !== dernierN) { dernierN = envois.length; stable = Date.now(); }
    else if (Date.now() - stable >= calme) return;
    await attendre(100);
  }
}
const vraiFetch = global.fetch;
global.fetch = async (url, opt) => {
  if (String(url).includes('api.telegram.org')) {
    envois.push(JSON.parse(opt.body).text || JSON.parse(opt.body).caption || '');
    return { json: async () => ({ ok: true }) };
  }
  return vraiFetch(url, opt);
};

const WebSocket = require('ws');
/* Le moteur du serveur, capture a son premier `_p` (comme plafond_elo.test.js) :
   c'est par lui qu'on credite le coffre $SWOGEBET du joueur — le robinet de
   developpement ne remplit que le $SWOGE. */
const { Game } = require('./game');
let moteur = null;
{ const p0 = Game.prototype._p; Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); }; }
/* les lignes de demarrage du module communaute (TG_COMMUNAUTE non pose ici) */
const lignesCommunaute = [];
{ const l0 = console.log; console.log = (...a) => { const t = a.join(' '); if (/\[communaute\]/.test(t)) lignesCommunaute.push(t); return l0(...a); }; }
delete process.env.TG_COMMUNAUTE;
/* ce que server.js passe au module communaute (sa liste de la maison) */
let depsCommunaute = null;
{ const Cm = require('./communaute'); const p0 = Cm.planifie; Cm.planifie = (d) => { depsCommunaute = d; return p0(d); }; }
require('./server');                        // demarre l'ecoute

let n = 0;
const exemples = [];          // pour montrer a l'oeil ce qui part vraiment
const ok = (c, m) => { assert.ok(c, m); n++; };

const { ethers } = require('ethers');
const portefeuille = ethers.Wallet.createRandom();
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/* Le serveur ouvre par un defi a signer : on se connecte comme un vrai client,
   avec une vraie signature. Sans cela `ws.addr` reste nul et tous les coups
   sont refuses — ce qui rendrait le test vert pour la mauvaise raison. */
function ouvrir() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    const recu = [];
    ws.on('message', (d) => { try { recu.push(JSON.parse(d)); } catch (e) {} });
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, recu }));
  });
}
const env = (ws, o) => ws.send(JSON.stringify(o));
const dernier = (recu, type) => [...recu].reverse().find((m) => m.type === type);

(async () => {
  const { ws, recu } = await ouvrir();
  await attendre(200);
  const salut = dernier(recu, 'hello');
  ok(salut && salut.loginNonce, 'le serveur envoie son defi de connexion');
  const message = `SWOGE Pusher login\nnonce: ${salut.loginNonce}`;
  env(ws, { type: 'login', message, signature: await portefeuille.signMessage(message) });
  await attendre(300);
  const auth = dernier(recu, 'auth');
  ok(auth && auth.address, 'connexion acceptee : ' + JSON.stringify(dernier(recu, 'error') || ''));
  const ADR = auth.address;
  for (let i = 0; i < 40; i++) { env(ws, { type: 'devCredit' }); await attendre(15); }
  await attendre(400);

  // ------------------------------------------------------------ Hi-Lo
  // On rejoue jusqu'a tomber sur une partie gagnante : le tirage est aleatoire,
  // on ne peut pas la commander, mais elle arrive vite.
  await vider();
  let gagnee = null;
  for (let essai = 0; essai < 60 && !gagnee; essai++) {
    const avant = envois.length;
    env(ws, { type: 'hiloStart', bet: 200 }); await attendre(60);
    let st = dernier(recu, 'hilo').state;
    let pas = 0;
    while (st && !st.fini && pas < 2) {
      // le pari le plus sur : celui dont le multiplicateur est le plus bas
      const sens = (st.multHigher && (!st.multLower || st.multHigher <= st.multLower)) ? 'higher' : 'lower';
      env(ws, { type: 'hiloStep', dir: sens }); await attendre(60);
      st = dernier(recu, 'hilo').state; pas++;
    }
    if (st && !st.fini) {
      env(ws, { type: 'hiloCashOut' }); await attendre(120);
      const fin = dernier(recu, 'hilo').state;
      if (fin.net > 0) { await vider(); gagnee = { fin, msg: envois.slice(avant) }; }
    }
  }
  ok(gagnee, 'une partie de Hi-Lo gagnante a ete jouee');
  const mh = gagnee.msg.find((t) => /Hi-Lo/.test(t));
  ok(mh, 'le Hi-Lo gagnant a declenche une annonce : ' + JSON.stringify(gagnee.msg));
  ok(/won <b>\+/.test(mh), 'l annonce porte le BENEFICE, pas le retour brut');
  ok(/Stake .* · returned /.test(mh), 'la mise et le retour sont rappeles');
  ok(/× in \d+ step/.test(mh), 'le multiplicateur et le nombre de pas sont dits');
  /* 11/10/2026 : le gain $SWOGE garde EXACTEMENT son texte (« $SWOGE</b> 🐕 »),
     jamais « $SWOGEBET » — l'annonce par jeton ne doit rien changer ici. */
  ok(/won <b>\+[\d.km]+ \$SWOGE<\/b> 🐕\nStake /.test(mh) && !/\$SWOGEBET/.test(mh),
     'une partie en $SWOGE s annonce en $SWOGE, texte inchange : ' + mh);
  exemples.push(mh);
  // le chiffre annonce doit etre celui du serveur, pas un arrondi maison
  const annonce = mh.match(/won <b>\+([\d.km]+)/i)[1];
  const attendu = gagnee.fin.net >= 1000 ? (gagnee.fin.net / 1000).toFixed(1) + 'k' : String(gagnee.fin.net);
  assert.strictEqual(annonce, attendu, `benefice annonce ${annonce} vs ${gagnee.fin.net} reel`); n++;

  // ------------------------------------------------------- Hold'em / Three
  for (const jeu of ['holdem', 'three']) {
    await vider();
    let vu = null;
    for (let essai = 0; essai < 120 && !vu; essai++) {
      const avant = envois.length;
      env(ws, { type: 'casinoDeal', game: jeu, ante: 100, side: 0 }); await attendre(50);
      let st = dernier(recu, 'casino').state;
      if (st.stage === 'decide') { env(ws, { type: 'casinoDecide', play: true }); await attendre(90); }
      st = dernier(recu, 'casino').state;
      if (st.result && st.result.net > 0) { await vider(); vu = { st, msg: envois.slice(avant) }; }
    }
    ok(vu, `une main gagnante de ${jeu} a ete jouee`);
    const nom = jeu === 'holdem' ? "Casino Hold'em" : 'Three Card';
    const m = vu.msg.find((t) => t.includes(nom));
    ok(m, `${jeu} gagnant a declenche une annonce : ` + JSON.stringify(vu.msg));
    ok(/won <b>\+/.test(m), `${jeu} : l annonce porte le benefice`);
    ok(/\$SWOGE<\/b>/.test(m) && !/\$SWOGEBET/.test(m), `${jeu} : en $SWOGE, le jeton dit est $SWOGE`);
    ok(new RegExp('Stake ' + vu.st.result.staked + ' · returned ' + vu.st.result.payout).test(m),
       `${jeu} : mise et retour exacts — ${m}`);
    exemples.push(m);
  }

  // --------------------------------------------- une perte n'annonce rien
  {
    /* On ne peut pas isoler UNE main perdue : un message annonce plus tot peut
       encore etre dans la file quand on la joue. On compte donc sur une serie :
       autant d'annonces que de mains gagnantes, ni plus ni moins. Une annonce
       de trop signifierait qu'une perte a parle. */
    await vider();
    const depart = envois.length;
    let gagnantes = 0, perdues = 0;
    for (let essai = 0; essai < 60; essai++) {
      env(ws, { type: 'casinoDeal', game: 'holdem', ante: 100, side: 0 }); await attendre(45);
      let st = dernier(recu, 'casino').state;
      if (st.stage === 'decide') { env(ws, { type: 'casinoDecide', play: true }); await attendre(80); }
      st = dernier(recu, 'casino').state;
      if (!st.result) continue;
      if (st.result.net > 0) gagnantes++; else if (st.result.net < 0) perdues++;
    }
    await vider();
    const dits = envois.slice(depart).filter((t) => /Casino Hold/.test(t)).length;
    ok(perdues > 0, `des mains perdues ont ete jouees (${perdues})`);
    assert.strictEqual(dits, gagnantes,
      `${gagnantes} mains gagnantes, ${perdues} perdues, ${dits} annonces`); n++;

  }

  // ------------------------------------- le seuil coupe les petits gains
  {
    const cfg = require('./config');
    const avant = cfg.NOTIFY_WIN_MIN;
    cfg.NOTIFY_WIN_MIN = 10 ** 9;            // plus rien ne passe
    await vider();
    let vu = false;
    for (let essai = 0; essai < 120 && !vu; essai++) {
      const avant = envois.length;
      env(ws, { type: 'hiloStart', bet: 200 }); await attendre(50);
      let st = dernier(recu, 'hilo').state;
      if (!st.fini) {
        const sens = (st.multHigher && (!st.multLower || st.multHigher <= st.multLower)) ? 'higher' : 'lower';
        env(ws, { type: 'hiloStep', dir: sens }); await attendre(60);
        st = dernier(recu, 'hilo').state;
        if (!st.fini) {
          env(ws, { type: 'hiloCashOut' }); await attendre(100);
          if (dernier(recu, 'hilo').state.net > 0) {
            vu = true;
            await vider();
            ok(envois.slice(avant).length === 0,
               'sous le seuil, rien ne part : ' + JSON.stringify(envois.slice(avant)));
          }
        }
      }
    }
    ok(vu, 'un gain sous le seuil a bien ete observe');
    cfg.NOTIFY_WIN_MIN = avant;
  }

  /* ================== LES GAINS EN $SWOGEBET (11/10/2026) ==================
   * Demande du proprietaire : « manque les notifs quand ca gagne au casino et
   * que c'est en $SWOGEBET qu'il a mise ». Treize appels etaient muets en
   * $SWOGEBET, et le Crash annoncait un gain $SWOGEBET en « $SWOGE ». Meme
   * intention que le reste du fichier : l'annonce part par le VRAI chemin,
   * avec le BON jeton — et le coffre $SWOGE n'est pas touche. */
  {
    const { ethers } = require('ethers');
    const cfg = require('./config');
    ok(moteur, 'le moteur du serveur a ete capture');
    moteur._p(ADR).betBalance = ethers.utils.parseUnits('1000000', cfg.DECIMALS);
    const swogeAvant = moteur.balanceStr(ADR);
    const enBet = (t) => /won <b>\+[\d.km]+ \$SWOGEBET<\/b> 🐕\nStake /.test(t);

    // ---- Hi-Lo en $SWOGEBET (encaissement)
    await vider();
    let hb = null;
    for (let essai = 0; essai < 80 && !hb; essai++) {
      const avant = envois.length;
      env(ws, { type: 'hiloStart', bet: 200, jeton: 'swogebet' }); await attendre(60);
      let st = dernier(recu, 'hilo').state;
      if (!st || st.fini) continue;
      const sens = (st.multHigher && (!st.multLower || st.multHigher <= st.multLower)) ? 'higher' : 'lower';
      env(ws, { type: 'hiloStep', dir: sens }); await attendre(60);
      st = dernier(recu, 'hilo').state;
      if (st && !st.fini) {
        env(ws, { type: 'hiloCashOut' }); await attendre(120);
        const fin = dernier(recu, 'hilo').state;
        if (fin.net > 0) { await vider(); hb = { fin, msg: envois.slice(avant) }; }
      }
    }
    ok(hb && hb.fin.jeton === 'swogebet', 'une partie de Hi-Lo $SWOGEBET gagnante a ete jouee');
    const mhb = hb.msg.find((t) => /Hi-Lo/.test(t));
    ok(mhb && enBet(mhb), 'Hi-Lo $SWOGEBET : annonce, avec « $SWOGEBET » : ' + JSON.stringify(hb.msg));
    exemples.push(mhb);

    // ---- Plinko en $SWOGEBET (risque « low » : 28,9 % des billes gagnent sur 8 rangees, contre 7 % en « high » —
    //      80 essais ratent alors avec une chance de 1e-12, et non 3 sur 1 000 : l essai ne clignote pas)
    await vider();
    let pb = null;
    for (let essai = 0; essai < 80 && !pb; essai++) {
      const avant = envois.length;
      env(ws, { type: 'plinkoDrop', bet: 100, rows: 8, risk: 'low', jeton: 'swogebet' }); await attendre(60);
      const d = dernier(recu, 'plinko');
      if (d && d.drop && d.drop.net > 0) { await vider(); pb = { r: d.drop, msg: envois.slice(avant) }; }
    }
    ok(pb && pb.r.jeton === 'swogebet', 'un Plinko $SWOGEBET gagnant a ete joue');
    const mpb = pb.msg.find((t) => /Plinko/.test(t));
    ok(mpb && enBet(mpb), 'Plinko $SWOGEBET : annonce, avec « $SWOGEBET » : ' + JSON.stringify(pb.msg));

    // ---- Smash en $SWOGEBET : game.spin ne rend pas le jeton, le serveur passe celui de la mise
    await vider();
    let sb = null;
    for (let essai = 0; essai < 200 && !sb; essai++) {
      const avant = envois.length;
      env(ws, { type: 'spin', bet: 100, jeton: 'swogebet' }); await attendre(30);
      const d = dernier(recu, 'spinResult');
      if (d && d.jeton === 'swogebet' && d.payout > d.bet) { await vider(); sb = { r: d, msg: envois.slice(avant) }; }
    }
    ok(sb, 'un Smash $SWOGEBET gagnant a ete joue');
    const msb = sb.msg.find((t) => /Smash/.test(t));
    ok(msb && enBet(msb), 'Smash $SWOGEBET : annonce, avec « $SWOGEBET » : ' + JSON.stringify(sb.msg));

    // ---- Crash en $SWOGEBET, encaissement AUTOMATIQUE a 1,01× (le tic du serveur)
    /* Relecture du 12/10 : l essai clignotait sous charge (1 sur 4 avec quatre
       serveurs en parallele) — une enveloppe de 60 s d horloge, des mises
       relancees a l aveugle toutes les ~330 ms, jusqu a 127 refus « bets are
       closed ». On se SYNCHRONISE sur le serveur : on attend l ouverture des
       mises (crashAttente), on attend la reponse a la mise, et on borne par un
       nombre de MANCHES, pas par l horloge. */
    await vider();
    let cb = null, manches = 0;
    const misesCrash = [];
    while (!cb && manches < 20) {
      const n0 = recu.length;
      let ouverte = null;
      for (let k = 0; k < 200 && !ouverte; k++) { await attendre(50); ouverte = recu.slice(n0).find((m) => m.type === 'crashAttente'); }
      manches++;
      if (!ouverte) continue;
      const avant = envois.length;
      const nRecu = recu.length;
      env(ws, { type: 'crashBet', bet: 1000, auto: 1.01, jeton: 'swogebet' });
      let rep = null;
      for (let k = 0; k < 60 && !rep; k++) { await attendre(50); rep = recu.slice(nRecu).find((m) => m.type === 'crashBet' || m.type === 'error'); }
      if (!rep || rep.type !== 'crashBet') continue;
      misesCrash.push(rep.jeton);
      let ev = null;
      for (let k = 0; k < 150 && !ev; k++) {
        await attendre(100);
        ev = recu.slice(nRecu).find((m) => (m.type === 'crashRetrait' && m.moi) || m.type === 'crashPerdu');
      }
      if (ev && ev.type === 'crashRetrait' && ev.net > 0) { await vider(); cb = { ev, msg: envois.slice(avant) }; }
    }
    /* une seule verification, quel que soit le nombre de manches jouees : le total reste fixe */
    ok(misesCrash.length > 0 && misesCrash.every((j) => j === 'swogebet'), 'les mises du Crash sont posees en $SWOGEBET (' + misesCrash.length + ' mise(s), ' + manches + ' manche(s))');
    ok(cb && cb.ev.jeton === 'swogebet', 'un encaissement automatique au Crash en $SWOGEBET a eu lieu');
    const mcb = cb.msg.find((t) => /Crash/.test(t));
    ok(mcb && enBet(mcb), 'Crash $SWOGEBET : annonce en « $SWOGEBET », plus jamais en « $SWOGE » : ' + JSON.stringify(cb.msg));
    exemples.push(mcb);

    // ---- le seuil coupe aussi en $SWOGEBET (meme NOTIFY_WIN_MIN, meme unite)
    {
      const avantSeuil = cfg.NOTIFY_WIN_MIN;
      cfg.NOTIFY_WIN_MIN = 10 ** 9;
      await vider();
      let vu = false;
      for (let essai = 0; essai < 80 && !vu; essai++) {
        const avant = envois.length;
        env(ws, { type: 'plinkoDrop', bet: 100, rows: 8, risk: 'low', jeton: 'swogebet' }); await attendre(60);
        const d = dernier(recu, 'plinko');
        if (d && d.drop && d.drop.net > 0) {
          vu = true; await vider();
          ok(envois.slice(avant).length === 0, 'sous le seuil, un gain $SWOGEBET ne part pas : ' + JSON.stringify(envois.slice(avant)));
        }
      }
      ok(vu, 'un gain $SWOGEBET sous le seuil a bien ete observe');
      cfg.NOTIFY_WIN_MIN = avantSeuil;
    }

    // ---- TOUS les autres jeux tokenises (relecture du 12/10 : 9 des 13 appels n etaient jamais joues en
    //      $SWOGEBET — remettre la garde ou oublier le jeton sur l un d eux laissait l essai vert)
    {
      const CRAN = Object.keys(require('./dod').CRANS)[0];
      const JEUX = [
        ['SWOGE Spin', 'tour', async () => { env(ws, { type: 'volcanoSpin', bet: 100, jeton: 'swogebet' }); await attendre(40); }],
        ['SWOGE Spin', 'achat du bonus', async () => { env(ws, { type: 'volcanoBuyBonus', bet: 10, jeton: 'swogebet' }); await attendre(40); }],
        ['SWOGE Kennel', 'tour', async () => { env(ws, { type: 'chenilSpin', bet: 100, jeton: 'swogebet' }); await attendre(40); }],
        ['DEAD SWOGE', 'tour', async () => { env(ws, { type: 'dodSpin', bet: 100, jeton: 'swogebet' }); await attendre(40); }],
        ['DEAD SWOGE', 'achat', async () => { env(ws, { type: 'dodAchat', bet: 100, cran: CRAN, jeton: 'swogebet' }); await attendre(40); }],
        ['SWOGE Bonanza', 'tour', async () => { env(ws, { type: 'bonanzaSpin', bet: 100, jeton: 'swogebet' }); await attendre(40); }],
        ['SWOGE Bonanza', 'achat', async () => { env(ws, { type: 'bonanzaAchat', bet: 100, jeton: 'swogebet' }); await attendre(40); }],
        ['Mines', 'encaissement', async () => { env(ws, { type: 'minesStart', bet: 100, mines: 1, jeton: 'swogebet' }); await attendre(40);
                                                env(ws, { type: 'minesPick', pos: 0 }); await attendre(40);
                                                env(ws, { type: 'minesCashOut' }); await attendre(60); }],
        ['Three Card', 'decision', async () => { env(ws, { type: 'casinoDeal', game: 'three', ante: 100, jeton: 'swogebet' }); await attendre(50);
                                                 env(ws, { type: 'casinoDecide', play: true }); await attendre(60); }],
        ['Blackjack', 'main', async () => { env(ws, { type: 'bj_bet', amount: 100, jeton: 'swogebet' }); await attendre(50);
                                           env(ws, { type: 'bj_stand' }); await attendre(60); }],
      ];
      const marque = (t, titre, quoi) => t.includes('<b>' + titre + '</b>') && (quoi !== 'achat du bonus' || /bonus bought/.test(t));
      for (const [titre, quoi, joue] of JEUX) {
        await vider();
        let vu = null;
        for (let essai = 0; essai < 150 && !vu; essai++) {
          const avant = envois.length;
          await joue();
          vu = envois.slice(avant).find((t) => marque(t, titre, quoi));
          if (!vu && essai % 10 === 9) { await vider(300, 3000); vu = envois.slice(avant).find((t) => marque(t, titre, quoi)); }
        }
        await vider();
        ok(vu && enBet(vu), `${titre} (${quoi}) en $SWOGEBET : un gain s annonce, en « $SWOGEBET » : ` + JSON.stringify(vu));
      }
    }

    /* Le coffre $SWOGE n'a pas bouge pendant toutes ces manches $SWOGEBET :
       l'annonce change, la passerelle entre coffres n'existe toujours pas. */
    assert.strictEqual(moteur.balanceStr(ADR), swogeAvant, 'le solde $SWOGE est intact apres les manches $SWOGEBET'); n++;
  }

  /* ================== LE BUY BONUS DU VOLCANO (relecture du 12/10/2026) ==================
   * Le bonus coute la mise × 33 ; l annonce comptait le benefice sur la mise de
   * base : « won +300 · Stake 10 · returned 310 » pour un bonus paye 330 (perte
   * de -20). Intention : une perte ne s annonce JAMAIS, un gain s annonce avec la
   * mise egale au COUT — dans les deux jetons. */
  for (let i = 0; i < 15; i++) { env(ws, { type: 'devCredit' }); await attendre(15); }   // 30 bonus × 330 en $SWOGE
  await attendre(300);
  for (const jeton of ['swoge', 'swogebet']) {
    await vider();
    const depart = envois.length;
    const issues = [];
    for (let i = 0; i < 30; i++) {
      const n0 = recu.length;
      env(ws, { type: 'volcanoBuyBonus', bet: 10, jeton });
      let r = null;
      for (let k = 0; k < 60 && !r; k++) { await attendre(20); r = recu.slice(n0).find((m) => m.type === 'volcanoResult' || m.type === 'need_deposit' || m.type === 'error'); }
      if (r && r.type === 'volcanoResult') issues.push(r);
    }
    await vider();
    const dits = envois.slice(depart).filter((t) => /<b>SWOGE Spin<\/b>/.test(t));
    const gagnants = issues.filter((r) => r.payout > r.cost), perdantsTrompeurs = issues.filter((r) => r.payout <= r.cost && r.payout > r.bet);
    const sym = jeton === 'swogebet' ? '\\$SWOGEBET' : '\\$SWOGE';
    ok(issues.length === 30 && issues.every((r) => r.cost === 330 && r.jeton === jeton), `Buy Bonus ${jeton} : 30 bonus joues a 330 (mise 10 × 33)`);
    ok(perdantsTrompeurs.length > 0, `Buy Bonus ${jeton} : des bonus PERDANTS qui rendaient plus que la mise de base ont ete joues (${perdantsTrompeurs.length}) — ceux que l ancien code annoncait`);
    assert.strictEqual(dits.length, gagnants.length, `Buy Bonus ${jeton} : ${gagnants.length} bonus gagnants (rendu > cout), ${dits.length} annonces — une perte ne parle jamais : ` + JSON.stringify(dits)); n++;
    ok(dits.every((t) => new RegExp(`won <b>\\+[\\d.km]+ ${sym}</b> 🐕\\nStake 330 · returned [\\d.km]+ · bonus bought`).test(t)), `Buy Bonus ${jeton} : chaque annonce porte la mise = le cout (330) et « bonus bought » : ` + JSON.stringify(dits));
  }

  /* ================== LA MAISON PASSEE AU MODULE COMMUNAUTE (12/10/2026) ==================
   * Le vrai server.js : ses comptes maison et le portefeuille dedie du launchpad V4
   * ne sont jamais des « detenteurs ». */
  {
    ok(depsCommunaute && typeof depsCommunaute.maison === 'function', 'server.js passe une liste de la maison au module communaute');
    const mz = new Set([...(depsCommunaute.maison() || [])].map((a) => String(a).toLowerCase()));
    ok(mz.has('0x' + '12'.repeat(20)), 'la maison contient COMPTES_MAISON');
    ok(mz.has(DEPLOYEUR_ESSAI.address.toLowerCase()), 'la maison contient le portefeuille de deploiement V4 (lu sur le volume)');
    ok(![...mz].some((a) => a.includes(DEPLOYEUR_ESSAI.privateKey.slice(2, 22))), 'la maison ne porte que des adresses, jamais la cle');
  }

  /* ================== LA COMMUNAUTE (11/10/2026) : branchement serveur ==================
   * Le vrai serveur, TG_COMMUNAUTE non pose : la ligne de demarrage dit ETEINT,
   * et la route publique des images sert le volume, rien d autre. */
  {
    const fs = require('fs'), pth = require('path');
    ok(lignesCommunaute.some((l) => /\[communaute\] ETEINT \(TG_COMMUNAUTE vide\) : aucune requete, aucune annonce/.test(l)),
       'demarrage : le module communaute se dit ETEINT : ' + JSON.stringify(lignesCommunaute));
    const base = 'http://127.0.0.1:' + process.env.PORT;
    let r = await vraiFetch(base + '/communaute/image/nouveau-v1.png');
    ok(r.status === 404, '/communaute/image : 404 tant que l image n existe pas (' + r.status + ')');
    const d = pth.join(process.env.DATA_DIR, 'communaute_images');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(pth.join(d, 'nouveau-v1.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    r = await vraiFetch(base + '/communaute/image/nouveau-v1.png');
    ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && (await r.arrayBuffer()).byteLength === 8,
       '/communaute/image : sert le PNG du volume, en image/png');
    r = await vraiFetch(base + '/communaute/image/..%2fstate.png');
    ok(r.status === 404, '/communaute/image : un nom douteux est refuse');
    /* Relecture du 12/10 : server.js prend le chemin BRUT (req.url, sans normalisation) et l essai ci-dessus
       visait un fichier absent — retirer la garde de nom ne changeait rien. Ici le fichier vise EXISTE, hors du
       dossier des images, et la requete part BRUTE (fetch normaliserait les « .. »). */
    fs.writeFileSync(pth.join(process.env.DATA_DIR, 'fuite.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const st = await new Promise((res) => {
      const rq = require('http').request({ host: '127.0.0.1', port: process.env.PORT, path: '/communaute/image/../fuite.png', method: 'GET' }, (rr) => { rr.resume(); res(rr.statusCode); });
      rq.on('error', () => res(-1)); rq.end();
    });
    ok(st === 404, '/communaute/image/../fuite.png (chemin brut, fichier present hors du dossier) : 404 (' + st + ')');
  }

  ws.close();
  console.log('  exemples de messages :');
  for (const t of exemples) console.log('    ' + t.replace(/<\/?b>/g, '').replace(/\n/g, '\n    '));
  console.log(`notif.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC', e); process.exit(1); });
