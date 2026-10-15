'use strict';
/* ============================================================================
 * SWOGE SWAP (/studio/swap), SUR UN VRAI SERVEUR
 *
 * Ce qu'elle DOIT tenir :
 *   1. GET /studio/swap sans session : les personnages, les cibles, les bornes,
 *      le prix par seconde — aucun cout maison ; POST sans session : 401 ; sans
 *      la case (x-swap-rights) : 400 AVANT de lire le corps, rien ecrit ; plus
 *      de 60 Mo annonces : 413.
 *   2. Un joueur QUELCONQUE (pas AI_OWNER) televerse et recoit son plan et son
 *      prix (pire cas × 2) avant de payer ; l'etat est 404 pour un autre.
 *   3. Une image qui n'est pas passee par la porte (une URL) ou un texte de plus
 *      de 600 signes : 400, rien chez Kling ; credit trop bas :
 *      402, rien debite ; le bon prix : reserve sur le credit (GET /credit le
 *      montre), Kling recoit les morceaux par leur URL publique, le corps et le
 *      visage de SWOGE, le texte de la maison, 720p, son d'origine.
 *   4. Une passe par adresse (429) ; SWAP_PARALLELE=1 : le suivant en file ;
 *      SWAP_PLAFOND_JOUR_USD atteint : 429, rien debite.
 *   5. Le resultat ne sort qu'avec la session qui l'a lance (401 sans, 404 pour
 *      un autre) ; le reglement rend le credit juste ; la file avance.
 *   6. La route du proprietaire reste fermee aux autres (403) ; le journal garde
 *      plan, reserve, morceaux et reglement ; la cle Kling ne sort jamais.
 *   7. POST /studio/swap/image (15/10) : sans session 401 ; plus de 6 Mo annonces
 *      413 avant de lire ; un GIF 400 sans appel ; une personne reelle 422 avec la
 *      phrase exacte ; un dessin 200 (son sha256) ; le journal garde le verdict ;
 *      la cle Anthropic ne sort jamais.
 * Kling et son CDN sont simules en remplacant `fetch` pour leurs seuls
 * domaines : aucun appel reel. ffmpeg est le vrai.
 * ==========================================================================*/
const net = require('net');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

process.env.DATA_DIR = fs.mkdtempSync('/tmp/swap-route-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0';
process.env.KLING_API_KEY = 'cle-kling-secrete';
process.env.ANTHROPIC_API_KEY = 'cle-anthropic-secrete';
process.env.KLING_TG = '0';
process.env.SITE_URL = 'https://site.example';
process.env.SWAP_PARALLELE = '1';
process.env.SWAP_PLAFOND_JOUR_USD = '4';
delete process.env.SWAP_MARGE; delete process.env.SWAP_MO_MAX; delete process.env.SWAP_DUREE_MAX_S;
const OWNER = ethers.Wallet.createRandom();
process.env.AI_OWNER = OWNER.address;
/* quatre joueurs, aucun proprietaire ; le credit pose sur le disque avant le demarrage */
const J1 = ethers.Wallet.createRandom(), J2 = ethers.Wallet.createRandom(), J3 = ethers.Wallet.createRandom(), J4 = ethers.Wallet.createRandom();
fs.writeFileSync(path.join(process.env.DATA_DIR, 'credits.json'), JSON.stringify({ soldes: {
  [J1.address.toLowerCase()]: 10e6, [J2.address.toLowerCase()]: 10e6, [J3.address.toLowerCase()]: 1e6, [J4.address.toLowerCase()]: 10e6 }, ouvertes: {}, tx: {}, seq: 0 }));

let ffmpegOk = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { ffmpegOk = false; }
const VIDEO = path.join(process.env.DATA_DIR, 'source.mp4');
if (ffmpegOk) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '14', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-t', '14', '-i', 'sine=frequency=330',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', VIDEO]);
}

