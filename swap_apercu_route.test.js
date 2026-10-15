'use strict';
/* ============================================================================
 * SWOGE SWAP V2 SUR UN VRAI SERVEUR — apercu OpenAI puis « Animate » (15/10/2026 soir)
 *
 * Ce qu'elle DOIT tenir :
 *   1. Public : POST /studio/swap?mode=anime (la case de droits exigee, un mode inconnu 400),
 *      un clip de 8 s = un morceau ; GET /studio/swap rend le prix d'un apercu et `passeAnime`.
 *   2. POST /studio/swap/<id>/apercu : 401 sans session, 404 pour un autre joueur ; credit trop
 *      bas 402 sans appel ; sinon reserve, OpenAI recoit un VRAI multipart (relu par formData) :
 *      image[] = le plan PUIS le meme de SWOGE, la consigne, size au rapport de la video ; la
 *      facture lit usage × 2. L'image ne sort qu'avec la session qui l'a faite.
 *   3. POST …/lance { apercu: 0 } : Kling recoit CET apercu en first_frame (octet pour octet),
 *      la video en feature_video ; une `still` de la page : 400. Le prix de la video reserve ;
 *      a la fin, la video avec le son d'origine, a la session seulement.
 *   4. Proprietaire : /studio/kling/entier/<id>/apercu — 403 pour un autre portefeuille, AVANT
 *      tout appel ; pour lui, l'image faite et servie ; GET /studio/kling dit l'apercu.
 *   5. Ni la cle OpenAI ni celle de Kling dans aucune reponse.
 * OpenAI, Kling et son CDN sont simules en remplacant `fetch` pour leurs seuls domaines.
 * ==========================================================================*/
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/swap-apercu-route-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0';
process.env.KLING_API_KEY = 'cle-kling-secrete';
process.env.OPENAI_API_KEY = 'sk-cle-openai-secrete';
process.env.KLING_TG = '0';
process.env.SITE_URL = 'https://site.example';
delete process.env.SWAP_MARGE; delete process.env.SWAP_PLAFOND_JOUR_USD; delete process.env.SWAP_IMAGE_MODELE; delete process.env.OPENAI_BASE_URL;
const OWNER = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address;
const J1 = ethers.Wallet.createRandom(), J2 = ethers.Wallet.createRandom();
fs.writeFileSync(path.join(process.env.DATA_DIR, 'credits.json'), JSON.stringify({ soldes: { [J1.address.toLowerCase()]: 10e6, [J2.address.toLowerCase()]: 0.5e6 }, ouvertes: {}, tx: {}, seq: 0 }));

let ffmpegOk = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { ffmpegOk = false; }
const VIDEO = path.join(process.env.DATA_DIR, 'source.mp4');
const ROUGE = path.join(process.env.DATA_DIR, 'rouge.png');
if (ffmpegOk) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '8', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-t', '8', '-i', 'sine=frequency=330',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', VIDEO]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=864x1536', '-frames:v', '1', ROUGE]);
}

