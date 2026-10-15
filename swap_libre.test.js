'use strict';
/* ============================================================================
 * SWOGE SWAP OUVERT (15/10/2026) : N'IMPORTE QUEL PERSONNAGE, JAMAIS UNE
 * PERSONNE REELLE ; UN TEXTE LIBRE CITE ; LE 1080p ; LA MARQUE.
 *
 * Ce qui DOIT tenir :
 *   1. La porte (swap_garde.js) : un dessin anime est accepte ; real_person:true,
 *      un genre humain realiste ou une confiance basse sont refuses avec la
 *      phrase exacte ; une panne du classifieur (HTTP, delai, JSON illisible,
 *      reponse hors schema, pas de cle) REFUSE (fermee par defaut) et n'est pas
 *      mise en cache ; la meme image n'est examinee qu'une fois (cache par
 *      sha256) ; la limite par adresse et par jour ; un format ou des cotes que
 *      Kling refuserait sont refuses AVANT l'appel paye ; le journal garde le
 *      verdict, le genre, la confiance, le sha256 et le cout — jamais l'image.
 *   2. Une image refusee ne mene ni a une reserve de credit ni a Kling.
 *   3. Une image acceptee remplace le personnage maison ; le texte du joueur est
 *      cite dans le gabarit, ses jetons @video_ / @image_ retires ; > 600 signes
 *      refuse.
 *   4. Le 1080p : le prix montre (pire cas 1080p × marge) est celui confirme et
 *      reserve, Kling recoit 1080p.
 *   5. La marque : la video publique porte « Made with SWOGE AI » en bas a
 *      droite (vrai ffmpeg : la region differe de la source, le reste non) ; le
 *      chemin du proprietaire n'a pas de marque.
 * Claude et Kling sont simules (aucun appel reel) ; ffmpeg est le vrai, le
 * credit est le vrai module credits.js sur un dossier jetable.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const SW = require('./swap');
const SG = require('./swap_garde');
const KE = require('./kling_entier');
const K = require('./kling');
const Credits = require('./credits');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const proche = (a, b, e) => Math.abs(a - b) <= e;
const ffmpegOk = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

/* ---- le faux Claude : il rend ce qu'on lui dit, et garde chaque requete ---- */
function fauxClaude() {
  const C = { appels: [], reponse: null };
  C.verdict = (real_person, kind, confidence) => { C.reponse = { mode: 'ok', j: { stop_reason: 'tool_use', usage: { input_tokens: 1210, output_tokens: 61 },
    content: [{ type: 'tool_use', id: 'tu_1', name: 'classify_image', input: { real_person, kind, confidence } }] } }; };
  C.fetch = async (url, o) => {
    C.appels.push({ url, o, corps: JSON.parse(o.body) });
    const r = C.reponse || { mode: 'ok', j: {} };
    if (r.mode === 'http') return { ok: false, status: r.status, json: async () => ({}), text: async () => '{"type":"error","error":{"type":"api_error","message":"boom"}}' };
    /* une requete qui ne repond jamais ; le minuteur tient le processus en vie comme le ferait une socket
       (celui d'AbortSignal.timeout ne le fait pas) */
    if (r.mode === 'pend') return new Promise((res, rej) => { const vie = setTimeout(() => {}, 60000); o.signal.addEventListener('abort', () => { clearTimeout(vie); rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); }); });
    if (r.mode === 'illisible') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }, text: async () => '<html>' };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(r.j)), text: async () => JSON.stringify(r.j) };
  };
  return C;
}

