'use strict';
/* ============================================================================
 * LA ROUTE D'ESSAI KLING (/studio/kling), SUR UN VRAI SERVEUR
 *
 * Ce qu'elle DOIT tenir, comme l'essai de restylage :
 *   1. sans session : 401 ; un autre portefeuille : il apprend qu'il n'est pas
 *      proprietaire, et TOUT geste lui est refuse (403) avant Kling ;
 *   2. le proprietaire lance une video : Kling recoit la requete, l'essai est
 *      journalise avec son estimation, aucun $SWOGE n'est debite ;
 *   3. le suivi rend la video, et la fin est journalisee ;
 *   4. la cle Kling ne sort jamais dans une reponse.
 * Kling est simule en remplacant `fetch` pour son seul domaine.
 * ==========================================================================*/
const net = require('net');
const fs = require('fs');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/kling-route-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0';
process.env.KLING_API_KEY = 'cle-kling-secrete';
const OWNER = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address;

/* Kling simule : seul api-singapore.klingai.com est intercepte. */
const recus = [];
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (!url.startsWith('https://api-singapore.klingai.com')) return vraiFetch(u, o);
  recus.push({ url, o });
  const rep = (j) => ({ status: 200, ok: true, json: async () => j });
  if (/\/tasks\?/.test(url)) return rep({ code: 0, data: [{ id: '8812', status: 'succeeded', outputs: [{ type: 'video', url: 'https://cdn.kling.example/v.mp4', duration: '5' }] }] });
  return rep({ code: 0, data: { id: '8812', status: 'submitted' } });
};

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });

async function connecte(port, w) {
  const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
  s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
  await new Promise((r) => s.on('open', r));
  const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
  const h = await attend('hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  const auth = await attend('auth');
  return { s, H: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.session } };
}

(async () => {
  const port = await libre();
  process.env.PORT = String(port);
  const tg = require.resolve('./telegram');
  require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };
  const { Game } = require('./game');
  let moteur = null;
  const p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:' + port;
  const appel = (chemin, H, corps) => vraiFetch(B + chemin, { method: corps ? 'POST' : 'GET', headers: H || {}, body: corps ? JSON.stringify(corps) : undefined })
    .then(async (r) => ({ statut: r.status, j: await r.json().catch(() => ({})), brut: '' }));

  console.log('-- 1. qui peut --');
  ok((await appel('/studio/kling')).statut === 401, 'sans session : 401');
  const autre = await connecte(port, ethers.Wallet.createRandom());
  const va = await appel('/studio/kling', autre.H);
  ok(va.statut === 200 && va.j.proprietaire === false && !va.j.modeles, 'un autre portefeuille apprend qu il n est pas proprietaire, rien d autre');
  const lanceAutre = await appel('/studio/kling', autre.H, { prompt: 'a doge' });
  ok(lanceAutre.statut === 403 && recus.length === 0, 'et son lancement est refuse (403) avant Kling');
  ok((await appel('/studio/kling/8812', autre.H)).statut === 403, 'son suivi aussi');

  console.log('\n-- 2. le proprietaire --');
  const moi = await connecte(port, OWNER);
  const solde0 = moteur && moteur.balanceStr(OWNER.address.toLowerCase());
  const v = await appel('/studio/kling', moi.H);
  ok(v.j.proprietaire === true && v.j.actif === true && v.j.modeles['kling-2.6'], 'il voit l essai, Kling branche, et la grille');
  const r = await appel('/studio/kling', moi.H, { prompt: 'SWOGE lifts a barbell', duree: 5, resolution: '720p' });
  ok(r.statut === 200 && r.j.id === '8812' && r.j.estimationUsd === 0.21 && recus.length === 1 && recus[0].url.endsWith('/text-to-video/kling-2.6'),
     'la video part chez Kling (texte → video, kling-2.6), estimation 0,21 $');
  ok(recus[0].o.headers.authorization === 'Bearer cle-kling-secrete' && !JSON.stringify(r.j).includes('cle-kling'), 'la cle part vers Kling seulement, jamais dans la reponse');
  const s = await appel('/studio/kling/8812', moi.H);
  ok(s.j.statut === 'succeeded' && s.j.url === 'https://cdn.kling.example/v.mp4', 'le suivi rend la video');
  const j = fs.readFileSync(process.env.DATA_DIR + '/kling_essais.jsonl', 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  ok(j.length === 2 && j[0].estimationUsd === 0.21 && j[1].statut === 'succeeded', 'l essai et sa fin sont journalises');
  const v2 = await appel('/studio/kling', moi.H);
  ok(v2.j.essais.length === 2 && v2.j.essais[0].statut === 'succeeded', 'et relus par la page, le plus recent d abord');
  ok(!moteur || moteur.balanceStr(OWNER.address.toLowerCase()) === solde0, 'aucun $SWOGE debite (c est le compte Kling du proprietaire qui paie)');
  const avant = recus.length;
  ok((await appel('/studio/kling', moi.H, { prompt: '' })).statut === 400 && recus.length === avant, 'une entree refusee ne part pas chez Kling');

  autre.s.close(); moi.s.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
