'use strict';
/* ============================================================================
 * CE QUI EST FERME, ET CE QUI NE L'EST PAS (decision du 27 septembre 2026)
 *
 * Le proprietaire : « retire flix et le staking le reste garde le ».
 *
 *   1. SWOGE FLIX : la salle cinema diffusait des liens vers des sites pirates.
 *      Par defaut (SWOGE_FLIX absent), ses seances ne sont plus servies — ni
 *      dans `salles`, ni dans l'ancien champ `cinemas` — et le panneau ne peut
 *      plus en ajouter. Les salles manga et series, elles, ne changent pas.
 *   2. LE STAKING : plus aucune NOUVELLE mise (STAKE_OUVERT absent). Ce qui est
 *      deja au staking reste a son proprietaire : reclamer et sortir marchent
 *      exactement comme avant. Fermer la sortie serait garder l'argent des
 *      joueurs — c'est ce que cet essai empeche avant tout.
 *
 * Un vrai serveur, une vraie socket signee. Le mecanisme des salles ouvertes a
 * son propre essai (cinema_serveur.test.js, qui pose SWOGE_FLIX=1).
 * ==========================================================================*/
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

const CLE = 'cle-de-test-fermetures';
process.env.DATA_DIR = fs.mkdtempSync('/tmp/fermetures-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = CLE;
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
/* Les DEFAUTS sont ce qu'on met a l'essai : aucun des deux interrupteurs n'est
   pose, meme s'il trainait dans l'environnement de la machine. */
delete process.env.SWOGE_FLIX; delete process.env.STAKE_OUVERT;

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const cfg = require('./config');
  eq(cfg.SWOGE_FLIX, false, 'par defaut, SWOGE FLIX est ferme');
  eq(cfg.STAKE_OUVERT, false, 'par defaut, le staking est ferme aux nouvelles mises');

  /* Le moteur, attrape au passage, pour poser l'etat d'AVANT la decision :
     une seance de cinema deja enregistree, une mise deja en staking. */
  const { Game } = require('./game');
  let moteur = null;
  const p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };

  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const BASE = 'http://127.0.0.1:' + port;

  const ouvre = () => new Promise((res, rej) => {
    const s = new WebSocket('ws://127.0.0.1:' + port);
    s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    s.on('open', () => res(s)); s.on('error', rej);
  });
  const attend = (s, type, ms) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function tour() {
      const m = s.recus.filter((x) => x.type === type).pop();
      if (m) return res(m);
      if (Date.now() - t0 > (ms || 5000)) return rej(new Error('pas de ' + type));
      setTimeout(tour, 25);
    })();
  });
  const dit = async (s, m, ms) => { s.recus.length = 0; s.send(JSON.stringify(m)); await new Promise((r) => setTimeout(r, ms || 350)); return s.recus; };
  const aRecu = (l, t) => l.filter((x) => x.type === t).pop() || null;
  const poste = async (corps) => {
    const r = await fetch(BASE + '/admin/cinema', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': CLE }, body: JSON.stringify(corps) });
    return { statut: r.status, j: await r.json().catch(() => ({})) };
  };
  const seance = (salle, t) => ({ salle, titre: t, affiche: 'https://exemple.test/a.jpg',
                                  vf: 'https://exemple.test/vf', vo: 'https://exemple.test/vo' });

  /* Le joueur se connecte : c'est aussi ce qui nous donne le moteur. */
  const J = ethers.Wallet.createRandom();
  const s = await ouvre();
  const h0 = await attend(s, 'hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h0.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await J.signMessage(msg) }));
  await attend(s, 'auth');
  ok(!!moteur, 'le moteur est attrape');

  console.log('\n-- 1. SWOGE FLIX : plus rien n est servi, plus rien ne s ajoute --');
  {
    /* Une seance ENREGISTREE avant la decision : elle est dans le fichier du
       jeu, et c'est exactement elle qui ne doit plus sortir. */
    moteur.cinemas = moteur.cinemas || {};
    moteur.cinemas.cinema = [{ titre: 'ANCIENNE SEANCE', affiche: 'https://exemple.test/x.jpg', vf: 'https://pirate.test/vf', vo: '' }];
    const t = await ouvre();
    const h = await attend(t, 'hello');
    const cine = (h.salles || []).find((x) => x.cle === 'cinema');
    ok(!!cine, 'la salle cinema existe encore dans la liste (la page ne casse pas)');
    eq(cine && cine.seances.length, 0, 'mais elle est servie VIDE, meme avec une seance dans le fichier');
    ok(Array.isArray(h.cinemas) && h.cinemas.length === 0, 'l ancien champ « cinemas » est vide aussi (la page en service le lit)');
    ok(!JSON.stringify(h).includes('pirate.test'), 'aucun lien de la seance ne sort, nulle part dans le bonjour');
    t.close();

    const r = await poste(seance('cinema', 'NOUVELLE'));
    eq(r.statut, 400, 'le panneau ne peut plus ajouter de seance au cinema');
    ok(/SWOGE FLIX is closed/.test(JSON.stringify(r.j)), 'et le refus dit pourquoi, et comment rouvrir');
    ok(!moteur.cinemas.cinema.some((c) => c.titre === 'NOUVELLE'), 'rien n a ete ecrit');

    const m = await poste(seance('manga', 'MANGA OK'));
    eq(m.statut, 200, 'la salle manga, elle, accepte toujours');
    const sr = await poste(seance('series', 'SERIE OK'));
    eq(sr.statut, 200, 'la salle series aussi');
    const t2 = await ouvre();
    const h2 = await attend(t2, 'hello');
    const manga = (h2.salles || []).find((x) => x.cle === 'manga');
    ok(manga && manga.seances.some((c) => c.titre === 'MANGA OK'), 'et ses seances sont servies normalement');
    t2.close();
  }

  console.log('\n-- 2. LE STAKING : plus de nouvelle mise, la sortie reste ouverte --');
  {
    const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
    const p = moteur._p(J.address);
    p.balance = W(100000);
    /* Une mise d'AVANT la decision, vieille d'un jour : du rendement court. */
    moteur.stake(J.address, '50000');
    for (const pos of p.stakes) pos.s -= 24 * 3600e3;
    const avant = moteur.balanceStr(J.address);

    const l = await dit(s, { type: 'stake', amount: '1000' });
    const e = aRecu(l, 'error');
    ok(!!e && /Staking is closed to new deposits/.test(e.error), 'une nouvelle mise est refusee, en anglais');
    ok(!!e && /unstake anytime/.test(e.error), 'et le refus dit que la sortie reste ouverte');
    eq(moteur.balanceStr(J.address), avant, 'le solde n a pas bouge d un wei');
    eq(p.stakes.length, 1, 'aucune position ajoutee');

    const c = await dit(s, { type: 'claimStake' });
    const cr = aRecu(c, 'stakeClaimed');
    ok(!!cr && Number(cr.reward) > 0, 'reclamer le rendement marche [' + (cr && cr.reward) + ']');
    const info = aRecu(c, 'stakeInfo');
    ok(!!info && info.ouvert === false, 'stakeInfo dit « ouvert: false » : la page peut le montrer avant qu on tape un montant');

    const u = await dit(s, { type: 'unstake' });
    ok(!!aRecu(u, 'stakeUnstaked'), 'sortir du staking marche');
    eq(p.stakes.length, 0, 'plus rien au staking');
    ok(Number(moteur.balanceStr(J.address)) >= 100000, 'tout est revenu au joueur (mise + rendement) [' + moteur.balanceStr(J.address) + ']');
  }

  s.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
