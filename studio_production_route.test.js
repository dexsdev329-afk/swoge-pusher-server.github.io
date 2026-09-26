'use strict';
/* ============================================================================
 * SERIES ET PUBS, DE BOUT EN BOUT (route /studio/production)
 *
 * Sur le VRAI serveur, contre un faux xAI local :
 *   1. sans session : 401 ; la production appartient a l'adresse de la SESSION ;
 *   2. deux scenes partent avec EXACTEMENT les memes reference_images (des
 *      adresses publiques lisibles par xAI) et reference_audios, sur le modele
 *      qui les comprend (grok-imagine-video-1.5), au format de la production ;
 *   3. l'image rangee se relit par son adresse publique (c'est ce que lit xAI) ;
 *   4. une scene est une video ordinaire : l'adresse de la session est debitee
 *      de la facture annoncee, rien de plus ; la scene notee finie avec sa video ;
 *   5. un autre portefeuille ne voit, ne tourne, ne supprime rien ;
 *   6. une production refusee ne laisse aucune image derriere elle.
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

process.env.DATA_DIR = fs.mkdtempSync('/tmp/production-');
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

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const W = (x) => ethers.utils.parseUnits(String(x), 18);
const PNG = 'data:image/png;base64,' + Buffer.alloc(200, 5).toString('base64');
const JPG = 'data:image/jpeg;base64,' + Buffer.alloc(200, 6).toString('base64');

async function connecte(port, moteur) {
  const w = ethers.Wallet.createRandom();
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
  let nVideo = 0;
  const fauxXai = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
      vus.push({ url: q.url, corps: b ? JSON.parse(b) : null });
      r.writeHead(200, { 'content-type': 'application/json' });
      if (q.url === '/v1/videos/generations') return r.end(JSON.stringify({ request_id: 'req-' + (++nVideo) }));
      const m = /^\/v1\/videos\/(req-\d+)$/.exec(q.url);
      if (m) return r.end(JSON.stringify({ status: 'done', video: { url: 'https://vidgen.x.ai/' + m[1] + '.mp4', duration: 10 }, usage: { cost_in_usd_ticks: 5e9 } }));
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
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const base = 'http://127.0.0.1:' + port;
  const api = async (chemin, H, methode, corps) => {
    const r = await fetch(base + chemin, { method: methode || 'GET', headers: H, body: corps ? JSON.stringify(corps) : undefined });
    return Object.assign({ statut: r.status }, await r.json().catch(() => ({})));
  };

  console.log('-- 1. la session, et rien d autre --');
  eq((await api('/studio/production', {})).statut, 401, 'sans session : 401');
  const alice = await connecte(port, () => moteur);
  const bob = await connecte(port, () => moteur);
  const cat = await api('/studio/production', alice.H);
  ok(cat.ok && cat.productions.length === 0 && cat.voix.some((v) => v.id === 'rex') && cat.personnagesMax === 3, 'le catalogue : aucune production, les voix, trois personnages au plus');
  eq(cat.swoge, 'https://site.example/img/site/swoge_reference.jpg', 'l image officielle de SWOGE est designee par son adresse sur le site');

  console.log('\n-- 2. deux scenes, les memes references --');
  const cree = await api('/studio/production', alice.H, 'POST', { addr: bob.adr, production: { mode: 'serie', titre: 'Gym Wars', format: '9:16',
    personnages: [{ nom: 'SWOGE', image: 'swoge', voix: 'rex' }, { nom: 'Luna', image: PNG, voix: 'eve' }] } });
  ok(cree.ok && cree.production.id, 'la serie est creee');
  const id = cree.production.id;
  const imgLuna = cree.production.personnages[1].image;
  ok(/^\/studio\/production\/image\/[0-9a-f]{48}\.png$/.test(imgLuna), 'l image de Luna est rangee chez nous [' + imgLuna + ']');
  eq((await api('/studio/production', bob.H)).productions.length, 0, 'l adresse glissee dans le corps n y est pour rien : Bob n a aucune production');

  const avant = W(moteur.balanceStr(alice.adr));
  const s1 = await api('/studio/production/' + id + '/scene', alice.H, 'POST', { texte: 'SWOGE lifts. Luna says "Not bad."', duree: 10, resolution: '480p' });
  ok(s1.ok && s1.id && s1.scene, 'la premiere scene est lancee');
  let ev = null;
  for (let i = 0; i < 40; i++) { ev = await api('/studio/media/video/' + s1.id, alice.H); if (ev.status !== 'pending') break; await new Promise((r) => setTimeout(r, 100)); }
  ok(ev.status === 'done', 'et finie');
  const s2 = await api('/studio/production/' + id + '/scene', alice.H, 'POST', { texte: 'Luna spots SWOGE on the bench.', duree: 10 });
  ok(s2.ok, 'la deuxieme aussi');
  const gen = vus.filter((v) => v.url === '/v1/videos/generations').map((v) => v.corps);
  eq(gen.length, 2, 'deux videos demandees a xAI');
  eq(JSON.stringify(gen[0].reference_images), JSON.stringify(gen[1].reference_images), 'les memes reference_images');
  eq(JSON.stringify(gen[0].reference_audios), JSON.stringify(gen[1].reference_audios), 'les memes reference_audios');
  eq(gen[0].reference_images.map((x) => x.url).join(','), 'https://site.example/img/site/swoge_reference.jpg,https://srv.example' + imgLuna, 'des adresses publiques : le site pour SWOGE, le serveur pour Luna');
  eq(gen[0].reference_audios.map((x) => x.voice_id).join(','), 'rex,eve', 'les voix dans l ordre des personnages');
  ok(gen[0].model === 'grok-imagine-video-1.5' && gen[0].aspect_ratio === '9:16' && gen[0].duration === 10, 'le modele des references, le format et la duree de la production');
  ok(/SWOGE is the character in <IMAGE_1>/.test(gen[0].prompt) && /Luna says "Not bad\."/.test(gen[0].prompt), 'le prompt nomme les personnages et garde la replique');

  console.log('\n-- 3. l image se relit par son adresse publique --');
  const f = await fetch(base + imgLuna);
  ok(f.status === 200 && f.headers.get('content-type') === 'image/png' && (await f.arrayBuffer()).byteLength === 200, 'servie telle quelle, avec son type');
  eq((await fetch(base + '/studio/production/image/..%2F..%2Fstate.json')).status, 404, 'un nom qui sort du dossier : 404');

  console.log('\n-- 4. une scene est une video ordinaire --');
  const debit = avant.sub(W(moteur.balanceStr(alice.adr)));
  ok(ev.factureSwoge && debit.gte(W(ev.factureSwoge)), 'l adresse de la session est debitee (la 2e scene reserve encore) [' + ev.factureSwoge + ']');
  let liste = null;
  for (let i = 0; i < 40; i++) { liste = await api('/studio/production', alice.H); if (liste.productions[0].scenes.every((s) => s.statut !== 'pending')) break; await new Promise((r) => setTimeout(r, 100)); }
  const sc = liste.productions[0].scenes;
  ok(sc.length === 2 && sc[0].statut === 'done' && sc[0].url === 'https://vidgen.x.ai/req-1.mp4' && sc[0].texte.startsWith('SWOGE lifts'), 'les scenes notees finies, avec leur video et leur texte');
  const apres = W(moteur.balanceStr(alice.adr));
  const factures = sc.reduce((a, s) => a.add(W(s.factureSwoge || 0)), W(0));
  ok(avant.sub(apres).eq(factures), 'au total : exactement la somme des deux factures, le reste rendu');

  console.log('\n-- 5. un autre portefeuille ne voit, ne tourne, ne supprime rien --');
  eq((await api('/studio/production/' + id + '/scene', bob.H, 'POST', { texte: 'x' })).statut, 404, 'Bob ne tourne pas une scene de la serie d Alice');
  eq((await api('/studio/production/' + id, bob.H, 'DELETE')).statut, 404, 'ni ne la supprime');
  const vol = await api('/studio/production', bob.H, 'POST', { production: { mode: 'serie', titre: 'Vol', personnages: [{ nom: 'X', image: imgLuna }] } });
  ok(vol.statut === 400 && /PNG, JPEG or WebP/.test(vol.raison), 'ni ne reprend l image rangee par Alice');

  console.log('\n-- 6. refusee : aucune image laissee --');
  const dossierImages = path.join(process.env.DATA_DIR, 'productions', 'images');
  const nb = () => fs.readdirSync(dossierImages).length;
  const n0 = nb();
  const refus = await api('/studio/production', alice.H, 'POST', { production: { mode: 'serie', titre: 'T', personnages: [{ nom: 'A', image: JPG }, { nom: 'B', image: 'swoge', voix: 'darth' }] } });
  ok(refus.statut === 400 && /unknown voice/.test(refus.raison), 'une voix inconnue : 400 avec la raison');
  eq(nb(), n0, 'et l image du premier personnage n est pas restee');
  const pub = await api('/studio/production', alice.H, 'POST', { production: { mode: 'pub', titre: 'Shaker', produit: { nom: 'Swole Shaker', image: JPG, voix: 'ara', slogan: 'Shake it' } } });
  ok(pub.ok && pub.production.format === '9:16', 'une pub, verticale par defaut');
  const sp = await api('/studio/production/' + pub.production.id + '/scene', alice.H, 'POST', { duree: 6 });
  const gp = vus.filter((v) => v.url === '/v1/videos/generations').pop().corps;
  ok(sp.ok && gp.reference_images.length === 1 && /product in <IMAGE_1>/.test(gp.prompt) && gp.duration === 6, 'sa scene sans texte : le produit en <IMAGE_1>, 6 s');
  const sup = await api('/studio/production/' + pub.production.id, alice.H, 'DELETE');
  ok(sup.ok && !fs.readdirSync(dossierImages).includes(pub.production.produit.image.split('/').pop()), 'supprimee : sa photo part avec elle');

  alice.s.close(); bob.s.close(); fauxXai.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