/* Kling simule (celui de swap.test.js) : il lit le morceau a son URL publique et le rend tel quel. */
function fauxKling(M) {
  const F = { envois: [], taches: {}, externes: {} };
  F.kling = {
    actif: () => true,
    lanceEdition: async (q) => {
      const nom = q.videoUrl.split('/').pop();
      const f = M().fichier(nom);
      F.envois.push(Object.assign({}, q, { lu: !!f }));
      const id = 'T' + F.envois.length;
      F.taches[id] = { statut: 'processing', octets: f ? f.octets : null, nom, dureeS: q.dureeS };
      if (q.externe) F.externes[q.externe] = id;
      return { ok: true, id, externe: q.externe, modele: 'kling-o1', resolution: q.resolution, audio: q.audio, dureeS: q.dureeS, estimationUsd: K.prixEdition(q.resolution, q.dureeS), images: q.images.map(() => 'x') };
    },
    etat: async (id) => {
      const t = F.taches[id]; if (!t) return { ok: false, code: 404 };
      if (t.statut === 'succeeded') return { ok: true, id, statut: 'succeeded', url: 'https://p2-kling.klingai.com/r/' + id + '.mp4', duree: t.dureeS, facturation: null };
      return { ok: true, id, statut: 'processing' };
    },
    etatExterne: async (x) => (F.externes[x] ? F.kling.etat(F.externes[x]) : { ok: false, code: 404 }),
  };
  F.fetchCdn = async (u) => {
    const id = /\/r\/(T\d+)\.mp4$/.exec(u); const t = id && F.taches[id[1]];
    if (!t || !t.octets) return { status: 404, ok: false, headers: { get: () => null } };
    return { status: 200, ok: true, headers: { get: (h) => (h === 'content-length' ? String(t.octets.length) : null) }, arrayBuffer: async () => t.octets };
  };
  F.finit = () => { for (const t of Object.values(F.taches)) if (t.statut === 'processing') t.statut = 'succeeded'; };
  return F;
}

const image = (f, src, taille, args) => { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src + '=size=' + taille, '-frames:v', '1'].concat(args || []).concat([f])); return fs.readFileSync(f); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Moyenne des ecarts absolus (gris) entre deux images d'une region (x, y, l, h) a l'instant t. */
function region(fichier, t, x, y, l, h) {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', fichier, '-frames:v', '1', '-vf', 'crop=' + l + ':' + h + ':' + x + ':' + y + ',format=gray', '-f', 'rawvideo', '-']);
}
const ecart = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

