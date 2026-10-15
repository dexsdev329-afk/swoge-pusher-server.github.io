'use strict';
/* ============================================================================
 * L'ELEMENT SWOGE ET LA PREMIERE IMAGE SUR UN VRAI SERVEUR (15/10/2026)
 * Routes /studio/kling/swoge* et /studio/kling/premiere*, et leur effet sur
 * /studio/kling/edition.
 *
 * Ce qu'elles DOIVENT tenir :
 *   1. un autre portefeuille : 403 sur chaque geste, rien chez Kling ; sans session : 401 ;
 *   2. le proprietaire : « Prepare SWOGE views » part chez Kling Image O1 (le meme seul),
 *      la vue est telechargee et servie AVEC la session seulement ; choisir, creer
 *      l'element (corps de la doc), le suivi rend l'id ;
 *   3. avec l'element, l'edition d'un clip envoie { type: element } et @element_1, sans
 *      refer_image ; apres l'effacement (corps de la doc), retour aux deux images ;
 *   4. la premiere image : extraite par ffmpeg, 2 candidats, choisie, puis envoyee en
 *      derniere refer_image avec sa phrase ; une autre adresse ne la voit pas ;
 *   5. la cle Kling ne sort jamais dans une reponse.
 * Kling (api-singapore, p2-kling) est simule en remplacant `fetch` pour ces domaines.
 * ==========================================================================*/
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/swoge-element-route-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0';
process.env.KLING_API_KEY = 'cle-kling-secrete';
process.env.KLING_TG = '0';
process.env.SITE_URL = 'https://site.example';
const OWNER = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address;