/* Kling simule : il LIT le morceau a l'URL donnee, et le rend tel quel par « son CDN ». */
const recus = [], taches = {};
let luParKling = [];
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
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
    return rep({ code: 0, data: t ? [t.statut === 'succeeded'
      ? { id: m[1], status: 'succeeded', outputs: [{ type: 'video', url: 'https://p2-kling.klingai.com/r/' + m[1] + '.mp4', duration: String(t.duree) }], billing: [{ charge_type: 'unit', amount: '6.3', package_type: 'video' }] }
      : { id: m[1], status: t.statut }] : [] });
  }
  if (/external_task_ids/.test(url)) return rep({ code: 0, data: [] });
  const b = JSON.parse(o.body);
  const v = b.contents.find((c) => c.type === 'base_video');
  const r = await vraiFetch(v.url);
  const octets = Buffer.from(await r.arrayBuffer());
  luParKling.push({ statut: r.status, octets, url: v.url });
  const id = 'E' + (Object.keys(taches).length + 1);
  taches[id] = { octets, duree: 7, statut: 'processing' };
  return rep({ code: 0, data: { id, status: 'submitted' } });
};
/* Claude simule : seul le classifieur de la porte recoit un verdict ; tout autre appel est en panne */
const classifieur = { appels: 0, verdict: { real_person: false, kind: 'cartoon', confidence: 0.9 } };
const vraiFetch2 = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  if (!String(u).startsWith('https://api.anthropic.com/')) return vraiFetch2(u, o);
  let b = {}; try { b = JSON.parse(o.body); } catch (e) { b = {}; }
  if (!(b.tools || []).some((t) => t.name === 'classify_image')) return new Response('{"type":"error"}', { status: 500 });
  classifieur.appels++;
  return new Response(JSON.stringify({ stop_reason: 'tool_use', usage: { input_tokens: 1500, output_tokens: 60 }, content: [{ type: 'tool_use', id: 'x', name: 'classify_image', input: classifieur.verdict }] }), { status: 200 });
};
const finit = () => { for (const t of Object.values(taches)) if (t.statut === 'processing') t.statut = 'succeeded'; };

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

/* une requete dont le corps n'est JAMAIS envoye en entier : la reponse doit venir avant */
const suspendue = (port, chemin, entetes, octets) => new Promise((res) => {
  const q = http.request({ host: '127.0.0.1', port, path: chemin, method: 'POST', headers: entetes }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { res({ statut: r.statusCode, corps: b }); q.destroy(); });
  });
  q.on('error', () => res({ statut: 0 }));
  q.write(octets.slice(0, 4096));
});

