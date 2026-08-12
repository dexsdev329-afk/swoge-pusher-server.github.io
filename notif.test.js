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

  ws.close();
  console.log('  exemples de messages :');
  for (const t of exemples) console.log('    ' + t.replace(/<\/?b>/g, '').replace(/\n/g, '\n    '));
  console.log(`notif.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC', e); process.exit(1); });
