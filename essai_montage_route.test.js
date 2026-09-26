'use strict';
/* ============================================================================
 * L'ESSAI DE MONTAGE, DE BOUT EN BOUT (route /studio/essai-montage)
 *
 * Sur le VRAI serveur, contre un faux xAI local :
 *   1. sans session : 401 ; OPTIONS repond sans session (CORS) ;
 *   2. un portefeuille qui n'est pas AI_OWNER apprend « proprietaire: false »,
 *      RIEN d'autre, et tout autre geste est refuse (403) AVANT la lecture du
 *      corps : un envoi de 50 Mo qui ne finit jamais recoit sa reponse tout de
 *      suite, un corps au-dela du plafond recoit 403 et non « illisible » ;
 *   3. le proprietaire lance un essai : xAI recoit POST /v1/videos/edits avec
 *      le modele, le prompt du sens et l'adresse PUBLIQUE du clip, en .mp4 ;
 *   4. cette adresse rend les octets envoyes, sans session, tant que l'essai
 *      est en cours ; un deuxieme essai attend (429) ; un autre proprietaire ne
 *      lit pas cet essai ;
 *   5. accepte par xAI : une ligne « sent » au journal (survit a un
 *      redemarrage) ; fini : le clip rend 404, le cout vient des ticks, une
 *      ligne finale au journal ;
 *   6. aucun $SWOGE debite, et la cle xAI n'apparait dans aucune reponse.
 * ==========================================================================*/

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/essai-montage-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801';
process.env.STUDIO_MARGE = '1.5';
process.env.STUDIO_VIDEO_POLL_MS = '200'; process.env.STUDIO_VIDEO_MAX_MS = '60000';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0';
process.env.PUBLIC_URL = 'https://srv.example';
process.env.SITE_URL = 'https://site.example';
delete process.env.GROK_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_BASE_URL;
delete process.env.ESSAI_MONTAGE_PAR_JOUR;

/* Deux proprietaires (AI_OWNER en accepte plusieurs), poses AVANT de charger le serveur. */
const OWNER = ethers.Wallet.createRandom(), OWNER2 = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address + ',' + OWNER2.address;

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const W = (x) => ethers.utils.parseUnits(String(x), 18);
const dort = (ms) => new Promise((r) => setTimeout(r, ms));

/* un MP4 synthetique de `s` secondes : ftyp, free, mdat, moov/mvhd v0 */
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x); return b; };
const boite = (type, contenu) => Buffer.concat([u32(8 + contenu.length), Buffer.from(type, 'latin1'), contenu]);
const mvhd0 = (echelle, duree) => { const c = Buffer.alloc(100); c.writeUInt32BE(echelle, 12); c.writeUInt32BE(duree, 16); return boite('mvhd', c); };
const clip = (s, octets) => Buffer.concat([boite('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1')), boite('free', Buffer.alloc(8)),
  boite('mdat', Buffer.from(Array.from({ length: octets || 1000 }, (_, i) => (i * 37) & 255))), boite('moov', mvhd0(1000, Math.round(s * 1000)))]);
const dataUrl = (b) => 'data:video/mp4;base64,' + b.toString('base64');

async function connecte(port, moteur, w) {
  w = w || ethers.Wallet.createRandom();
  const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
  s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
  await new Promise((r) => s.on('open', r));
  const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
  const h = await attend('hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  const auth = await attend('auth');
  const adr = w.address.toLowerCase();
  moteur()._p(adr).balance = W(200000);
  return { adr, s, H: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.session } };
}