function png(l, h) { const b = Buffer.alloc(3000); b.writeUInt32BE(0x89504E47, 0); b.writeUInt32BE(0x0D0A1A0A, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(l, 16); b.writeUInt32BE(h, 20); return b; }

/* Kling simule : les taches finissent quand l'essai le dit */
const recus = [];
let elementFini = false, imagesFinies = false, videoFinie = false;
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.startsWith('https://p2-kling.klingai.com/')) {
    recus.push({ url, cdn: true });
    const b = png(832, 1248);
    return { status: 200, ok: true, headers: { get: (h) => (h === 'content-length' ? String(b.length) : null) }, arrayBuffer: async () => b };
  }
  if (!url.startsWith('https://api-singapore.klingai.com')) return vraiFetch(u, o);
  const corps = o && o.body ? JSON.parse(o.body) : null;
  recus.push({ url, methode: o && o.method, corps });
  const rep = (data) => ({ status: 200, ok: true, json: async () => ({ code: 0, data }) });
  if (/\/v1\/images\/omni-image\/(IM\d+)$/.test(url)) {
    const id = /(IM\d+)$/.exec(url)[1];
    return rep(imagesFinies ? { task_id: id, task_status: 'succeed', task_result: { images: [{ url: 'https://p2-kling.klingai.com/' + id + 'a.png' }, { url: 'https://p2-kling.klingai.com/' + id + 'b.png' }] } } : { task_id: id, task_status: 'processing' });
  }
  if (/\/v1\/images\/omni-image$/.test(url)) return rep({ task_id: 'IM' + recus.filter((x) => /omni-image$/.test(x.url)).length, task_status: 'submitted' });
  if (/advanced-custom-elements\/EL1$/.test(url)) return rep(elementFini ? { task_id: 'EL1', task_status: 'succeed', task_result: { elements: [{ element_id: 829, status: 'succeed' }] }, final_unit_deduction: '2' } : { task_id: 'EL1', task_status: 'processing' });
  if (/advanced-custom-elements$/.test(url)) return rep({ task_id: 'EL1', task_status: 'submitted' });
  if (/delete-advanced-elements$/.test(url)) return rep({ task_id: 'D1', task_status: 'succeed' });
  if (/\/omni-video\/kling-o1$/.test(url)) return rep({ id: 'O1T' + recus.length, status: 'submitted' });
  if (/\/tasks\?/.test(url)) { const id = /task_ids=([^&]+)/.exec(url); return rep([videoFinie ? { id: id && id[1], status: 'succeeded', outputs: [{ type: 'video', url: 'https://p2-kling.klingai.com/v.mp4', duration: '5' }] } : { id: id && id[1], status: 'processing' }]); }
  return { status: 404, ok: false, json: async () => ({ code: 404 }) };
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
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;
  const tg = require.resolve('./telegram');
  require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:' + port;
  const textes = [];
  const appel = async (chemin, H, corps, methode) => {
    const r = await vraiFetch(B + chemin, { method: methode || (corps ? 'POST' : 'GET'), headers: H || {}, body: corps ? JSON.stringify(corps) : undefined });
    const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); textes.push(t);
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    return { statut: r.status, j, buf, type: r.headers.get('content-type') };
  };
  const clipF = path.join(process.env.DATA_DIR, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '5', '-i', 'testsrc2=size=720x1280:rate=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clipF]);
  const video = 'data:video/mp4;base64,' + fs.readFileSync(clipF).toString('base64');
  const envoisVideo = () => recus.filter((x) => /omni-video/.test(x.url)).map((x) => x.corps);

  console.log('-- 1. qui peut --');
  ok((await appel('/studio/kling/swoge', { 'content-type': 'application/json' })).statut === 401, 'sans session : 401');
  const autre = await connecte(port, ethers.Wallet.createRandom());
  const refus = [await appel('/studio/kling/swoge', autre.H), await appel('/studio/kling/swoge/prepare', autre.H, {}), await appel('/studio/kling/swoge/element', autre.H, {}),
    await appel('/studio/kling/swoge/supprime', autre.H, {}), await appel('/studio/kling/premiere', autre.H, { video, cible: 'seule' })];
  ok(refus.every((r) => r.statut === 403) && recus.length === 0, 'un autre portefeuille : 403 sur l etat, Prepare, creer, effacer, premiere image ; rien chez Kling');

  console.log('\n-- 2. les vues et l element --');
  const moi = await connecte(port, OWNER);
  const v0 = await appel('/studio/kling', moi.H);
  ok(v0.j.swoge && v0.j.swoge.element === null && v0.j.swoge.choix.frontal === 'site' && v0.j.swoge.defauts.frontal === '/img/site/swoge_meme_ref.jpg' && v0.j.swoge.prixImageUsd === 0.028,
     'la page lit l etat de l element : aucun, le meme en frontal, 0,028 $ l image');
  const p = await appel('/studio/kling/swoge/prepare', moi.H, { vues: ['pied'] });
  const ci = recus.find((x) => /omni-image$/.test(x.url));
  ok(p.statut === 200 && ci && ci.corps.model_name === 'kling-image-o1' && ci.corps.image_list.length === 1 && ci.corps.image_list[0].image === 'https://site.example/img/site/swoge_meme_ref.jpg',
     'Prepare (vue de face) : Kling Image O1, depuis le meme seul');
  imagesFinies = true;
  const e1 = await appel('/studio/kling/swoge', moi.H);
  const vue = e1.j.vues && e1.j.vues[0];
  ok(vue && vue.statut === 'pret' && recus.some((x) => x.cdn), 'le suivi : la vue est prete, telechargee du CDN de Kling');
  const im = await appel(vue.image, moi.H);
  ok(im.statut === 200 && im.type === 'image/png' && im.buf.equals(png(832, 1248)), 'l image de la vue, avec la session du proprietaire');
  ok((await appel(vue.image, autre.H)).statut === 403 && (await appel(vue.image, {})).statut === 401, 'l image : 403 pour un autre, 401 sans session');
  ok((await appel('/studio/kling/swoge/choisit', moi.H, { slot: 'pied', id: vue.id })).statut === 200, 'choisir la vue de face');
  const up = await appel('/studio/kling/swoge/vue', moi.H, { slot: 'profil', image: 'data:image/png;base64,' + png(900, 1350).toString('base64') });
  const upMauvais = await appel('/studio/kling/swoge/vue', moi.H, { slot: 'profil', image: 'data:image/webp;base64,UklGRgAAAABXRUJQVlA4IAAAAAA=' });
  ok(up.statut === 200 && up.j.vue.source === 'upload' && upMauvais.statut === 400, 'televerser une vue (PNG) : ok ; une WebP : 400');
  await appel('/studio/kling/swoge/choisit', moi.H, { slot: 'profil', id: up.j.vue.id });
  const c = await appel('/studio/kling/swoge/element', moi.H, {});
  const ce = recus.find((x) => /advanced-custom-elements$/.test(x.url));
  ok(c.statut === 200 && c.j.element.statut === 'creation' && ce && ce.methode === 'POST' && ce.corps.reference_type === 'image_refer' && ce.corps.element_name === 'SWOGE'
     && ce.corps.element_image_list.frontal_image === 'https://site.example/img/site/swoge_meme_ref.jpg' && ce.corps.element_image_list.refer_images.length === 3
     && ce.corps.element_image_list.refer_images[0].image_url === 'https://site.example/img/site/swoge_face_ref.jpg',
     'creer : POST /v1/general/advanced-custom-elements, frontal = le meme, refer_images = visage + vue de face + trois quarts');
  elementFini = true;
  const e2 = await appel('/studio/kling/swoge', moi.H);
  ok(e2.j.element && e2.j.element.statut === 'pret' && e2.j.element.elementId === '829' && e2.j.enService === '829', 'le suivi : element 829 pret, en service');

  console.log('\n-- 3. l edition d un clip avec l element, puis sans --');
  const texte = 'Replace the only person in @video_1 with the exact SWOGE character of @image_1 (full body) and @image_2 (face): the Swole Doge. The face is the round friendly Doge face of @image_2. Keep the camera.';
  const ed = await appel('/studio/kling/edition', moi.H, { video, prompt: texte });
  const b1 = envoisVideo().pop();
  ok(ed.statut === 200 && ed.j.reference === 'element' && b1 && JSON.stringify(b1.contents[1]) === JSON.stringify({ type: 'element', element_id: '829', id: 'element_1' })
     && !b1.contents.some((x) => x.type === 'refer_image') && b1.contents[0].text === 'Replace the only person in @video_1 with the exact SWOGE character of @element_1: the Swole Doge. The face is the round friendly Doge face. Keep the camera.',
     'Kling recoit l element 829 (id element_1) sans refer_image, le texte en @element_1');
  /* une edition a la fois : Kling finit la premiere, le suivi la conclut */
  videoFinie = true;
  ok((await appel('/studio/kling/' + ed.j.id, moi.H)).j.statut === 'succeeded', 'la premiere edition finie (le clip est efface)');
  videoFinie = false;
  const sup = await appel('/studio/kling/swoge/supprime', moi.H, {});
  const de = recus.filter((x) => /delete-advanced-elements$/.test(x.url)).pop();
  ok(sup.statut === 200 && de && JSON.stringify(de.corps) === JSON.stringify({ element_id: '829' }) && sup.j.etat.enService === null, 'effacer : { element_id: "829" } chez Kling, plus rien en service');

  console.log('\n-- 4. la premiere image --');
  const pr = await appel('/studio/kling/premiere', moi.H, { video, cible: 'gauche' });
  const ci2 = recus.filter((x) => /omni-image$/.test(x.url)).pop();
  ok(pr.statut === 200 && pr.j.premiere.cotes === '720x1280' && ci2.corps.n === 2 && ci2.corps.image_list.length === 3 && /replace ONLY the person on the LEFT side of the frame/.test(ci2.corps.prompt),
     'Prepare first frame : l image 0 du clip (ffmpeg) + le meme + le visage, 2 candidats, la personne de gauche seulement');
  const pid = pr.j.premiere.id;
  ok((await appel('/studio/kling/premiere/' + pid, autre.H)).statut === 403, 'une autre adresse : 403');
  const pe = await appel('/studio/kling/premiere/' + pid, moi.H);
  ok(pe.j.premiere && pe.j.premiere.candidats.length === 2, 'le suivi : 2 candidats');
  const cand = await appel(pe.j.premiere.candidats[0].image, moi.H);
  ok(cand.statut === 200 && cand.type === 'image/png', 'un candidat, avec la session');
  ok((await appel('/studio/kling/premiere/' + pid + '/choisit', moi.H, { k: 0 })).statut === 200, 'choisir le premier');
  const ed2 = await appel('/studio/kling/edition', moi.H, { video, prompt: 'Replace ONLY the person on the LEFT side of the frame in @video_1 with @image_1 and @image_2.', premiere: pid });
  const b2 = envoisVideo().pop();
  const ris = b2 ? b2.contents.filter((x) => x.type === 'refer_image') : [];
  ok(ed2.statut === 200 && ris.length === 3 && ris[0].url === 'https://site.example/img/site/swoge_meme_ref.jpg' && ris[2].id === 'image_3'
     && Buffer.from(ris[2].url, 'base64').equals(png(832, 1248)) && /The first frame of the result must look exactly like @image_3/.test(b2.contents[0].text) && !b2.contents.some((x) => x.type === 'element'),
     'edition + premiere image (sans element) : le meme, le visage, puis l image choisie en @image_3 avec sa phrase [' + ed2.statut + ' ' + (ed2.j.raison || '') + ']');
  ok((await appel('/studio/kling/edition', moi.H, { video, prompt: 'x', premiere: 'f'.repeat(24) })).statut === 404, 'une premiere image inconnue : 404, rien chez Kling');
  const avantE = recus.length;
  const pe404 = await appel('/studio/kling/premiere', moi.H, { entier: 'a'.repeat(24), cible: 'seule' });
  ok(pe404.statut === 404 && /plan the whole video first/.test(pe404.j.raison) && recus.length === avantE, 'video entiere sans plan pret : 404, rien chez Kling');
  const pClip = await appel('/studio/kling/entier/' + 'b'.repeat(24) + '/lance', moi.H, { prompt: 'x', confirmeUsd: 1, premiere: pid });
  ok(pClip.statut === 400 && /another video/.test(pClip.j.raison), 'une premiere image faite pour un clip, envoyee avec une video entiere : 400');

  console.log('\n-- 5. la cle --');
  ok(!textes.some((t) => /cle-kling-secrete/.test(t)), 'la cle Kling n apparait dans aucune reponse');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('ESSAI CASSE : ' + (e && e.stack || e)); process.exit(1); });