(async () => {
  console.log('-- 0. le gabarit et le texte du joueur (calcul) --');
  {
    const p0 = SW.prompt(SW.PERSONNAGES[0], SW.CIBLES[0]);
    ok(SW.prompt(SW.PERSONNAGES[0], SW.CIBLES[0], { images: 0, texte: '' }) === p0, 'sans image ni texte : le texte d avant, mot pour mot');
    const t = SW.texteJoueur('  He waves with @video_9 a gold chain, use @image_7 and @ image 2 and @Element_3. Say "hi" ');
    ok(t.ok && t.texte === "He waves with a gold chain, use and and . Say 'hi'" && !/@/.test(t.texte), 'les jetons @video_9, @image_7, @ image 2, @Element_3 retires, guillemets remplaces [' + t.texte + ']');
    const p = SW.prompt(null, require('./swoge_texte').cible('gauche'), { images: 1, texte: t.texte });
    ok(/^Replace ONLY the person on the LEFT side of the frame in @video_1 with the character shown in @image_1, keeping its exact look/.test(p) && !/@image_2|@video_9|@image_7/.test(p)
       && /Creative direction from the user, quoted .*: "He waves with a gold chain, use and and \. Say 'hi'"\./.test(p) && /in @video_1 with .*\. The other people stay exactly as they are\. Creative direction/.test(p) && /Keep the camera and the original audio unchanged/.test(p)
       && (p.match(/"/g) || []).length === 2, 'une image + un texte : le texte CITE (deux guillemets seulement), la cible et « garder » ecrits par la maison');
    ok(/@image_1 and @image_2 \(two views of the same character\)/.test(SW.prompt(null, SW.CIBLES[3], { images: 2 })) && /never the face of a real person/.test(SW.prompt(null, SW.CIBLES[3], { images: 2 })), 'deux images : @image_1 et @image_2, « jamais le visage d une personne reelle »');
    const long = SW.texteJoueur('é'.repeat(600));
    ok(long.ok && SW.texteJoueur('x'.repeat(601)).ok === false && /601 characters — 600 at most/.test(SW.texteJoueur('x'.repeat(601)).raison) && SW.texteJoueur(42).ok === false,
       '600 signes (toute langue) passent, 601 non ; un texte qui n est pas une chaine non plus');
    const pmax = SW.prompt(null, SW.CIBLES[0], { images: 2, texte: 'x'.repeat(600) });
    ok(pmax.length <= K.TEXTE_MAX, 'le pire gabarit (2 images, 600 signes) : ' + pmax.length + ' signes, sous les ' + K.TEXTE_MAX + ' de Kling');
    ok(SG.decide({ real_person: false, kind: 'cartoon', confidence: 0.9 }).accepte && !SG.decide({ real_person: true, kind: 'cartoon', confidence: 0.9 }).accepte
       && !SG.decide({ real_person: false, kind: 'photo_of_real_human', confidence: 0.9 }).accepte && !SG.decide({ real_person: false, kind: 'realistic_render_of_real_human', confidence: 0.99 }).accepte
       && !SG.decide({ real_person: false, kind: 'nft_art', confidence: SG.SEUIL_CONFIANCE - 0.01 }).accepte, 'la decision : seul un non-humain realiste, dit avec assurance, passe');
  }

  if (!ffmpegOk) { console.log('ffmpeg absent : la suite reelle est sautee'); console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe')); process.exit(rates ? 1 : 0); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-libre-'));
  const I = {
    dessin: image(path.join(tmp, 'dessin.png'), 'testsrc2', '512x512'),
    dessin2: image(path.join(tmp, 'dessin2.jpg'), 'rgbtestsrc', '640x480', ['-q:v', '3']),
    photo: image(path.join(tmp, 'photo.jpg'), 'mandelbrot', '600x800', ['-q:v', '3']),
    webp: image(path.join(tmp, 'perso.webp'), 'smptehdbars', '640x640'),
    petite: image(path.join(tmp, 'petite.png'), 'testsrc', '200x200'),
  };
  const autres = Array.from({ length: 6 }, (_, k) => image(path.join(tmp, 'a' + k + '.png'), 'testsrc2', (400 + k * 2) + 'x400'));
  let t = Date.parse('2026-10-15T10:00:00Z');
  const lignes = [];
  const A = '0xjoueur_a', B = '0xjoueur_b';

  console.log('\n-- 1. la porte --');
  const dG = fs.mkdtempSync(path.join(tmp, 'g-'));
  const C = fauxClaude();
  const G = SG.cree({ dossier: dG, journal: (x) => lignes.push(x), fetch: C.fetch, cle: () => 'cle-anthropic-secrete', maintenant: () => t, env: { SWAP_GARDE_HEURE: '4', SWAP_GARDE_JOUR: '9' }, delaiMs: 300 });
  {
    C.verdict(false, 'cartoon', 0.96);
    const r = await G.verifie(A, I.dessin);
    const q = C.appels[0] || {}, b = q.corps || {};
    ok(r.ok && r.accepte && r.id === sha(I.dessin) && r.kind === 'cartoon' && r.cache === false, 'un dessin anime : accepte, identifie par son sha256');
    const im = b.messages && b.messages[0].content[0];
    ok(q.url === 'https://api.anthropic.com/v1/messages' && q.o.headers['x-api-key'] === 'cle-anthropic-secrete' && q.o.headers['anthropic-version'] === '2023-06-01'
       && b.model === 'claude-haiku-4-5' && b.tool_choice.type === 'tool' && b.tool_choice.name === 'classify_image' && b.tools[0].input_schema.required.join() === 'real_person,kind,confidence'
       && im.type === 'image' && im.source.type === 'base64' && im.source.media_type === 'image/jpeg' && im.source.data.length > 1000 && b.system === SG.SYSTEME,
       'l appel : API Messages brute (x-api-key, anthropic-version 2023-06-01), le modele de agent_modele.js, un bloc image base64, l outil force');
    const k = G.image(r.id);
    ok(k && k.format === 'png' && Buffer.from(k.base64, 'base64').equals(I.dessin), 'l image acceptee est gardee pour Kling, octet pour octet (PNG)');
    const l = lignes.filter((x) => x.garde && x.sha256 === r.id).pop() || {};
    ok(l.swap && l.verdict === 'accepte' && l.kind === 'cartoon' && l.confidence === 0.96 && l.real_person === false && l.cache === false && l.coutUsd === (1210 * 1 + 61 * 5) / 1e6
       && l.jetons.entree === 1210 && l.addr === A, 'journal : verdict, genre, confiance, sha256, jetons et cout maison (' + l.coutUsd + ' $)');
    ok(!JSON.stringify(lignes).includes(im.source.data.slice(0, 200)) && !JSON.stringify(lignes).includes(I.dessin.toString('base64').slice(0, 200)) && !/cle-anthropic/.test(JSON.stringify(lignes)), 'le journal ne porte ni l image ni la cle');

    const n0 = C.appels.length;
    const r2 = await G.verifie(B, I.dessin);
    ok(r2.ok && r2.cache === true && C.appels.length === n0 && lignes.some((x) => x.garde && x.cache === true && x.sha256 === r.id && x.addr === B), 'la meme image (une autre adresse) : verdict du cache, aucun nouvel appel');

    C.verdict(true, 'photo_of_real_human', 0.97);
    const rp = await G.verifie(A, I.photo);
    ok(!rp.ok && rp.code === 422 && rp.raison === SG.MSG_REEL && rp.raison === 'This looks like a photo of a real person. SWOGE Swap only puts characters in videos — mascots, NFTs, pets, drawings, 3D or game characters — never a real person\'s face.'
       && G.image(rp.id) === null && !fs.readdirSync(path.join(dG, 'images')).some((x) => x.startsWith(rp.id)), 'real_person:true : refuse, la phrase exacte, l image n est pas gardee');
    const n1 = C.appels.length;
    ok((await G.verifie(A, I.photo)).code === 422 && C.appels.length === n1, 'la meme photo encore : refusee depuis le cache, sans appel');
  }
  {
    /* un genre humain realiste avec real_person:false, et une confiance basse : refuses aussi */
    const dH = fs.mkdtempSync(path.join(tmp, 'h-')), CH = fauxClaude();
    const GH = SG.cree({ dossier: dH, journal: (x) => lignes.push(x), fetch: CH.fetch, cle: () => 'k', maintenant: () => t });
    CH.verdict(false, 'realistic_render_of_real_human', 0.9);
    const a = await GH.verifie(A, autres[0]);
    CH.verdict(false, 'cartoon', 0.5);
    const b = await GH.verifie(A, autres[1]);
    ok(a.code === 422 && a.raison === SG.MSG_REEL && b.code === 422 && GH.image(a.id) === null && GH.image(b.id) === null, 'rendu realiste d un humain (real_person:false) et confiance 0,5 : refuses');
  }

  console.log('\n-- 1b. fermee par defaut --');
  {
    const dF = fs.mkdtempSync(path.join(tmp, 'f-')), CF = fauxClaude();
    const GF = SG.cree({ dossier: dF, journal: (x) => lignes.push(x), fetch: CF.fetch, cle: () => 'k', maintenant: () => t, delaiMs: 200 });
    const essais = [
      ['HTTP 500', () => { CF.reponse = { mode: 'http', status: 500 }; }],
      ['delai depasse', () => { CF.reponse = { mode: 'pend' }; }],
      ['JSON illisible', () => { CF.reponse = { mode: 'illisible' }; }],
      ['du texte au lieu de l outil', () => { CF.reponse = { mode: 'ok', j: { content: [{ type: 'text', text: '{"real_person": false, "kind": "cartoon", "confidence": 0.9}' }] } }; }],
      ['un genre hors liste', () => CF.verdict(false, 'meme', 0.9)],
      ['real_person en chaine', () => CF.verdict('false', 'cartoon', 0.9)],
      ['confidence hors 0..1', () => CF.verdict(false, 'cartoon', 7)],
      ['refus du modele', () => { CF.reponse = { mode: 'ok', j: { stop_reason: 'refusal', content: [] } }; }],
    ];
    const res = [];
    for (let i = 0; i < essais.length; i++) {
      essais[i][1]();
      const img = image(path.join(tmp, 'f' + i + '.png'), 'testsrc2', (420 + i * 2) + 'x420');
      const r = await GF.verifie('0xf' + i, img);
      res.push(r.code === 503 && r.raison === SG.MSG_ECHEC && r.raison === 'We could not check this image — try another.' && GF.image(r.id) === null);
    }
    ok(res.every(Boolean), essais.length + ' pannes (' + essais.map((e) => e[0]).join(', ') + ') : toutes refusees, « could not check this image, try another »' + (res.every(Boolean) ? '' : ' ' + JSON.stringify(res)));
    ok(lignes.filter((x) => x.garde && x.verdict === 'erreur').length >= essais.length, 'chaque panne est au journal (verdict erreur)');
    const img = image(path.join(tmp, 'f0b.png'), 'testsrc2', '420x420');
    CF.reponse = { mode: 'http', status: 529 };
    const r1 = await GF.verifie('0xz', img);
    CF.verdict(false, 'cartoon', 0.9);
    const r2 = await GF.verifie('0xz', img);
    ok(r1.code === 503 && r2.ok && r2.cache === false, 'une panne n est pas mise en cache : la meme image, reessayee, est examinee');
    const dN = fs.mkdtempSync(path.join(tmp, 'n-')), CN = fauxClaude();
    const GN = SG.cree({ dossier: dN, journal: () => {}, fetch: CN.fetch, cle: () => '', maintenant: () => t });
    ok((await GN.verifie(A, I.dessin)).code === 503 && CN.appels.length === 0 && GN.actif() === false, 'sans cle : refuse, aucun appel ; la porte se dit fermee');
  }

  console.log('\n-- 1c. avant tout appel paye : format, taille, cotes --');
  {
    const n0 = C.appels.length;
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]);
    ok((await G.verifie(A, gif)).code === 400 && /JPEG, PNG or WebP/.test((await G.verifie(A, gif)).raison), 'un GIF : 400');
    ok((await G.verifie(A, Buffer.concat([I.dessin, Buffer.alloc(6 * 1024 * 1024)]))).code === 413, 'plus de 6 Mo : 413');
    const p = await G.verifie(A, I.petite);
    ok(p.code === 400 && /300 px/.test(p.raison), '200×200 px (Kling exige 300) : 400 [' + p.raison + ']');
    ok((await G.verifie(null, I.dessin)).code === 401, 'sans session : 401');
    ok(C.appels.length === n0, 'aucun de ces refus n a appele le classifieur');
    C.verdict(false, '3d_character', 0.9);
    const w = await G.verifie(A, I.webp);
    const kw = G.image(w.id);
    ok(w.ok && kw && kw.format === 'jpeg' && K.referenceEdition(kw.base64).ok && w.id === sha(I.webp), 'un WebP : accepte, converti en JPEG pour Kling (qui ne prend pas le WebP), identifie par le sha de l original');
  }

  console.log('\n-- 1d. les limites --');
  {
    /* A a deja fait 3 appels (dessin, photo, webp) ; SWAP_GARDE_HEURE=4 */
    C.verdict(false, 'animal', 0.9);
    const r4 = await G.verifie(A, autres[2]);
    const n0 = C.appels.length;
    const r5 = await G.verifie(A, autres[3]);
    ok(r4.ok && r5.code === 429 && /too many image checks — try again in \d+ min \(4 per hour\)/.test(r5.raison) && C.appels.length === n0, '4 appels dans l heure : le 5e refuse (429) sans appel [' + r5.raison + ']');
    ok((await G.verifie(A, I.dessin)).ok, 'une image deja jugee passe toujours (le cache ne compte pas)');
    const rb = await G.verifie(B, autres[3]);
    ok(rb.ok, 'une autre adresse n est pas touchee');
    t += 3600e3 + 1000;
    ok((await G.verifie(A, autres[4])).ok, 'une heure plus tard : A peut de nouveau');
    /* le jour : 9 appels pour tout le service ; 6 faits ici (dessin, photo, webp, autres 2, 3 et 4), 3 de plus */
    await G.verifie(B, autres[5]); await G.verifie('0xc', image(path.join(tmp, 'j1.png'), 'testsrc2', '430x430')); await G.verifie('0xe', image(path.join(tmp, 'j3.png'), 'testsrc2', '434x434'));
    const n9 = C.appels.length;
    const rj = await G.verifie('0xd', image(path.join(tmp, 'j2.png'), 'testsrc2', '432x432'));
    ok(n9 === 9 && rj.code === 429 && /paused for today/.test(rj.raison) && C.appels.length === 9 && G.jour().appels === 9, 'SWAP_GARDE_JOUR=9 : le 10e appel du jour refuse, sans appel ; le compte est sur le disque');
    ok(proche(G.jour().usd, 9 * (1210 + 61 * 5) / 1e6, 1e-9), 'la depense maison du jour : ' + G.jour().usd + ' $ (9 appels)');
    const G2 = SG.cree({ dossier: dG, journal: () => {}, fetch: C.fetch, cle: () => 'k', maintenant: () => t, env: { SWAP_GARDE_JOUR: '9' } });
    ok(G2.image(sha(I.dessin)) !== null && G2.image(sha(I.photo)) === null && G2.jour().appels === 9, 'au redemarrage : les verdicts et le compte du jour sont relus du disque');
  }

  console.log('\n-- 2-5. avec le moteur : refus avant credit, image acceptee, texte, 1080p, marque --');
  const fabrique = (f, plans) => {
    const srcs = ['testsrc2', 'mandelbrot'];
    const args = ['-v', 'error', '-y'];
    plans.forEach((d, k) => args.push('-f', 'lavfi', '-t', String(d), '-i', srcs[k % srcs.length] + '=size=720x1280:rate=25'));
    const tot = plans.reduce((a, b) => a + b, 0);
    args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=' + tot);
    args.push('-filter_complex', plans.map((_, k) => '[' + k + ':v]').join('') + 'concat=n=' + plans.length + ':v=1:a=0[v]', '-map', '[v]', '-map', plans.length + ':a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f);
    execFileSync('ffmpeg', args);
    return f;
  };
  const V = fabrique(path.join(tmp, 'deux.mp4'), [7, 7]);
  const SITE = 'https://site.example';
  let ntx = 0;
  const credit = (dossier) => Credits.cree({ dossier, maintenant: () => t });
  const recharge = (Cr, a, usd) => Cr.ajoute(a, usd, { transaction: '0x' + String(++ntx).padStart(64, '0') });
  const attend = async (M, id, addr, statuts) => { for (let k = 0; k < 400; k++) { const e = M.etat(id, addr); if (statuts.includes(e.statut)) return e; await M.attend(id); await M.tour(); await new Promise((r) => setTimeout(r, 25)); } return M.etat(id, addr); };
  const d1 = fs.mkdtempSync(path.join(tmp, 'm-')), C1 = credit(d1), CL = fauxClaude();
  let M = null; const F = fauxKling(() => M);
  M = SW.cree({ dossier: d1, kling: F.kling, site: SITE, moi: 'https://srv.example', credits: C1, journal: (x) => lignes.push(x), fetchCdn: F.fetchCdn, maintenant: () => t, pollMs: 1e9,
    env: {}, fetchAnthropic: CL.fetch, cleAnthropic: () => 'k' });
  recharge(C1, A, 20); recharge(C1, B, 20);
  {
    const v = M.vue(A);
    ok(v.resolutions.join() === '720p,1080p' && v.resolution === '720p' && v.prixParSecondeUsd === 0.252 && v.prixParSecondeUsdParResolution['1080p'] === 0.336
       && v.texteMax === 600 && v.imagesMax === 2 && v.imageOctetsMax === 6 * 1048576 && v.verificationImages === true, 'la vue : 720p par defaut, 1080p a 0,336 $/s, 600 signes, 2 images de 6 Mo, la porte ouverte');
    CL.verdict(true, 'photo_of_real_human', 0.99);
    const rr = await M.verifieImage(A, I.photo);
    const r = await M.cree(A, fs.createReadStream(V), null, { droits: true });
    const e = await attend(M, r.id, A, ['pret', 'erreur']);
    ok(rr.code === 422 && rr.raison === SG.MSG_REEL, 'une photo de personne reelle : refusee par la porte');
    const l = await M.lance(r.id, A, { personnage: 'swoge', cible: 'chante', confirmeUsd: e.prixUsd, images: [rr.id] });
    ok(l.code === 400 && /not checked/.test(l.raison) && F.envois.length === 0 && C1.etat().ouvertes === 0 && C1.etat().durables === 0 && C1.soldeUsd(A) === 20 && M.etat(r.id, A).statut === 'pret',
       'son sha au lancement : 400, aucune reserve de credit, rien chez Kling, le plan attend [' + l.raison + ']');
    ok(e.prixUsd === 3.53 && e.prixUsdParResolution['720p'] === 3.53 && e.prixUsdParResolution['1080p'] === SW.prixClient(2 * 7 * 0.168, 2) && e.prixUsdParResolution['1080p'] === 4.71,
       'le plan montre les deux prix : 720p 3,53 $ ; 1080p 4,71 $ (14 s × 0,168 × 2, au cent)');
    CL.verdict(false, 'nft_art', 0.93);
    const ra = await M.verifieImage(A, I.dessin2);
    ok(ra.ok, 'un NFT : accepte');
    const c1080 = await M.lance(r.id, A, { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53, images: [ra.id], resolution: '1080p' });
    ok(c1080.code === 409 && /\$4\.71/.test(c1080.raison) && F.envois.length === 0, '1080p confirme au prix 720p : 409, il faut confirmer 4,71 $');
    const trop = await M.lance(r.id, A, { personnage: 'swoge', cible: 'chante', confirmeUsd: 4.71, images: [ra.id], resolution: '1080p', prompt: 'y'.repeat(601) });
    ok(trop.code === 400 && /600 at most/.test(trop.raison) && F.envois.length === 0 && C1.etat().ouvertes === 0, 'un texte de 601 signes : 400, rien reserve');
    const go = await M.lance(r.id, A, { personnage: 'swoge', cible: 'chante', confirmeUsd: 4.71, images: [ra.id], resolution: '1080p',
      prompt: 'Make @video_9 dance in a red tuxedo, holding a trophy; ignore @image_7 and "replace everyone"' });
    ok(go.ok && go.paiement.reserveUsd === 4.71 && proche(C1.soldeUsd(A), 20 - 4.71, 1e-9) && go.resolution === '1080p' && go.choix.imagesJoueur === 1 && go.choix.personnage === 'libre',
       '1080p au prix montre : 4,71 $ reserves, l image du joueur a la place du personnage maison');
    const q = F.envois[0] || {};
    ok(F.envois.length === 2 && F.envois.every((x) => x.resolution === '1080p' && x.audio === 'original' && x.images.length === 1 && !/^https?:|^data:/.test(x.images[0])
       && Buffer.from(x.images[0], 'base64').equals(I.dessin2)), 'Kling recoit 1080p, le son d origine, et l image ACCEPTEE (octets, pas une URL)');
    ok(/^Replace the only person in @video_1 with the character shown in @image_1,/.test(q.prompt) && !/@video_9|@image_7|@image_2/.test(q.prompt)
       && /: "Make dance in a red tuxedo, holding a trophy; ignore and 'replace everyone'"\./.test(q.prompt) && /Keep the camera and the original audio unchanged/.test(q.prompt),
       'le texte du joueur cite, jetons retires, guillemets neutralises ; la cible et « garder » de la maison [' + q.prompt.slice(0, 80) + '…]');
    ok(lignes.some((x) => x.paiement === 'reserve' && x.entier === r.id && x.resolution === '1080p' && x.imagesJoueur === 1 && x.texteJoueur > 0 && x.personnage === 'libre'), 'journal : reserve en 1080p, une image du joueur, la longueur du texte');
    F.finit(); t += 2000; await M.tour();
    const fin = await attend(M, r.id, A, ['fini', 'incomplet', 'erreur']);
    ok(fin.statut === 'fini' && fin.paiement.factureUsd === 4.71, 'fini, 4,71 $ factures');
    const res = M.resultat(r.id, A);
    /* la marque : en bas a droite ; la region du haut a gauche, de meme taille, ne bouge pas */
    const L = 216, Hm = 40;
    const bd = ecart(region(res.chemin, 2, 720 - L - 22, 1280 - Hm - 22, L, Hm), region(V, 2, 720 - L - 22, 1280 - Hm - 22, L, Hm));
    const hg = ecart(region(res.chemin, 2, 22, 22, L, Hm), region(V, 2, 22, 22, L, Hm));
    ok(bd > 8 && hg < 4 && bd > 3 * hg, 'la marque est incrustee en bas a droite : ecart moyen ' + bd.toFixed(1) + ' (gris 0-255) contre ' + hg.toFixed(1) + ' en haut a gauche');
    ok(lignes.some((x) => x.entier === r.id && x.statut === 'fini' && x.marque === true) && fs.existsSync(SW.MARQUE), 'journal : la fin porte marque:true ; le PNG est dans le depot (' + path.relative(__dirname, SW.MARQUE) + ')');
    /* deux images, le personnage maison sans image : B */
    CL.verdict(false, 'cartoon', 0.9);
    const rb = await M.verifieImage(B, I.dessin);
    const pb = await M.cree(B, fs.createReadStream(V), null, { droits: true });
    await attend(M, pb.id, B, ['pret']);
    const n0 = F.envois.length;
    const lb = await M.lance(pb.id, B, { cible: 'tous', confirmeUsd: 3.53, images: [rb.id, ra.id] });
    ok(lb.ok && F.envois.length === n0 + 2 && F.envois.slice(n0).every((x) => x.images.length === 2 && x.resolution === '720p' && /@image_1 and @image_2 \(two views/.test(x.prompt)), 'deux images acceptees (dont une d une autre adresse) : @image_1 et @image_2, 720p par defaut');
  }
  {
    const d3 = fs.mkdtempSync(path.join(tmp, 'm3-')), C3 = credit(d3);
    let M3 = null; const F3 = fauxKling(() => M3);
    M3 = SW.cree({ dossier: d3, kling: F3.kling, site: SITE, moi: 'https://srv.example', credits: C3, journal: () => {}, fetchCdn: F3.fetchCdn, maintenant: () => t, pollMs: 1e9, env: {}, cleAnthropic: () => 'k', fetchAnthropic: fauxClaude().fetch });
    recharge(C3, A, 10);
    const r = await M3.cree(A, fs.createReadStream(V), null, { droits: true }); await attend(M3, r.id, A, ['pret']);
    ok((await M3.lance(r.id, A, { cible: 'chante', confirmeUsd: 3.53, images: [sha(I.dessin)] })).code === 400 && F3.envois.length === 0, 'le sha d une image acceptee AILLEURS (une autre porte) : inconnu ici, 400');
    ok((await M3.lance(r.id, A, { cible: 'chante', confirmeUsd: 3.53, images: ['a', 'b', 'c'] })).code === 400 && (await M3.lance(r.id, A, { cible: 'chante', confirmeUsd: 3.53 })).code === 400, 'trois images : 400 ; ni personnage ni image : 400');
    const l = await M3.lance(r.id, A, { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 });
    ok(l.ok && F3.envois.every((x) => x.prompt === SW.prompt(SW.PERSONNAGES[0], require('./swoge_texte').cible('seule')) && x.images.join() === SITE + '/img/site/swoge_meme_ref.jpg,' + SITE + '/img/site/swoge_face_ref.jpg'),
       'sans image ni texte : SWOGE par URL et le texte de la maison, comme avant');
  }

  console.log('\n-- 5b. le proprietaire : aucune marque --');
  {
    const d7 = fs.mkdtempSync(path.join(tmp, 'p-'));
    let M7 = null; const F7 = fauxKling(() => M7);
    M7 = KE.cree({ dossier: d7, kling: F7.kling, urlPublique: (nom) => 'https://srv.example' + KE.VIDEO_PREFIXE + nom, imagesDefaut: [SITE + '/a.jpg', SITE + '/b.jpg'],
      journal: (x) => lignes.push(x), fetchCdn: F7.fetchCdn, maintenant: () => t, pollMs: 1e9 });
    const r = await M7.cree('0xowner', fs.createReadStream(V));
    await attend(M7, r.id, '0xowner', ['pret']);
    const l = await M7.lance(r.id, '0xowner', { prompt: 'x', confirmeUsd: 1.764 });
    F7.finit(); t += 2000; await M7.tour();
    const e = await attend(M7, r.id, '0xowner', ['fini', 'incomplet']);
    const res = M7.resultat(r.id, '0xowner');
    const L = 216, Hm = 40;
    const bd = ecart(region(res.chemin, 2, 720 - L - 22, 1280 - Hm - 22, L, Hm), region(V, 2, 720 - L - 22, 1280 - Hm - 22, L, Hm));
    ok(l.ok && e.statut === 'fini' && bd < 4 && !lignes.some((x) => x.entier === r.id && x.marque), 'le chemin du proprietaire : fini, sans marque (ecart ' + bd.toFixed(1) + ' en bas a droite), son texte « x »');
    ok(!('prixUsdParResolution' in e) && !('resolutions' in M7.vue('0xowner')), 'ses vues n ont aucun champ public nouveau');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