const recus = [], taches = {}, openai = [];
let etatTaches = 'processing';
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  /* OpenAI : le corps est relu comme un serveur le lirait (multipart encode par fetch) */
  if (url.startsWith('https://api.openai.com/')) {
    const req = new Request(url, o);
    const fd = await req.formData();
    const champs = {};
    for (const [k, v] of fd.entries()) (champs[k] = champs[k] || []).push(typeof v === 'string' ? v : { type: v.type, octets: Buffer.from(await v.arrayBuffer()) });
    openai.push({ url, auth: req.headers.get('authorization'), type: req.headers.get('content-type'), champs });
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: fs.readFileSync(ROUGE).toString('base64') }],
      usage: { input_tokens: 3000, input_tokens_details: { text_tokens: 500, image_tokens: 2500 }, output_tokens: 7000, total_tokens: 10000 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://p2-kling.klingai.com/')) {
    const id = /\/r\/(\w+)\.mp4$/.exec(url); const t = id && taches[id[1]];
    if (!t) return new Response('', { status: 404 });
    return new Response(t.octets, { status: 200, headers: { 'content-length': String(t.octets.length) } });
  }
  if (!url.startsWith('https://api-singapore.klingai.com')) return vraiFetch(u, o);
  recus.push({ url, o });
  const rep = (j) => ({ status: 200, ok: true, json: async () => j });
  const m = /\/tasks\?task_ids=(\w+)/.exec(url);
  if (m) {
    const t = taches[m[1]];
    return rep({ code: 0, data: t ? [etatTaches === 'succeeded'
      ? { id: m[1], status: 'succeeded', outputs: [{ type: 'video', url: 'https://p2-kling.klingai.com/r/' + m[1] + '.mp4', duration: '8' }] }
      : { id: m[1], status: etatTaches }] : [] });
  }
  if (/external_task_ids/.test(url)) return rep({ code: 0, data: [] });
  const b = JSON.parse(o.body);
  const v = b.contents.find((c) => c.type === 'feature_video' || c.type === 'base_video');
  const r = await vraiFetch(v.url);
  const fi = path.join(process.env.DATA_DIR, 'lu.mp4'), fo = path.join(process.env.DATA_DIR, 'rendu_' + recus.length + '.mp4');
  fs.writeFileSync(fi, Buffer.from(await r.arrayBuffer()));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fi, '-an', '-c:v', 'copy', fo]);
  const id = 'N' + (Object.keys(taches).length + 1);
  taches[id] = { octets: fs.readFileSync(fo) };
  return rep({ code: 0, data: { id, status: 'submitted' } });
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
const sonde = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', f]).toString());
const dims = (b) => require('./kling').dimensionsImage(b);