(async () => {
  const port = await libre();
  process.env.PORT = String(port);
  const vus = [];
  const finis = new Set();
  let nEdit = 0;
  const fauxXai = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
      vus.push({ methode: q.method, url: q.url, auth: q.headers.authorization, corps: b ? JSON.parse(b) : null });
      r.writeHead(200, { 'content-type': 'application/json' });
      if (q.method === 'POST' && q.url === '/v1/videos/edits') return r.end(JSON.stringify({ request_id: 'edit-' + (++nEdit) }));
      const m = /^\/v1\/videos\/(edit-\d+)$/.exec(q.url);
      /* la forme de la spec : {status, response: VideoResponse} */
      if (m && finis.has(m[1])) return r.end(JSON.stringify({ status: 'done', response: { status: 'done', progress: 100,
        video: { url: 'https://vidgen.x.ai/' + m[1] + '.mp4', duration: 5 }, usage: { cost_in_usd_ticks: 2468024680 } } }));
      if (m) return r.end(JSON.stringify({ status: 'pending', response: { status: 'pending', progress: 40 } }));
      r.end('{}');
    });
  });
  const pX = await libre(); await new Promise((r) => fauxXai.listen(pX, r));
  process.env.XAI_API_KEY = 'xai-test-local';
  process.env.XAI_BASE_URL = 'http://127.0.0.1:' + pX;

  const { Game } = require('./game');
  let moteur = null;
  const p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
  const M = require('./essai_montage');
  require('./server');
  await dort(900);
  const base = 'http://127.0.0.1:' + port;
  const textes = [];   /* chaque reponse, pour y chercher la cle */
  const api = async (chemin, H, methode, corps) => {
    const r = await fetch(base + chemin, { method: methode || 'GET', headers: H, body: corps ? JSON.stringify(corps) : undefined });
    const t = await r.text(); textes.push(t);
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    return Object.assign({ cles: Object.keys(j) }, j, { http: r.status });   /* `statut` est un champ de l essai : le code HTTP s appelle `http` */
  };

  console.log('-- 1. la session, et rien d autre --');
  eq((await api('/studio/essai-montage', {})).http, 401, 'sans session : GET 401');
  eq((await api('/studio/essai-montage', { 'content-type': 'application/json' }, 'POST', { video: dataUrl(clip(5)), sens: 'reel' })).http, 401, 'sans session : POST 401');
  const pre = await fetch(base + '/studio/essai-montage', { method: 'OPTIONS' });
  ok(pre.status === 204 && /POST/.test(pre.headers.get('access-control-allow-methods') || '') && /authorization/.test(pre.headers.get('access-control-allow-headers') || ''), 'OPTIONS : 204 avec CORS, sans session');

  const proprio = await connecte(port, () => moteur, OWNER);
  const proprio2 = await connecte(port, () => moteur, OWNER2);
  const bob = await connecte(port, () => moteur);

  console.log('\n-- 2. un autre portefeuille : « pas proprietaire », rien d autre --');
  const gb = await api('/studio/essai-montage', bob.H);
  ok(gb.http === 200 && gb.ok === true && gb.proprietaire === false, 'GET : 200, proprietaire false');
  eq(gb.cles.sort().join(','), 'ok,proprietaire', 'et AUCUN autre champ');
  const t0 = Date.now();
  const suspendu = await new Promise((res) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/studio/essai-montage', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bob.H.authorization, 'content-length': String(50 * 1024 * 1024) } }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { res({ statut: r.statusCode, corps: b }); q.destroy(); });
    });
    q.on('error', () => {});
    q.write('{"video":"data:video/mp4;base64,AAAA');   /* le reste n arrive jamais */
    setTimeout(() => { res({ delai: true }); q.destroy(); }, 3000);
  });
  ok(suspendu.statut === 403 && /owner only \(AI_OWNER on the server\)/.test(suspendu.corps), 'POST de 50 Mo annonces qui n arrivent jamais : 403 sans attendre le corps [' + (suspendu.statut || 'delai') + ']');
  ok(Date.now() - t0 < 1500, 'et vite [' + (Date.now() - t0) + ' ms]');
  const gros = await api('/studio/essai-montage', bob.H, 'POST', { video: 'data:video/mp4;base64,' + 'A'.repeat(40 * 1024 * 1024), sens: 'reel' });
  ok(gros.http === 403 && gros.raison === 'owner only (AI_OWNER on the server)', 'un corps de 40 Mo (au-dela du plafond de 36) : 403, pas « illisible » — le corps n est pas lu');
  eq((await api('/studio/essai-montage/' + 'a'.repeat(24), bob.H)).http, 403, 'lire un essai : 403');
  eq((await api('/studio/essai-montage/autre', bob.H, 'DELETE')).http, 403, 'tout autre geste : 403');
  eq(vus.length, 0, 'rien n est parti chez xAI');

  console.log('\n-- 3. le proprietaire lance un essai --');
  const avant = moteur.balanceStr(proprio.adr);
  const g0 = await api('/studio/essai-montage', proprio.H);
  ok(g0.ok && g0.proprietaire === true && g0.reste === 5 && g0.parJour === 5 && g0.dureeMaxS === 8.7 && g0.octetsMax === 25 * 1024 * 1024
     && g0.sens.join(',') === 'reel,anime,libre' && g0.essais.length === 0 && g0.actif === true, 'GET : proprietaire, cinq essais, les bornes, xAI allume');
  const long = await api('/studio/essai-montage', proprio.H, 'POST', { video: dataUrl(clip(12)), sens: 'reel' });
  ok(long.http === 400 && /12\.0 s long/.test(long.raison) && /8\.7 s max/.test(long.raison), 'un clip de 12 s : 400, la longueur dans la raison [' + long.raison + ']');
  const pasMp4 = await api('/studio/essai-montage', proprio.H, 'POST', { video: 'data:video/mp4;base64,' + Buffer.from('hello, not a video').toString('base64'), sens: 'reel' });
  ok(pasMp4.http === 400 && /not an MP4/.test(pasMp4.raison), 'pas un MP4 : 400');
  eq(vus.length, 0, 'ni l un ni l autre n est parti chez xAI');
  const octets = clip(5, 200 * 1024);
  const r1 = await api('/studio/essai-montage', proprio.H, 'POST', { video: dataUrl(octets), sens: 'reel', addr: bob.adr });
  ok(r1.http === 200 && r1.ok && /^[0-9a-f]{24}$/.test(r1.id) && r1.status === 'pending' && r1.dureeS === 5, 'lance : 200, en cours, 5 s');
  const envoi = vus.filter((v) => v.url === '/v1/videos/edits');
  eq(envoi.length, 1, 'xAI recoit un POST /v1/videos/edits');
  const c = envoi[0].corps;
  eq(Object.keys(c).sort().join(','), 'model,prompt,video', 'le corps : model, prompt, video');
  eq(c.model, 'grok-imagine-video', 'le modele');
  ok(c.prompt === M.SENS.reel, 'le prompt du sens « reel », pas un texte du corps');
  ok(/^https:\/\/srv\.example\/studio\/essai-montage\/video\/[0-9a-f]{48}\.mp4$/.test(c.video && c.video.url), 'video.url : l adresse PUBLIQUE du clip, en .mp4 [' + (c.video && c.video.url) + ']');
  eq(envoi[0].auth, 'Bearer xai-test-local', 'avec la cle de la maison, dans l en-tete seulement');

  console.log('\n-- 4. en cours : le clip se lit par son adresse, un essai a la fois --');
  const chemin = c.video.url.slice('https://srv.example'.length);
  const f = await fetch(base + chemin);
  const lu = Buffer.from(await f.arrayBuffer());
  ok(f.status === 200 && f.headers.get('content-type') === 'video/mp4' && lu.equals(octets), 'sans session, les octets envoyes, en video/mp4 [' + lu.length + ' octets]');
  const h = await fetch(base + chemin, { method: 'HEAD' });
  ok(h.status === 200 && Number(h.headers.get('content-length')) === octets.length, 'HEAD : 200 et la taille');
  eq((await fetch(base + '/studio/essai-montage/video/..%2F..%2Fessai_montage.jsonl')).status, 404, 'un nom qui sort du dossier : 404');
  eq((await fetch(base + '/studio/essai-montage/video/' + 'e'.repeat(48) + '.mp4')).status, 404, 'un nom inconnu : 404');
  const r2 = await api('/studio/essai-montage', proprio.H, 'POST', { video: dataUrl(clip(3)), sens: 'anime' });
  ok(r2.http === 429 && /one test at a time/.test(r2.raison), 'un deuxieme essai pendant le premier : 429');
  eq(vus.filter((v) => v.url === '/v1/videos/edits').length, 1, 'et il n est pas parti');
  const journal = () => fs.readFileSync(path.join(process.env.DATA_DIR, 'essai_montage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const S0 = journal();
  ok(S0.length === 1 && S0[0].statut === 'sent' && S0[0].id === r1.id && S0[0].addr === proprio.adr && S0[0].rid === 'edit-1',
    'en cours : une ligne « sent » au journal, a l adresse de la SESSION, avec le request_id d xAI (un redemarrage ne perd pas l essai)');
  let e = null;
  for (let i = 0; i < 30; i++) { e = await api('/studio/essai-montage/' + r1.id, proprio.H); if (e.progress === 40) break; await dort(100); }
  ok(e.http === 200 && e.status === 'pending' && e.statut === 'pending' && e.progress === 40, 'l etat en cours, avec la progression lue chez xAI');
  eq((await api('/studio/essai-montage/' + r1.id, proprio2.H)).http, 404, 'un autre proprietaire ne lit pas cet essai');
  eq((await api('/studio/essai-montage', proprio2.H)).essais.length, 0, 'ni ne le voit dans sa liste');

  console.log('\n-- 5. fini : le clip part, le cout vient des ticks, une ligne au journal --');
  finis.add('edit-1');
  for (let i = 0; i < 40; i++) { e = await api('/studio/essai-montage/' + r1.id, proprio.H); if (e.status !== 'pending') break; await dort(100); }
  ok(e.status === 'done' && e.url === 'https://vidgen.x.ai/edit-1.mp4', 'fini, avec l adresse du resultat');
  eq(e.coutUsd, 0.246802468, 'le cout : 2 468 024 680 ticks = 0,246802468 $');
  eq(e.usdParSeconde, 0.246802468 / 5, 'par seconde de clip');
  ok(typeof e.secondes === 'number' && e.secondes >= 0, 'le temps d attente [' + e.secondes + ' s]');
  eq((await fetch(base + chemin)).status, 404, 'le clip rend 404 : il est efface');
  eq(fs.readdirSync(path.join(process.env.DATA_DIR, 'essai_montage')).length, 0, 'et le dossier est vide');
  const J = journal().filter((l) => l.statut !== 'sent');
  eq(journal().length, 2, 'le journal : la ligne « sent » puis la ligne finale');
  ok(J.length === 1 && J[0].id === r1.id && J[0].addr === proprio.adr && J[0].statut === 'done' && J[0].coutUsd === 0.246802468 && J[0].dureeS === 5 && J[0].octets === octets.length,
    'une ligne finale au journal, a l adresse de la SESSION (pas celle glissee dans le corps)');
  const g1 = await api('/studio/essai-montage', proprio.H);
  ok(g1.reste === 4 && g1.essais.length === 1 && g1.essais[0].statut === 'done' && g1.essais[0].usdParSeconde === 0.246802468 / 5, 'la liste : l essai fini, quatre de reste');

  console.log('\n-- 6. aucun $SWOGE, aucune cle --');
  eq(moteur.balanceStr(proprio.adr), avant, 'le solde de jeu du proprietaire est inchange (sa mesure, la cle de la maison)');
  ok(!textes.some((t) => t.includes('xai-test-local')), 'la cle xAI n apparait dans aucune des ' + textes.length + ' reponses');

  proprio.s.close(); proprio2.s.close(); bob.s.close(); fauxXai.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
