'use strict';
/* ============================================================================
 * KLING O1 — UNE VIDEO ENTIERE PAR MORCEAUX (kling_entier.js, 14/10/2026)
 *
 * Ce qui DOIT tenir :
 *   1. Le decoupage : coupures de plan d'abord, sinon parts egales <= 9,5 s ;
 *      jamais moins de 3 s ni plus de 10 s ; la somme = la duree source.
 *   2. Le prix au pire : somme des secondes entamees × 0,126 $ (720p) /
 *      0,168 $ (1080p) ; le plafond (20 $, l'environnement ne peut que
 *      l'abaisser) refuse AVANT le moindre appel ; sans le prix confirme, rien.
 *   3. Avec le vrai ffmpeg : morceaux a l'image pres, i/s constante (30 quand
 *      la source est hors 24-60), cotes ramenees dans 700-2160 px.
 *   4. Au plus N morceaux chez Kling a la fois ; un refus 1303 (concurrence)
 *      fait attendre le morceau, pas echouer la passe.
 *   5. Un morceau rate se relance seul, sans refaire les autres.
 *   6. Un redemarrage reprend le suivi par l'id Kling, et retrouve par l'id
 *      externe un morceau coupe entre l'envoi et l'ecriture de l'id.
 *   7. Le recollage : meme longueur que la source (a 0,1 s), son d'origine,
 *      une seule i/s ; les fichiers intermediaires sont effaces.
 *   8. Seuls les hotes Kling sont telecharges ; le resultat ne sort que pour
 *      l'adresse qui l'a lance ; il part apres 48 h ; restes purges.
 *   9. Le journal : chaque envoi (estimation) et chaque fin (facturation lue).
 * Kling est simule : aucun appel reel. ffmpeg est le vrai.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const KE = require('./kling_entier');
const K = require('./kling');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const proche = (a, b, e) => Math.abs(a - b) <= e;

const ffmpegOk = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const sonde = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate', '-of', 'json', f]).toString());
const duree = (f) => Number(sonde(f).format.duration);
const fpsDe = (f) => { const v = sonde(f).streams.find((s) => s.codec_type === 'video'); const [a, b] = v.avg_frame_rate.split('/').map(Number); return a / b; };

/* Une video de test : des plans differents colles (coupures nettes), du son. */
function fabrique(f, plans, o) {
  o = o || {};
  const L = o.l || 720, H = o.h || 1280, F = o.fps || 25;
  const srcs = ['testsrc2', 'mandelbrot', 'rgbtestsrc', 'testsrc', 'smptehdbars', 'cellauto'];
  const args = ['-v', 'error', '-y'];
  plans.forEach((d, k) => args.push('-f', 'lavfi', '-t', String(d), '-i', srcs[k % srcs.length] + '=size=' + L + 'x' + H + ':rate=' + F));
  const tot = plans.reduce((a, b) => a + b, 0);
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=' + tot);
  args.push('-filter_complex', plans.map((_, k) => '[' + k + ':v]').join('') + 'concat=n=' + plans.length + ':v=1:a=0[v]', '-map', '[v]', '-map', plans.length + ':a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f);
  execFileSync('ffmpeg', args);
  return f;
}

/* une image PNG d'en-tete seul (ce que lit dimensionsImage) */
function png(l, h) { const b = Buffer.alloc(40); b.writeUInt32BE(0x89504E47, 0); b.writeUInt32BE(0x0D0A1A0A, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(l, 16); b.writeUInt32BE(h, 20); return b; }
const du = (b) => 'data:image/png;base64,' + b.toString('base64');
const IMG_DEFAUT = 'https://site.example/img/site/swoge_swole_ref.jpg';
const IMG_VISAGE = 'https://site.example/img/site/swoge_face_ref.jpg';

/* Kling simule : il garde les octets du morceau lu a son URL publique, et rend
   comme « resultat » ce meme morceau (eventuellement raccourci). */
function faux(M, o) {
  o = o || {};
  const F = { envois: [], taches: {}, enVolMax: 0, refus: o.refus || {}, externes: {}, cdn: [], hote: o.hote || 'p2-kling.klingai.com' };
  F.kling = {
    actif: () => true,
    lanceEdition: async (q) => {
      const nom = q.videoUrl.split('/').pop();
      const f = M().fichier(nom);
      F.envois.push(Object.assign({}, q, { lu: !!f }));
      const r = F.refus[nom];
      if (r && r.length) return r.shift();
      const id = 'T' + F.envois.length;
      F.taches[id] = { statut: 'processing', octets: f ? f.octets : null, nom, dureeS: q.dureeS };
      if (q.externe) F.externes[q.externe] = id;
      const vol = Object.values(F.taches).filter((t) => t.statut === 'processing').length;
      F.enVolMax = Math.max(F.enVolMax, vol);
      return { ok: true, id, externe: q.externe, modele: 'kling-o1', resolution: q.resolution, audio: q.audio, dureeS: q.dureeS, estimationUsd: K.prixEdition(q.resolution, q.dureeS), images: q.images.map(() => 'url') };
    },
    etat: async (id) => {
      const t = F.taches[id]; if (!t) return { ok: false, code: 404 };
      if (t.statut === 'succeeded') return { ok: true, id, statut: 'succeeded', url: 'https://' + ((F.hoteDe && F.hoteDe[id]) || F.hote) + '/r/' + id + '.mp4', duree: t.dureeS, facturation: [{ type: 'unit', montant: String(t.dureeS * 0.9), devise: 'video' }] };
      if (t.statut === 'failed') return { ok: true, id, statut: 'failed', message: 'content risk' };
      return { ok: true, id, statut: 'processing' };
    },
    etatExterne: async (x) => (F.externes[x] ? F.kling.etat(F.externes[x]) : { ok: false, code: 404, raison: 'unknown task' }),
  };
  F.fetchCdn = async (u) => {
    F.cdn.push(u);
    if (F.panneCdn > 0) { F.panneCdn--; return { status: 500, ok: false, headers: { get: () => null } }; }
    const id = /\/r\/(T\d+)\.mp4$/.exec(u); const t = id && F.taches[id[1]];
    if (!t || !t.octets) return { status: 404, ok: false, headers: { get: () => null } };
    const b = t.resultat || t.octets;
    return { status: 200, ok: true, headers: { get: (h) => (h === 'content-length' ? String(b.length) : null) }, arrayBuffer: async () => b };
  };
  F.finit = (statut, quoi) => { for (const [id, t] of Object.entries(F.taches)) if (t.statut === 'processing' && (!quoi || quoi(id, t))) t.statut = statut; };
  return F;
}

const flux = (f) => fs.createReadStream(f);
async function attendStatut(M, id, addr, statuts, max) {
  for (let k = 0; k < (max || 400); k++) {
    const e = M.etat(id, addr);
    if (statuts.includes(e.statut)) return e;
    await M.attend(id); await new Promise((r) => setTimeout(r, 25));
  }
  return M.etat(id, addr);
}

(async () => {
  console.log('-- 1. le decoupage (calcul) --');
  {
    const s = KE.coupes(26.5, [7.2, 13.2, 22.2], { fps: 25 });
    ok(JSON.stringify(s.map((x) => x.duree)) === JSON.stringify([7.2, 6, 9, 4.3]), 'coupures de plan prises : 7,2 / 6 / 9 / 4,3 s ' + JSON.stringify(s.map((x) => x.duree)));
    const e = KE.coupes(25, [], { fps: 25 });
    ok(e.length === 3 && e.every((x) => x.duree >= 8.3 && x.duree <= 8.36), 'sans coupure de plan : 3 parts egales de ~8,33 s ' + JSON.stringify(e.map((x) => x.duree)));
    const c = KE.coupes(20, [1.0, 18.5], { fps: 30 });
    ok(c.every((x) => x.duree >= 3) && !c.some((x) => proche(x.debut, 1, 0.01) || proche(x.debut, 18.5, 0.01)), 'une coupure a 1 s ou a 1,5 s de la fin est ignoree (jamais < 3 s) ' + JSON.stringify(c.map((x) => x.duree)));
    ok(KE.coupes(2.9, []) === null && KE.coupes(3, []).length === 1 && KE.coupes(9.5, []).length === 1 && KE.coupes(9.6, []).length === 2, '< 3 s : null ; 3 et 9,5 s : un morceau ; 9,6 s : deux');
    let bon = true, pire = '';
    for (let k = 0; k < 400; k++) {
      const D = 3 + Math.random() * 177, F = [24, 25, 30, 60][k % 4];
      const sc = Array.from({ length: Math.floor(Math.random() * 40) }, () => Math.random() * D);
      const r = KE.coupes(D, sc, { fps: F });
      const tot = r.reduce((a, x) => a + x.duree, 0);
      const mauvais = r.some((x) => x.duree < 3 - 1e-6 || x.duree > 9.5 + 1e-6) || !proche(tot, D, 0.002) || r.some((x, i) => i && !proche(x.debut, r[i - 1].debut + r[i - 1].duree, 0.002));
      if (mauvais) { bon = false; pire = D + ' ' + JSON.stringify(r); break; }
    }
    ok(bon, '400 videos au hasard (3-180 s, 0-40 coupures) : chaque morceau dans 3-9,5 s, contigus, somme = duree ' + pire);
    const e94 = KE.coupes(94, [], { fps: 30 });
    ok(e94.length === 10 && KE.prixPire(e94.map((x) => x.duree), '720p') === 12.6 && KE.prixPire(e94.map((x) => x.duree), '1080p') === 16.8,
       '94 s sans coupure de plan : 10 × 9,4 s → 10 × 10 s entamees = 12,60 $ en 720p, 16,80 $ en 1080p');
    ok(KE.prixPire([5.2, 3, 9.99], '720p') === 0.756 + 0.378 + 1.26 && KE.prixPire([2], '720p') === null, 'la somme des secondes entamees ; un morceau hors bornes : null');
    ok(KE.plafondUsd(undefined) === 20 && KE.plafondUsd('50') === 20 && KE.plafondUsd('5') === 5 && KE.plafondUsd('abc') === 20 && KE.plafondUsd('-3') === 20, 'plafond : 20 $, l environnement ne peut que l abaisser');
    ok(KE.parallele(undefined) === 2 && KE.parallele('3') === 3 && KE.parallele('0') === 2 && KE.parallele('99') === 2, 'parallele : 2 par defaut, 1 a 8');
    ok(KE.fpsSortie(29.97) === 30 && KE.fpsSortie(24) === 24 && KE.fpsSortie(60) === 60 && KE.fpsSortie(15) === 30 && KE.fpsSortie(120) === 30 && KE.fpsSortie(null) === 30, 'i/s : 29,97 → 30, 15 ou 120 → 30');
    const cs = KE.cotesSortie(480, 854), cg = KE.cotesSortie(2160, 3840), cn = KE.cotesSortie(720, 1280);
    ok(cs.largeur === 700 && cs.hauteur >= 1244 && cs.hauteur <= 1246 && cg.hauteur === 2160 && cn.change === false && KE.cotesSortie(400, 1800) === null, 'cotes : 480×854 → 700×' + cs.hauteur + ', 4K ramenee a 2160, 1:4,5 refusee');
    const h = KE.hotesPermis('cdn.example.com, pas un domaine');
    ok(h('p2-kling.klingai.com') && h('klingai.com') && h('a.cdn.example.com') && !h('evil.com') && !h('klingai.com.evil.com') && !KE.hotesPermis('')('cdn.example.com'), 'hotes : *.klingai.com, plus KLING_CDN_HOTES');
  }

  if (!ffmpegOk) { console.log('ffmpeg absent : la suite reelle est sautee'); console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe')); process.exit(rates ? 1 : 0); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-entier-'));
  const V = {
    scenes: fabrique(path.join(tmp, 'scenes.mp4'), [7.2, 6, 9, 4.3]),
    egal: fabrique(path.join(tmp, 'egal.mp4'), [25]),
    lent: fabrique(path.join(tmp, 'lent.mp4'), [12], { fps: 15, l: 480, h: 854 }),
    court: fabrique(path.join(tmp, 'court.mp4'), [2.5]),
  };
  const A = '0xowner', B = '0xautre';
  let t = 1e12;
  const lignes = [];
  const fabriqueM = (dossier, F, o) => KE.cree(Object.assign({ dossier, kling: F.kling, urlPublique: (nom) => 'https://srv.example' + KE.VIDEO_PREFIXE + nom,
    imagesDefaut: [IMG_DEFAUT, IMG_VISAGE], journal: (x) => lignes.push(x), fetchCdn: F.fetchCdn, maintenant: () => t, plafondUsd: 20, parallele: 2, pollMs: 1e9,
    attenteLimiteMs: { depart: 1000, max: 4000 } }, o || {}));

  console.log('\n-- 2. le decoupage (vrai ffmpeg) --');
  const d1 = fs.mkdtempSync(path.join(tmp, 'd1-'));
  let M1 = null; const F1 = faux(() => M1); M1 = fabriqueM(d1, F1);
  {
    ok((await M1.cree(null, flux(V.scenes))).code === 401, 'sans adresse : 401');
    ok((await M1.cree(A, flux(V.scenes), 101 * 1024 * 1024)).code === 413, 'plus de 100 Mo annonces : 413 sans lire');
    const rc = await M1.cree(A, flux(V.court));
    const ec = await attendStatut(M1, rc.id, A, ['erreur', 'pret']);
    ok(ec.statut === 'erreur' && /2\.\d+ s long/.test(ec.message), '2,5 s : refuse [' + ec.message + ']');
    const r = await M1.cree(A, flux(V.scenes));
    ok(r.ok && r.statut === 'decoupe' && /^[0-9a-f]{24}$/.test(r.id), 'televerse : decoupage en fond');
    const e = await attendStatut(M1, r.id, A, ['pret', 'erreur']);
    const ds = e.morceaux.map((x) => x.duree);
    ok(e.statut === 'pret' && e.morceaux.length === 4 && proche(ds[0], 7.2, 0.05) && proche(ds[1], 6, 0.05) && proche(ds[2], 9, 0.05) && proche(ds[3], 4.3, 0.06),
       'coupures de plan detectees par ffmpeg : ' + JSON.stringify(ds) + ' (' + e.scenes + ' changements de plan)');
    const P = M1.PASSES.get(r.id);
    const fichiers = P.segments.map((s) => path.join(d1, r.id, s.fichier));
    ok(fichiers.every((f) => { const x = duree(f); return x >= 3 && x <= 10; }) && fichiers.every((f) => proche(fpsDe(f), 25, 0.01)), 'chaque fichier : 3-10 s (ffprobe), 25 i/s gardees');
    ok(proche(ds.reduce((a, b) => a + b, 0), e.source.duree, 0.08), 'la somme des morceaux = la source (' + e.source.duree + ' s)');
    ok(e.prixPire['720p'] === KE.prixPire(ds, '720p') && e.prixPire['720p'] === 3.528 && e.prixPire['1080p'] === 4.704, 'prix au pire : 8+6+9+5 s entamees × 0,126 = ' + e.prixPire['720p'] + ' $ (1080p ' + e.prixPire['1080p'] + ' $)');
    ok(F1.envois.length === 0 && M1.fichier(P.segments[0].fichier) === null, 'rien n est parti chez Kling, rien n est servi avant le clic');
    const r2 = await M1.cree(A, flux(V.egal));
    const e2 = await attendStatut(M1, r2.id, A, ['pret', 'erreur']);
    ok(e2.statut === 'pret' && e2.morceaux.length === 3 && e2.morceaux.every((x) => x.duree > 8.2 && x.duree < 8.45) && !M1.PASSES.has(r.id),
       'sans coupure de plan : 3 parts egales ' + JSON.stringify(e2.morceaux.map((x) => x.duree)) + ' ; le plan non lance precedent est remplace');
    const r3 = await M1.cree(A, flux(V.lent));
    const e3 = await attendStatut(M1, r3.id, A, ['pret', 'erreur']);
    const f3 = path.join(d1, r3.id, M1.PASSES.get(r3.id).segments[0].fichier);
    const v3 = sonde(f3).streams.find((s) => s.codec_type === 'video');
    ok(e3.statut === 'pret' && e3.fps === 30 && proche(fpsDe(f3), 30, 0.01) && v3.width === 700 && v3.height >= 1244, '15 i/s, 480×854 → 30 i/s, ' + v3.width + '×' + v3.height);
  }

  console.log('\n-- 3. la confirmation et le plafond --');
  {
    const r = await M1.cree(A, flux(V.scenes));
    const e = await attendStatut(M1, r.id, A, ['pret']);
    const prix = e.prixPire['720p'];
    ok((await M1.lance(r.id, B, { prompt: 'x', confirmeUsd: prix })).code === 404, 'une autre adresse : 404');
    ok((await M1.lance(r.id, A, { prompt: ' ', confirmeUsd: prix })).code === 400, 'sans texte : 400');
    ok((await M1.lance(r.id, A, { prompt: 'x' })).code === 409, 'sans le prix confirme : 409');
    ok((await M1.lance(r.id, A, { prompt: 'x', confirmeUsd: prix - 0.126 })).code === 409, 'un autre prix que celui du plan : 409');
    ok((await M1.lance(r.id, A, { prompt: 'x', confirmeUsd: prix, images: [du(png(600, 600)), du(png(600, 600)), du(png(600, 600)), du(png(600, 600)), du(png(600, 600))] })).code === 400, '5 images : 400 (4 au plus avec une video)');
    const w = await M1.lance(r.id, A, { prompt: 'x', confirmeUsd: prix, images: ['swoge-face', 'data:image/webp;base64,UklGRgAAAABXRUJQVlA4IAAAAAA='] });
    ok(w.code === 400 && /picture 2/.test(w.raison), 'une WebP en 2e image : 400 [' + w.raison + ']');
    const d2 = fs.mkdtempSync(path.join(tmp, 'd2-'));
    let M2 = null; const F2 = faux(() => M2); M2 = fabriqueM(d2, F2, { plafondUsd: 3 });
    const r2 = await M2.cree(A, flux(V.scenes));
    const e2 = await attendStatut(M2, r2.id, A, ['pret']);
    const cap = await M2.lance(r2.id, A, { prompt: 'x', confirmeUsd: e2.prixPire['720p'] });
    ok(cap.code === 402 && /over the \$3\.00 cap/.test(cap.raison) && e2.plafondUsd === 3, 'plafond abaisse a 3 $ : 3,53 $ au pire refuse [' + cap.raison + ']');
    ok(F1.envois.length === 0 && F2.envois.length === 0, 'aucun de ces refus n a appele Kling');
  }

  console.log('\n-- 4. au plus 2 a la fois, la limite de concurrence, une relance --');
  const P1 = [...M1.PASSES.values()].find((P) => P.statut === 'pret');
  {
    /* le morceau 2 recoit d'abord un 1303 (concurrence du pack) */
    F1.refus[P1.segments[1].fichier] = [{ ok: false, code: 502, raison: 'Kling refused: parallel task over resource pack limit', klingCode: 1303, http: 429 }];
    const prix = KE.prixPire(P1.segments.map((s) => s.duree), '720p');
    const pattes = png(600, 900);
    const l = await M1.lance(P1.id, A, { prompt: 'Replace @image_1 and @image_2 in @video_1', confirmeUsd: prix, images: ['swoge', du(pattes)] });
    ok(l.ok && l.statut === 'en_cours', 'confirme : en cours');
    ok(F1.envois.length === 3 && F1.envois.every((q) => q.lu && q.images.length === 2 && q.images[0] === IMG_DEFAUT && q.images[1] === pattes.toString('base64')
       && q.prompt === 'Replace @image_1 and @image_2 in @video_1' && q.audio === 'original' && q.resolution === '720p' && /^[0-9a-f]{24}$/.test(q.externe)),
       'trois appels (le 2e refuse 1303, le 3e part a sa place), chacun avec le meme texte, les DEUX images (« swoge » → la reference par URL, la 2e en base64), son d origine, un id externe ; Kling a lu le morceau a son URL');
    const e = M1.etat(P1.id, A);
    ok(e.morceaux[1].statut === 'waiting' && /busy \(1303\)/.test(e.morceaux[1].message) && e.statut === 'en_cours', 'refus 1303 : le morceau attend, la passe continue [' + e.morceaux[1].message + ']');
    ok(e.morceaux[0].statut === 'processing' && e.morceaux[2].statut === 'processing' && e.morceaux[3].statut === 'waiting', 'le 1er et le 3e partent a sa place, le 4e attend');
    await M1.tour();
    ok(Object.values(F1.taches).filter((x) => x.statut === 'processing').length === 2 && F1.envois.length === 3, 'tant que 2 sont chez Kling, rien d autre ne part');
    /* le 1er reussit, le 3e echoue */
    F1.finit('succeeded', (id, x) => x.nom === P1.segments[0].fichier);
    F1.finit('failed', (id, x) => x.nom === P1.segments[2].fichier);
    t += 2000; await M1.tour();
    const e2 = M1.etat(P1.id, A);
    ok(e2.morceaux[0].statut === 'done' && e2.morceaux[2].statut === 'failed' && /content risk/.test(e2.morceaux[2].message) && e2.morceaux[2].rejouable, 'le 1er fini et telecharge, le 3e rate (raison montree, relancable)');
    ok(F1.cdn.length === 1 && /^https:\/\/p2-kling\.klingai\.com\//.test(F1.cdn[0]), 'telecharge depuis le CDN Kling');
    ok(e2.morceaux[1].statut === 'processing' && e2.morceaux[3].statut === 'processing' && F1.enVolMax <= 2, 'puis le 2e (apres son attente) et le 4e partent ; jamais plus de 2 a la fois [' + F1.enVolMax + ']');
    ok(!fs.existsSync(path.join(d1, P1.id, P1.segments[0].fichier || 'x')) && P1.segments[0].fichier === null, 'le morceau rendu n est plus servi ni garde');
    F1.finit('succeeded'); t += 2000; await M1.tour();
    const e3 = M1.etat(P1.id, A);
    ok(e3.statut === 'incomplet' && e3.morceaux.filter((x) => x.statut === 'done').length === 3, 'trois reussis, un rate : la passe attend la relance');
    const avant = F1.envois.length;
    const autres = F1.envois.filter((q) => !q.videoUrl.endsWith(P1.segments[2].fichier)).length;
    ok((await M1.relance(P1.id, A, 0)).code === 409 && (await M1.relance(P1.id, B, 2)).code === 404, 'relancer un morceau reussi : 409 ; une autre adresse : 404');
    const rr = await M1.relance(P1.id, A, 2);
    ok(rr.ok && F1.envois.length === avant + 1 && F1.envois[F1.envois.length - 1].videoUrl.endsWith(P1.segments[2].fichier)
       && F1.envois.filter((q) => !q.videoUrl.endsWith(P1.segments[2].fichier)).length === autres, 'la relance renvoie ce seul morceau, rien d autre');
    F1.finit('succeeded'); t += 2000; await M1.tour();
    const fin = await attendStatut(M1, P1.id, A, ['fini', 'incomplet']);
    ok(fin.statut === 'fini' && fin.video === '/studio/kling/entier/' + P1.id + '/video', 'tout reussi : recolle [' + fin.statut + ' ' + (fin.message || '') + ']');

    console.log('\n-- 5. le recollage et le son d origine --');
    const res = M1.resultat(P1.id, A);
    const s = res && sonde(res.chemin);
    const dF = s && Number(s.format.duration);
    ok(res && proche(dF, fin.source.duree, 0.1), 'meme longueur que la source : ' + dF + ' s contre ' + fin.source.duree + ' s');
    ok(s && s.streams.some((x) => x.codec_type === 'audio') && proche(fpsDe(res.chemin), 25, 0.01), 'son present, une seule i/s (25)');
    /* le son est celui de la source : meme duree de piste */
    const piste = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).toString());
    ok(proche(piste(res.chemin), piste(V.scenes), 0.1), 'piste son de la longueur d origine (' + piste(res.chemin) + ' s)');
    ok(fs.readdirSync(path.join(d1, P1.id)).sort().join(',') === ['etat.json', path.basename(res.chemin)].sort().join(','), 'il ne reste que le resultat et l etat ' + JSON.stringify(fs.readdirSync(path.join(d1, P1.id))));
    ok(M1.resultat(P1.id, B) === null && M1.etat(P1.id, B).code === 404, 'une autre adresse ne voit ni l etat ni le resultat');
    const env = lignes.filter((x) => x.entier === P1.id && x.edition && x.estimationUsd != null && !x.statut);
    const fins = lignes.filter((x) => x.entier === P1.id && x.edition && x.statut);
    ok(env.length === 5 && fins.length === 5 && fins.filter((x) => x.statut === 'succeeded').every((x) => x.facturation && x.facturation[0].montant) && lignes.some((x) => x.entier === P1.id && x.limite && x.code === 1303),
       'journal : 5 envois avec estimation, 5 fins (facturation lue), la limite 1303 notee');
    ok(lignes.some((x) => x.entier === P1.id && x.statut === 'fini' && proche(x.dureeFinaleS, fin.source.duree, 0.1)), 'journal : la fin de la passe');
  }

  console.log('\n-- 6. un hote refuse, un telechargement rate, un resultat Kling plus court --');
  {
    const d3 = fs.mkdtempSync(path.join(tmp, 'd3-'));
    const permis = new Set();
    let M3 = null; const F3 = faux(() => M3); M3 = fabriqueM(d3, F3, { hoteOk: (h) => permis.has(h) || /(^|\.)klingai\.com$/.test(h) });
    F3.hoteDe = { T1: 'cdn.autre-hote.example' };
    F3.panneCdn = 1;
    const r = await M3.cree(A, flux(V.egal));
    const e = await attendStatut(M3, r.id, A, ['pret']);
    await M3.lance(r.id, A, { prompt: 'x', confirmeUsd: e.prixPire['720p'] });
    ok(F3.envois.length === 2 && F3.envois.every((q) => JSON.stringify(q.images) === JSON.stringify([IMG_DEFAUT, IMG_VISAGE])), 'sans image choisie : le corps (image_1) puis le visage (image_2)');
    /* le resultat du 2e est 0,4 s plus court que son morceau */
    const t2 = F3.taches.T2;
    fs.writeFileSync(path.join(tmp, 'src2.mp4'), t2.octets);
    const court = path.join(tmp, 'court2.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmp, 'src2.mp4'), '-t', String(Number(t2.dureeS) - 0.4), '-c:v', 'libx264', '-preset', 'ultrafast', '-an', court]);
    t2.resultat = fs.readFileSync(court);
    F3.finit('succeeded'); t += 2000; await M3.tour();
    const e2 = M3.etat(r.id, A);
    ok(e2.morceaux[0].statut === 'failed' && /refused host cdn\.autre-hote\.example/.test(e2.morceaux[0].message) && e2.morceaux[0].rejouable && !F3.cdn.some((u) => /autre-hote/.test(u)),
       'un resultat hors *.klingai.com : refuse sans le lire, l hote est montre [' + e2.morceaux[0].message + ']');
    ok(e2.morceaux[1].statut === 'failed' && /HTTP 500/.test(e2.morceaux[1].message) && /no new charge/.test(e2.morceaux[1].message), 'un CDN en panne : rate, relancable sans repayer');
    const n0 = F3.envois.length;
    const rr = await M3.relance(r.id, A, 1);
    ok(rr.ok && rr.retelecharge && F3.envois.length === n0 && M3.etat(r.id, A).morceaux[1].statut === 'done', 'relance : retelechargement seul, aucun nouvel envoi');
    const rr0 = await M3.relance(r.id, A, 0);
    ok(rr0.ok && M3.etat(r.id, A).morceaux[0].statut === 'failed' && F3.envois.length === n0, 'l hote toujours refuse : toujours rate, rien de renvoye');
    permis.add('cdn.autre-hote.example');   /* le proprietaire ajoute l hote (KLING_CDN_HOTES) */
    await M3.relance(r.id, A, 0);
    F3.finit('succeeded'); t += 2000; await M3.tour();
    const fin = await attendStatut(M3, r.id, A, ['fini', 'incomplet']);
    const res = M3.resultat(r.id, A);
    ok(fin.statut === 'fini' && res && proche(duree(res.chemin), fin.source.duree, 0.1) && F3.envois.length === n0,
       'un morceau rendu 0,4 s trop court est prolonge : longueur finale ' + (res && duree(res.chemin)) + ' s pour ' + fin.source.duree + ' s ; 3 envois en tout');
  }

  console.log('\n-- 7. le redemarrage --');
  {
    const d4 = fs.mkdtempSync(path.join(tmp, 'd4-'));
    let Ma = null, courant = null; const F4 = faux(() => courant); Ma = fabriqueM(d4, F4, { parallele: 3 }); courant = Ma;
    const r = await Ma.cree(A, flux(V.scenes));
    const e = await attendStatut(Ma, r.id, A, ['pret']);
    await Ma.lance(r.id, A, { prompt: 'x', confirmeUsd: e.prixPire['720p'] });
    ok(F4.envois.length === 3, 'parallele 3 : trois envois');
    /* simule une coupure ENTRE l'envoi et l'id : le 3e morceau reste « envoi » sur le disque,
       et le 4e aussi, mais celui-la Kling ne l'a jamais recu */
    const etatF = path.join(d4, r.id, 'etat.json');
    const disque = JSON.parse(fs.readFileSync(etatF, 'utf8'));
    const externe3 = disque.segments[2].externe;
    disque.segments[2].statut = 'envoi'; disque.segments[2].rid = null;
    disque.segments[3].statut = 'envoi'; disque.segments[3].externe = 'a'.repeat(24);
    fs.writeFileSync(etatF, JSON.stringify(disque));
    fs.writeFileSync(path.join(d4, r.id, 'seg_007.mp4'), 'reste'); fs.writeFileSync(path.join(d4, r.id, 'res_001.mp4.part'), 'reste');
    fs.mkdirSync(path.join(d4, 'b'.repeat(24))); fs.writeFileSync(path.join(d4, 'b'.repeat(24), 'x.mp4'), 'sans etat');
    Ma.arrete();
    let Mb = null; F4.externes[externe3] = 'T3'; const n0 = F4.envois.length;
    Mb = fabriqueM(d4, F4, { parallele: 3 }); courant = Mb;   /* Kling lit desormais le nouveau processus */
    ok(!fs.existsSync(path.join(d4, r.id, 'seg_007.mp4')) && !fs.existsSync(path.join(d4, r.id, 'res_001.mp4.part')) && !fs.existsSync(path.join(d4, 'b'.repeat(24))), 'au demarrage : restes et dossier sans etat effaces');
    const e1 = Mb.etat(r.id, A);
    ok(e1.statut === 'en_cours' && e1.morceaux.length === 4 && e1.morceaux[0].statut === 'processing', 'l etat est relu du disque');
    await Mb.tour();
    const e2 = Mb.etat(r.id, A);
    ok(e2.morceaux[2].statut === 'processing' && Mb.PASSES.get(r.id).segments[2].rid === 'T3', 'le morceau coupe entre envoi et id : retrouve chez Kling par l id externe, pas renvoye');
    ok(F4.envois.length === n0 && e2.morceaux[3].statut === 'waiting', 'celui que Kling n a jamais recu : remis en attente (3 deja chez Kling)');
    F4.finit('succeeded'); t += 2000; await Mb.tour();
    ok(F4.envois.length === n0 + 1 && F4.envois[F4.envois.length - 1].videoUrl.endsWith(Mb.PASSES.get(r.id).segments[3].fichier), 'puis renvoye, une seule fois');
    F4.finit('succeeded'); t += 2000; await Mb.tour();
    const fin = await attendStatut(Mb, r.id, A, ['fini', 'incomplet']);
    ok(fin.statut === 'fini' && proche(duree(Mb.resultat(r.id, A).chemin), fin.source.duree, 0.1), 'le suivi reprend par les id Kling et la passe se termine');
    Mb.arrete();
    t += KE.GARDE_MS + 1000;
    const Mc = fabriqueM(d4, F4);
    ok(Mc.etat(r.id, A).code === 404 && !fs.existsSync(path.join(d4, r.id)), 'apres 48 h : le resultat est efface');
  }

  console.log('\n-- 8. abandonner --');
  {
    const d5 = fs.mkdtempSync(path.join(tmp, 'd5-'));
    let M5 = null; const F5 = faux(() => M5); M5 = fabriqueM(d5, F5);
    const r = await M5.cree(A, flux(V.egal));
    const e = await attendStatut(M5, r.id, A, ['pret']);
    await M5.lance(r.id, A, { prompt: 'x', confirmeUsd: e.prixPire['720p'] });
    ok((await M5.cree(A, flux(V.egal))).code === 429, 'une seconde video pendant la premiere : 429');
    const a = M5.abandonne(r.id, A);
    ok(a.ok && a.statut === 'abandon' && fs.readdirSync(path.join(d5, r.id)).join() === 'etat.json', 'abandon : tout est efface sauf l etat');
    const r2 = await M5.cree(A, flux(V.egal));
    ok(r2.ok, 'puis une nouvelle video passe');
    await attendStatut(M5, r2.id, A, ['pret']);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