(async () => {
  if (!ffmpegOk) { console.log('ffmpeg absent : essai ignore'); return; }
  const port = await libre();
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;
  const tg = require.resolve('./telegram');
  require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:' + port;
  const textes = [];
  const appel = async (chemin, H, corps, methode, brut) => {
    const r = await vraiFetch(B + chemin, { method: methode || (corps || brut ? 'POST' : 'GET'), headers: H || {}, body: brut || (corps ? JSON.stringify(corps) : undefined) });
    const t = await r.text(); textes.push(t);
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    return { statut: r.status, j, t };
  };
  const binaire = async (chemin, H) => { const r = await vraiFetch(B + chemin, { headers: H || {} }); return { statut: r.status, type: r.headers.get('content-type'), octets: Buffer.from(await r.arrayBuffer()) }; };
  const octets = fs.readFileSync(VIDEO);
  const j1 = await connecte(port, J1), j2 = await connecte(port, J2), moi = await connecte(port, OWNER);
  const credit = async (H) => (await appel('/credit', H)).j.balanceUsd;
  const HV = (H, droits) => Object.assign({ 'content-type': 'video/mp4', authorization: H.authorization }, droits ? { 'x-swap-rights': 'yes' } : {});
  const attendStatut = async (chemin, H, pas) => { let e; for (let k = 0; k < 300; k++) { e = await appel(chemin, H); if (!pas.includes(e.j.statut)) break; await new Promise((r) => setTimeout(r, 100)); } return e; };
  const attendApercu = async (chemin, H) => { let e; for (let k = 0; k < 300; k++) { e = await appel(chemin, H); const a = e.j.apercu; if (a && !a.enCours) break; await new Promise((r) => setTimeout(r, 100)); } return e; };

  console.log('-- 1. le televersement « Animate » --');
  ok((await appel('/studio/swap?mode=zzz', HV(j1.H, true), null, 'POST', octets)).statut === 400, 'un mode inconnu : 400');
  ok((await appel('/studio/swap?mode=anime', HV(j1.H, false), null, 'POST', octets)).statut === 400, 'sans la case de droits : 400');
  const c = await appel('/studio/swap?mode=anime', HV(j1.H, true), null, 'POST', octets);
  ok(c.statut === 200 && /^[0-9a-f]{24}$/.test(c.j.id), 'la video brute, ?mode=anime, la case cochee : acceptee');
  const id = c.j.id;
  let e = await attendStatut('/studio/swap/' + id, j1.H, ['decoupe']);
  ok(e.j.statut === 'pret' && e.j.morceaux.length === 1 && e.j.anime && e.j.anime.clip === true && e.j.prixUsdParResolution['720p'] === 2.02, 'un clip de 8 s : un morceau, 2,02 $ (8 × 0,126 × 2) [' + e.j.statut + ' ' + (e.j.message || '') + ']');
  const vue = await appel('/studio/swap', j1.H);
  ok(vue.j.apercu && vue.j.apercu.prixUsd === 1.13 && vue.j.apercu.actif === true && vue.j.passeAnime === id && vue.j.clipMaxS === 10, 'GET /studio/swap : apercu 1,13 $, passeAnime, clip jusqu a 10 s');

  console.log('\n-- 2. l apercu --');
  ok((await appel('/studio/swap/' + id + '/apercu', { 'content-type': 'application/json' }, { cible: 'gauche' })).statut === 401, 'sans session : 401');
  ok((await appel('/studio/swap/' + id + '/apercu', j2.H, { cible: 'gauche' })).statut === 404 && openai.length === 0, 'un autre joueur : 404, rien chez OpenAI');
  const c2 = await appel('/studio/swap?mode=anime', HV(j2.H, true), null, 'POST', octets);
  await attendStatut('/studio/swap/' + c2.j.id, j2.H, ['decoupe']);
  const pauvre = await appel('/studio/swap/' + c2.j.id + '/apercu', j2.H, { cible: 'gauche' });
  ok(pauvre.statut === 402 && /\$1\.13 needed/.test(pauvre.j.raison) && openai.length === 0 && await credit(j2.H) === 0.5, 'credit de 0,50 $ : 402, rien chez OpenAI, rien debite');
  const a = await appel('/studio/swap/' + id + '/apercu', j1.H, { cible: 'gauche' });
  ok(a.statut === 200 && a.j.apercu.candidats[0].statut === 'making' && await credit(j1.H) === 8.87, 'Create preview : 1,13 $ reserves, en cours');
  const ea = await attendApercu('/studio/swap/' + id + '/apercu', j1.H);
  const q = openai[0] || { champs: {} };
  const im = q.champs['image[]'] || [];
  ok(openai.length === 1 && q.url === 'https://api.openai.com/v1/images/edits' && /^multipart\/form-data; boundary=/.test(q.type) && q.auth === 'Bearer sk-cle-openai-secrete', 'OpenAI : un vrai multipart, la cle en Bearer');
  ok(im.length === 2 && dims(im[0].octets).largeur === 720 && dims(im[0].octets).hauteur === 1280 && im[1].octets.equals(fs.readFileSync(path.join(__dirname, 'references', 'swoge_meme_ref.jpg')))
     && q.champs.size[0] === '864x1536' && q.champs.model[0] === 'gpt-image-2' && /replace ONLY the person on the LEFT side of the frame with the character from image 2/.test(q.champs.prompt[0]),
     'image[] : le plan 720×1280 puis le meme de SWOGE ; 864×1536 ; la consigne a gauche');
  ok(ea.j.apercu.candidats[0].statut === 'ready' && ea.j.apercu.candidats[0].factureUsd === 0.47 && await credit(j1.H) === 9.53, 'prete : 0,47 $ factures, le reste rendu (9,53 $)');
  const img = await binaire('/studio/swap/' + id + '/apercu/0', { authorization: j1.H.authorization });
  ok(img.statut === 200 && img.type === 'image/jpeg' && dims(img.octets).largeur === 720 && dims(img.octets).hauteur === 1280, 'l image : JPEG 720×1280 avec la session');
  ok((await binaire('/studio/swap/' + id + '/apercu/0', { authorization: j2.H.authorization })).statut === 404 && (await binaire('/studio/swap/' + id + '/apercu/0')).statut === 401, 'un autre : 404 ; sans session : 401');

  console.log('\n-- 3. Animate --');
  const page = await appel('/studio/swap/' + id + '/lance', j1.H, { still: 'data:image/png;base64,' + fs.readFileSync(ROUGE).toString('base64'), apercu: 0, confirmeUsd: 2.02 });
  ok(page.statut === 400 && recus.length === 0 && await credit(j1.H) === 9.53, 'une image de la page : 400, rien chez Kling, rien reserve');
  const l = await appel('/studio/swap/' + id + '/lance', j1.H, { apercu: 0, resolution: '720p', confirmeUsd: 2.02 });
  const envois = recus.filter((x) => /omni-video\/kling-o1$/.test(x.url)).map((x) => JSON.parse(x.o.body));
  const b = envois[0] || { contents: [] };
  ok(l.statut === 200 && l.j.statut === 'en_cours' && await credit(j1.H) === 7.51, 'Animate : en cours, 2,02 $ reserves (7,51 $)');
  ok(JSON.stringify(b.contents.map((x) => x.type + ':' + (x.id || ''))) === JSON.stringify(['prompt:', 'first_frame:image_1', 'refer_image:image_2', 'refer_image:image_3', 'feature_video:video_1'])
     && Buffer.from(b.contents[1].url, 'base64').equals(img.octets) && !b.contents.some((x) => x.type === 'base_video'),
     'Kling : first_frame = l apercu octet pour octet, SWOGE en refer_image, feature_video ; jamais base_video');
  etatTaches = 'succeeded';
  e = await attendStatut('/studio/swap/' + id, j1.H, ['en_cours', 'assemblage', 'file']);
  ok(e.j.statut === 'fini' && e.j.video === '/studio/swap/' + id + '/video' && e.j.paiement.factureUsd === 2.02, 'fini, 2,02 $ factures [' + e.j.statut + ' ' + (e.j.message || '') + ']');
  const v = await binaire(e.j.video, { authorization: j1.H.authorization });
  const f = path.join(process.env.DATA_DIR, 'fin.mp4'); fs.writeFileSync(f, v.octets);
  const s = sonde(f);
  ok(v.statut === 200 && Math.abs(Number(s.format.duration) - 8) <= 0.06 && s.streams.some((x) => x.codec_type === 'audio') && (await binaire(e.j.video, { authorization: j2.H.authorization })).statut === 404,
     'la video : 8 s avec le son d origine, a la session seulement');

  console.log('\n-- 4. le proprietaire --');
  const o = await appel('/studio/kling/entier?mode=anime-clip', HV(moi.H), null, 'POST', octets);
  await attendStatut('/studio/kling/entier/' + o.j.id, moi.H, ['decoupe']);
  const avant = openai.length;
  ok((await appel('/studio/kling/entier/' + o.j.id + '/apercu', j1.H, { cible: 'seule' })).statut === 403 && openai.length === avant, 'un autre portefeuille : 403, rien chez OpenAI');
  const pa = await appel('/studio/kling/entier/' + o.j.id + '/apercu', moi.H, { cible: 'seule' });
  const pe = await attendApercu('/studio/kling/entier/' + o.j.id + '/apercu', moi.H);
  const pi = await binaire('/studio/kling/entier/' + o.j.id + '/apercu/0', { authorization: moi.H.authorization });
  ok(pa.statut === 200 && openai.length === avant + 1 && pe.j.apercu.candidats[0].statut === 'ready' && pe.j.apercu.candidats[0].coutUsd === 0.2325 && pi.statut === 200 && dims(pi.octets).largeur === 720,
     'le proprietaire : l image faite (cout OpenAI 0,2325 $ montre), servie a sa session');
  ok(/replace the only person with/.test(openai[openai.length - 1].champs.prompt[0]), 'sa consigne : la seule personne');
  const kv = await appel('/studio/kling', moi.H);
  ok(kv.j.apercu && kv.j.apercu.actif === true && kv.j.apercu.modele === 'gpt-image-2' && kv.j.apercu.parJour === 30, 'GET /studio/kling : l apercu (gpt-image-2, 30 par jour)');

  console.log('\n-- 5. les cles --');
  ok(textes.every((t) => !t.includes('sk-cle-openai-secrete') && !t.includes('cle-kling-secrete')), 'aucune cle dans aucune reponse');
  j1.s.close(); j2.s.close(); moi.s.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