(async () => {
  if (!ffmpegOk) { console.log('ffmpeg absent : essai ignore'); return; }
  const port = await libre();
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;   /* Kling simule lit les morceaux ici */
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
    return { statut: r.status, j, t, h: r.headers };
  };
  const journal = () => { try { return fs.readFileSync(path.join(process.env.DATA_DIR, 'swap_journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch (e) { return []; } };
  const DOSSIER = path.join(process.env.DATA_DIR, 'swap');
  const passes = () => { try { return fs.readdirSync(DOSSIER).filter((x) => /^[0-9a-f]{24}$/.test(x)); } catch (e) { return []; } };
  const octets = fs.readFileSync(VIDEO);
  const envoisKling = () => recus.filter((x) => /omni-video/.test(x.url));
  const attendStatut = async (id, H, statuts) => { let e = null; for (let k = 0; k < 300; k++) { e = await appel('/studio/swap/' + id, H); if (statuts.includes(e.j.statut)) break; await new Promise((r) => setTimeout(r, 100)); } return e; };
  const credit = async (H) => (await appel('/credit', H)).j.balanceUsd;

  console.log('-- 1. sans session, sans la case, trop gros --');
  const g = await appel('/studio/swap');
  ok(g.statut === 200 && g.j.personnages.length === 1 && g.j.personnages[0].id === 'swoge' && g.j.cibles.map((c) => c.id).join() === 'gauche,centre,droite,seule' && g.j.cibleRequise === true
     && g.j.prixParSecondeUsd === 0.252 && g.j.octetsMax === 60 * 1048576 && g.j.dureeMaxS === 60 && g.j.resolution === '720p' && g.j.passe === null && g.j.connecte === false && g.j.actif === true,
     'GET sans session : SWOGE, 4 cibles par position (requises), 0,252 $/s, 60 Mo, 60 s, 720p');
  ok(!/0\.126|plafondUsd|prixPire/.test(g.t) && !/AI_OWNER|owner/i.test(g.t), 'aucun cout maison ni plafond dans la reponse publique');
  ok((await appel('/studio/swap', { 'content-type': 'video/mp4', 'x-swap-rights': 'yes' }, null, 'POST', octets)).statut === 401, 'POST sans session : 401');
  const j1 = await connecte(port, J1), j2 = await connecte(port, J2), j3 = await connecte(port, J3), j4 = await connecte(port, J4), moi = await connecte(port, OWNER);
  const HV = (H) => ({ 'content-type': 'video/mp4', authorization: H.authorization, 'x-swap-rights': 'yes' });
  const sansCase = await suspendue(port, '/studio/swap', { 'content-type': 'video/mp4', authorization: j1.H.authorization, 'content-length': String(octets.length) }, octets);
  ok(sansCase.statut === 400 && /tick the box/.test(sansCase.corps) && passes().length === 0, 'sans x-swap-rights : 400 avant de lire le corps, rien ecrit [' + sansCase.corps.slice(0, 90) + ']');
  const trop = await suspendue(port, '/studio/swap', Object.assign(HV(j1.H), { 'content-length': String(61 * 1048576) }), octets);
  ok(trop.statut === 413 && /60 MB max/.test(trop.corps) && passes().length === 0, 'plus de 60 Mo annonces : 413');

  console.log('\n-- 2. un joueur quelconque, son plan, son prix --');
  ok((await appel('/studio/kling/entier', HV(j1.H), null, 'POST', octets)).statut === 403, 'la route du proprietaire reste fermee au joueur (403)');
  const c1 = await appel('/studio/swap', HV(j1.H), null, 'POST', octets);
  ok(c1.statut === 200 && /^[0-9a-f]{24}$/.test(c1.j.id) && c1.j.statut === 'decoupe', 'le joueur (pas AI_OWNER) televerse : decoupage en fond');
  const id1 = c1.j.id;
  let e = await attendStatut(id1, j1.H, ['pret', 'erreur']);
  ok(e.j.statut === 'pret' && e.j.morceaux.length === 2 && e.j.prixUsd === 3.53 && e.j.prixPire === null && e.j.droits === true, 'plan : 2 morceaux, 3,53 $ montres avant de payer, la case gardee');
  ok((await appel('/studio/swap/' + id1, j2.H)).statut === 404, 'l etat : 404 pour un autre joueur');
  ok((await appel('/studio/swap', j1.H)).j.passe === id1, 'GET avec session : la passe en cours du joueur');

  console.log('\n-- 3. seulement nos personnages ; le credit --');
  const L = (id, H, q) => appel('/studio/swap/' + id + '/lance', H, Object.assign({ personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 }, q || {}));
  const ri = await L(id1, j1.H, { images: ['https://evil.example/x.jpg'] });
  const rp = await L(id1, j1.H, { prompt: 'x'.repeat(601) });
  ok(ri.statut === 400 && rp.statut === 400 && /not accepted/.test(ri.j.raison) && /600 at most/.test(rp.j.raison) && envoisKling().length === 0, 'une image non verifiee (URL) ou un texte de 601 signes : 400, rien chez Kling');
  ok((await L(id1, j1.H, { confirmeUsd: 1.764 })).statut === 409 && (await L(id1, j2.H)).statut === 404, 'le prix Kling au lieu du prix montre : 409 ; un autre joueur : 404');
  const c3 = await appel('/studio/swap', HV(j3.H), null, 'POST', octets);
  await attendStatut(c3.j.id, j3.H, ['pret']);
  const l3 = await L(c3.j.id, j3.H);
  ok(l3.statut === 402 && /\$3\.53 needed, you have \$1\.00/.test(l3.j.raison) && await credit(j3.H) === 1 && envoisKling().length === 0, 'credit de 1 $ : 402, rien debite, rien chez Kling');
  const l1 = await L(id1, j1.H);
  ok(l1.statut === 200 && l1.j.statut === 'en_cours' && await credit(j1.H) === 6.47, 'le bon prix : en cours, 3,53 $ reserves (credit 6,47 $)');
  const envois = envoisKling().map((x) => JSON.parse(x.o.body));
  ok(envois.length === 2 && envois.every((b) => /^Replace the only person in @video_1 with the exact SWOGE character of @image_1 \(full body\) and @image_2 \(face\)/.test(b.contents[0].text)
     && b.contents[1].url === 'https://site.example/img/site/swoge_meme_ref.jpg' && b.contents[1].id === 'image_1' && b.contents[2].url === 'https://site.example/img/site/swoge_face_ref.jpg'
     && b.contents[2].id === 'image_2' && b.contents[3].id === 'video_1' && b.settings.audio === 'original' && b.settings.resolution === '720p'),
     'Kling recoit le texte de la maison (l ancien id « chante » = la seule personne), le corps (le meme) et le visage de SWOGE par URL, 720p, son d origine');
  ok(luParKling.length === 2 && luParKling.every((x) => x.statut === 200 && new RegExp('^' + B.replace(/\./g, '\\.') + '/studio/swap-clip/[0-9a-f]{48}\\.mp4$').test(x.url)),
     'Kling lit chaque morceau a son URL publique /studio/swap-clip/, sans session');

  console.log('\n-- 4. une par adresse, la file, le plafond du jour --');
  ok((await appel('/studio/swap', HV(j1.H), null, 'POST', octets)).statut === 429, 'une seconde video du meme joueur : 429');
  const c2 = await appel('/studio/swap', HV(j2.H), null, 'POST', octets);
  await attendStatut(c2.j.id, j2.H, ['pret']);
  const l2 = await L(c2.j.id, j2.H, { cible: 'tous' });
  ok(l2.statut === 200 && l2.j.statut === 'file' && l2.j.file === 1 && envoisKling().length === 2 && await credit(j2.H) === 6.47, 'SWAP_PARALLELE=1 : le second en file (rang 1), deja reserve, rien chez Kling');
  const c4 = await appel('/studio/swap', HV(j4.H), null, 'POST', octets);
  await attendStatut(c4.j.id, j4.H, ['pret']);
  const l4 = await L(c4.j.id, j4.H);
  ok(l4.statut === 429 && /limit for today/.test(l4.j.raison) && await credit(j4.H) === 10, 'plafond du jour 4 $ (1,764 × 2 engages) : le troisieme refuse, rien debite');

  console.log('\n-- 5. le resultat, le reglement, la file qui avance --');
  finit();
  e = await attendStatut(id1, j1.H, ['fini', 'incomplet', 'erreur']);
  ok(e.j.statut === 'fini' && e.j.video === '/studio/swap/' + id1 + '/video' && e.j.paiement.factureUsd === 3.53 && await credit(j1.H) === 6.47, 'fini : 3,53 $ factures, la video annoncee');
  ok((await appel(e.j.video, {})).statut === 401 && (await appel(e.j.video, j2.H)).statut === 404, 'le resultat : 401 sans session, 404 pour un autre joueur');
  const r = await vraiFetch(B + e.j.video, { headers: { authorization: j1.H.authorization } });
  const fin = Buffer.from(await r.arrayBuffer());
  const f = path.join(process.env.DATA_DIR, 'fin.mp4'); fs.writeFileSync(f, fin);
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
  ok(r.status === 200 && r.headers.get('content-type') === 'video/mp4' && /no-store/.test(r.headers.get('cache-control')) && /swoge_swap_/.test(r.headers.get('content-disposition')) && Math.abs(d - 14) <= 0.15,
     'le joueur recoit SA video : ' + d + ' s pour 14 s');
  ok((await vraiFetch(luParKling[0].url)).status === 404, 'les morceaux ne sont plus servis');
  let e2 = null;
  for (let k = 0; k < 100; k++) { e2 = await appel('/studio/swap/' + c2.j.id, j2.H); if (e2.j.statut === 'en_cours') break; await new Promise((q) => setTimeout(q, 100)); }
  ok(e2.j.statut === 'en_cours' && envoisKling().length === 4 && JSON.parse(envoisKling()[3].o.body).contents[0].text.startsWith('Replace every person in @video_1'), 'la place libre : le second sort de la file et part chez Kling');
  const ab = await appel('/studio/swap/' + c2.j.id + '/abandonne', j2.H, {});
  ok(ab.statut === 409 && /cannot be cancelled/.test(ab.j.raison), 'une video deja chez Kling ne s annule pas (409)');

  console.log('\n-- 6. le journal, la cle --');
  const jl = journal().filter((x) => x.entier === id1);
  ok(jl.every((x) => x.swap) && jl.some((x) => x.plan && x.droits) && jl.some((x) => x.paiement === 'reserve' && x.prixUsd === 3.53) && jl.filter((x) => x.edition && x.estimationUsd === 0.882).length === 2
     && jl.some((x) => x.paiement === 'regle' && x.factureUsd === 3.53 && x.renduUsd === 0) && jl.some((x) => x.statut === 'fini'),
     'swap_journal.jsonl : plan (case), reserve, 2 envois (0,882 $), reglement, fin');
  ok(journal().some((x) => x.refus === 'credit') && journal().some((x) => x.refus === 'plafond-jour'), 'journal : le refus de credit et celui du plafond');
  let essais = []; try { essais = fs.readFileSync(path.join(process.env.DATA_DIR, 'kling_essais.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch (x) { essais = []; }
  ok(!essais.some((l) => /"swap":true/.test(l)), 'le journal du proprietaire ne recoit pas les passes des joueurs');
  ok(textes.every((t) => !t.includes('cle-kling-secrete')), 'la cle Kling n apparait dans aucune reponse');

  console.log('\n-- 7. la porte des images --');
  const png = path.join(process.env.DATA_DIR, 'perso.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=512x512', '-frames:v', '1', png]);
  const img = fs.readFileSync(png);
  const HI = (H) => ({ 'content-type': 'image/png', authorization: H.authorization });
  ok((await appel('/studio/swap/image', { 'content-type': 'image/png' }, null, 'POST', img)).statut === 401, 'sans session : 401');
  const gros = await suspendue(port, '/studio/swap/image', Object.assign(HI(j4.H), { 'content-length': String(7 * 1048576) }), img);
  ok(gros.statut === 413 && /6 MB max/.test(gros.corps) && classifieur.appels === 0, 'plus de 6 Mo annonces : 413 avant de lire');
  const gif = await appel('/studio/swap/image', HI(j4.H), null, 'POST', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]));
  ok(gif.statut === 400 && classifieur.appels === 0, 'un GIF : 400, aucun appel au classifieur');
  classifieur.verdict = { real_person: true, kind: 'photo_of_real_human', confidence: 0.98 };
  const reel = await appel('/studio/swap/image', HI(j4.H), null, 'POST', img);
  ok(reel.statut === 422 && reel.j.raison === "This looks like a photo of a real person. SWOGE Swap only puts characters in videos — mascots, NFTs, pets, drawings, 3D or game characters — never a real person's face." && classifieur.appels === 1,
     'une personne reelle : 422, la phrase exacte');
  const png2 = path.join(process.env.DATA_DIR, 'perso2.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'rgbtestsrc=size=520x520', '-frames:v', '1', png2]);
  classifieur.verdict = { real_person: false, kind: 'cartoon', confidence: 0.95 };
  const bon = await appel('/studio/swap/image', HI(j4.H), null, 'POST', fs.readFileSync(png2));
  ok(bon.statut === 200 && bon.j.accepte === true && /^[0-9a-f]{64}$/.test(bon.j.id) && classifieur.appels === 2, 'un dessin : 200, son sha256');
  ok(journal().some((x) => x.garde && x.verdict === 'refuse' && x.kind === 'photo_of_real_human' && /^[0-9a-f]{64}$/.test(x.sha256)) && journal().some((x) => x.garde && x.verdict === 'accepte' && x.coutUsd > 0),
     'swap_journal.jsonl : les deux verdicts (genre, sha256, cout)');
  ok(textes.every((t) => !t.includes('cle-anthropic-secrete')), 'la cle Anthropic n apparait dans aucune reponse');

  [j1, j2, j3, j4, moi].forEach((x) => x.s.close());
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
