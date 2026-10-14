'use strict';
/* ============================================================================
 * KLING O1 — L'EDITION D'UN CLIP (kling.js lanceEdition, kling_edition.js)
 *
 * Ce qui DOIT tenir, d'apres la doc lue le 14/10/2026
 * (kling.ai/document-api/api/video/o1/video-omni.md) :
 *   1. Rien ne part sans cle, sans texte, sans URL de clip, hors 3-10 s, ni
 *      avec une reference qui n'est pas un PNG/JPEG d'au moins 300 px et de
 *      rapport 1:2,5 a 2,5:1 (une WebP est refusee : la doc ne la prend pas).
 *   2. Le corps : POST /omni-video/kling-o1, prompt + refer_image (image_1, en
 *      base64 SANS prefixe) + base_video (video_1, par URL), settings
 *      { resolution, audio: 'original' } sans duree ni format (la sortie suit
 *      le clip) ; estimation sur la seconde entamee, grille « With Video Input ».
 *   3. Le suivi rend la facturation lue (`billing`).
 *   4. Le module : clip refuse avant Kling (taille, MP4, duree, cotes), clip
 *      servi par son nom tant que la tache court, efface a la fin, au delai et
 *      au refus ; une edition a la fois ; restes purges au demarrage.
 * Kling est simule (fetch remplace) : aucun appel reel.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
const K = require('./kling');
const E = require('./kling_edition');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const rep = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j });

/* images synthetiques : juste l'en-tete que lit dimensionsImage */
function png(l, h) { const b = Buffer.alloc(40); b.writeUInt32BE(0x89504E47, 0); b.writeUInt32BE(0x0D0A1A0A, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(l, 16); b.writeUInt32BE(h, 20); return b; }
function jpeg(l, h) {
  const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xFF, 0xC2, 0x00, 0x11, 8, h >> 8, h & 255, l >> 8, l & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, sof, Buffer.alloc(16)]);
}
const webp = () => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(40)]);
const du = (b, t) => 'data:image/' + (t || 'png') + ';base64,' + b.toString('base64');

/* MP4 synthetique : ftyp, mdat, moov(mvhd v0, trak(tkhd v0 avec cotes)) */
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x); return b; };
const boite = (type, contenu) => Buffer.concat([u32(8 + contenu.length), Buffer.from(type, 'latin1'), contenu]);
const mvhd0 = (s) => { const c = Buffer.alloc(100); c.writeUInt32BE(1000, 12); c.writeUInt32BE(Math.round(s * 1000), 16); return boite('mvhd', c); };
const tkhd0 = (l, h) => { const c = Buffer.alloc(84); c.writeUInt32BE(l * 65536, 76); c.writeUInt32BE(h * 65536, 80); return boite('tkhd', c); };
const clip = (s, l, h, octets) => Buffer.concat([boite('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1')),
  boite('mdat', Buffer.alloc(octets || 1000, 7)), boite('moov', Buffer.concat([mvhd0(s), boite('trak', Buffer.concat([tkhd0(0, 0)])), boite('trak', tkhd0(l || 720, h || 1280))]))]);

(async () => {
  console.log('-- 1. kling.lanceEdition : ce qui ne part pas --');
  {
    let appels = 0;
    const f = async () => { appels++; return rep(200, { code: 0, data: { id: 'E1' } }); };
    const base = { videoUrl: 'https://srv.example/studio/kling-clip/' + 'a'.repeat(48) + '.mp4', image: du(png(512, 768)), prompt: 'swap @image_1 into @video_1', dureeS: 5 };
    const sans = K.cree({ cle: () => '', fetch: f });
    ok((await sans.lanceEdition(base)).code === 503, 'sans KLING_API_KEY : 503');
    const k = K.cree({ cle: () => 'cle-secrete-kling', fetch: f });
    ok((await k.lanceEdition(Object.assign({}, base, { prompt: ' ' }))).code === 400, 'sans texte : 400');
    ok((await k.lanceEdition(Object.assign({}, base, { prompt: 'x'.repeat(2501) }))).code === 400, 'texte de plus de 2 500 caracteres : 400');
    ok((await k.lanceEdition(Object.assign({}, base, { videoUrl: 'data:video/mp4;base64,AAAA' }))).code === 400, 'un clip en base64 : 400 (la doc veut une URL pour une video)');
    ok((await k.lanceEdition(Object.assign({}, base, { dureeS: 2.9 }))).code === 400, '2,9 s : 400 (3 s au moins)');
    ok((await k.lanceEdition(Object.assign({}, base, { dureeS: 10.04 }))).code === 400, '10,04 s : 400 (10 s au plus)');
    ok((await k.lanceEdition(Object.assign({}, base, { image: '' }))).code === 400, 'sans reference : 400');
    ok((await k.lanceEdition(Object.assign({}, base, { image: du(webp(), 'webp') }))).code === 400, 'une WebP : 400 (jpg/jpeg/png seulement)');
    ok((await k.lanceEdition(Object.assign({}, base, { image: du(png(299, 600)) }))).code === 400, '299 px de large : 400 (300 au moins)');
    const etroite = await k.lanceEdition(Object.assign({}, base, { image: du(png(300, 760)) }));
    ok(etroite.code === 400 && /1:2.5/.test(etroite.raison), '300×760 (1:2,53) : 400');
    ok(appels === 0, 'et aucun de ces refus n est parti chez Kling [' + appels + ']');
  }

  console.log('\n-- 2. kling.lanceEdition : le corps envoye --');
  {
    const vus = [];
    const k = K.cree({ cle: () => 'cle-secrete-kling', fetch: async (u, o) => {
      vus.push({ u, o });
      if (/\/tasks\?/.test(u)) return rep(200, { code: 0, data: [{ id: 'E9', status: 'succeeded', outputs: [{ type: 'video', url: 'https://cdn.kling.example/e.mp4', duration: '5.2' }],
        billing: [{ charge_type: 'unit', amount: '5.4', package_type: 'video' }] }] });
      return rep(200, { code: 0, data: { id: 'E9', status: 'submitted' } });
    } });
    const image = png(1024, 1536);
    const url = 'https://srv.example/studio/kling-clip/' + 'b'.repeat(48) + '.mp4';
    const r = await k.lanceEdition({ videoUrl: url, image: du(image), prompt: 'Replace the singer with @image_1 in @video_1', dureeS: 5.2 });
    const b = JSON.parse(vus[0].o.body);
    ok(r.ok && r.id === 'E9' && vus[0].u === 'https://api-singapore.klingai.com/omni-video/kling-o1' && vus[0].o.method === 'POST', 'POST /omni-video/kling-o1 sur le domaine officiel');
    ok(vus[0].o.headers.authorization === 'Bearer cle-secrete-kling' && !JSON.stringify(r).includes('cle-secrete'), 'la cle en en-tete seulement');
    ok(b.contents.length === 3 && b.contents[0].type === 'prompt' && b.contents[0].text === 'Replace the singer with @image_1 in @video_1', 'le texte, tel quel, cite @image_1 et @video_1');
    ok(b.contents[1].type === 'refer_image' && b.contents[1].id === 'image_1' && b.contents[1].url === image.toString('base64'), 'refer_image image_1, en base64 SANS prefixe data:');
    ok(b.contents[2].type === 'base_video' && b.contents[2].id === 'video_1' && b.contents[2].url === url, 'base_video video_1, par son URL');
    ok(JSON.stringify(b.settings) === JSON.stringify({ resolution: '720p', audio: 'original' }), 'settings : 720p et son d origine, ni duree ni format ' + JSON.stringify(b.settings));
    ok(/^[0-9a-f]{24}$/.test(b.options.external_task_id), 'un identifiant externe');
    ok(r.estimationUsd === 0.756 && r.audio === 'original' && r.modele === 'kling-o1' && r.image === 'png', '5,2 s en 720p : 6 s entamees × 0,126 $ = ' + r.estimationUsd);
    const h = await k.lanceEdition({ videoUrl: url, image: 'https://site.example/img/site/swoge_reference.jpg', prompt: 'a', dureeS: 8, resolution: '1080p', audio: 'off' });
    const bh = JSON.parse(vus[1].o.body);
    ok(h.ok && bh.contents[1].url === 'https://site.example/img/site/swoge_reference.jpg' && bh.settings.resolution === '1080p' && bh.settings.audio === 'off' && h.estimationUsd === 1.344,
       'une reference https part telle quelle ; 8 s en 1080p = 1,344 $');
    const j = await k.lanceEdition({ videoUrl: url, image: du(jpeg(1024, 1536), 'jpeg'), prompt: 'a', dureeS: 3 });
    ok(j.ok && j.image === 'jpeg' && j.estimationUsd === 0.378, 'un JPEG progressif (SOF2) est lu : 3 s = 0,378 $');
    ok(K.prixEdition('720p', 10) === 1.26 && K.prixEdition('1080p', 10) === 1.68 && K.prixEdition('4k', 5) === null, 'la grille : 10 s = 1,26 $ (720p), 1,68 $ (1080p)');
    const e = await k.etat('E9');
    ok(e.ok && e.statut === 'succeeded' && e.url === 'https://cdn.kling.example/e.mp4' && e.facturation && e.facturation[0].montant === '5.4' && e.facturation[0].type === 'unit',
       'le suivi rend la video et la facturation lue (billing)');
  }

  console.log('\n-- 3. dimensions --');
  {
    const d = K.dimensionsImage(jpeg(1024, 1536)), p = K.dimensionsImage(png(640, 480));
    ok(d && d.largeur === 1024 && d.hauteur === 1536 && p && p.format === 'png' && p.largeur === 640, 'JPEG et PNG lus dans leurs en-tetes');
    ok(K.dimensionsImage(webp()) === null && K.dimensionsImage(Buffer.from('hello world, not a picture')) === null, 'le reste : null');
    const m = E.dimensionsMp4(clip(5, 1080, 1920));
    ok(m && m.largeur === 1080 && m.hauteur === 1920, 'MP4 : la premiere piste avec des cotes (tkhd 16.16) [' + JSON.stringify(m) + ']');
    const reel = '/home/user/SWOGE.github.io/img/site/swoge_reference.jpg';
    if (fs.existsSync(reel)) { const r = K.dimensionsImage(fs.readFileSync(reel)); ok(r && r.largeur === 1024 && r.hauteur === 1536, 'la reference SWOGE du site : 1024×1536, dans les bornes'); }
  }

  console.log('\n-- 4. le module : le clip --');
  {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-edition-'));
    fs.writeFileSync(path.join(dossier, 'c'.repeat(48) + '.mp4'), 'reste');
    fs.writeFileSync(path.join(dossier, 'autre.txt'), 'garde');
    let t = 1e12, envois = [], etats = {}, refuse = false;
    const kling = { actif: () => true,
      lanceEdition: async (q) => { envois.push(q); if (refuse) return { ok: false, code: 502, raison: 'Kling refused: nope' };
        return { ok: true, id: 'T' + envois.length, modele: 'kling-o1', resolution: '720p', audio: 'original', dureeS: q.dureeS, estimationUsd: 0.63, image: 'png' }; },
      etat: async (id) => etats[id] || { ok: true, id, statut: 'processing' } };
    const lignes = [];
    const M = E.cree({ dossier, kling, urlPublique: (nom) => 'https://srv.example' + E.VIDEO_PREFIXE + nom, imageDefaut: 'https://site.example/img/site/swoge_reference.jpg',
                       journal: (o) => lignes.push(o), maintenant: () => t, pollMs: 1e9, maxMs: 60000 });
    ok(!fs.existsSync(path.join(dossier, 'c'.repeat(48) + '.mp4')) && fs.existsSync(path.join(dossier, 'autre.txt')), 'au demarrage : le clip reste est efface, rien d autre');
    const A = '0xabc';
    ok((await M.lance({ addr: null, octets: clip(5) })).code === 401, 'sans adresse : 401');
    ok((await M.lance({ addr: A, octets: Buffer.alloc(E.OCTETS_MAX + 1) })).code === 413, 'plus de 20 Mo : 413');
    ok((await M.lance({ addr: A, octets: Buffer.from('pas une video du tout') })).code === 400, 'pas un MP4 : 400');
    ok((await M.lance({ addr: A, octets: clip(2.5) })).code === 400, '2,5 s : 400');
    ok((await M.lance({ addr: A, octets: clip(12) })).code === 400, '12 s : 400');
    ok((await M.lance({ addr: A, octets: clip(5, 480, 854) })).code === 400, '480×854 : 400 (700 px au moins)');
    ok((await M.lance({ addr: A, octets: clip(5, 2160, 3840) })).code === 400, '2160×3840 : 400 (2160 px au plus)');
    ok(envois.length === 0 && fs.readdirSync(dossier).length === 1, 'aucun de ces refus n a ecrit ni envoye');
    const c = clip(5, 720, 1280);
    const r = await M.lance({ addr: A, octets: c, prompt: 'p', resolution: '720p', audio: 'original' });
    ok(r.ok && r.id === 'T1' && r.reference === 'swoge' && envois[0].image === 'https://site.example/img/site/swoge_reference.jpg' && envois[0].dureeS === 5, 'sans image : la reference SWOGE du site, duree lue dans le MP4');
    const nom = envois[0].videoUrl.split('/').pop();
    ok(new RegExp('^https://srv\\.example/studio/kling-clip/[0-9a-f]{48}\\.mp4$').test(envois[0].videoUrl), 'l URL publique, nom de 48 hexa en .mp4');
    const f = M.fichier(nom);
    ok(f && f.octets.equals(c) && f.type === 'video/mp4', 'le clip est servi par son nom tant que la tache court');
    ok(M.fichier('d'.repeat(48) + '.mp4') === null && M.fichier('../' + nom) === null, 'un autre nom : rien');
    ok((await M.lance({ addr: A, octets: c })).code === 429 && envois.length === 1, 'une edition a la fois');
    ok(lignes.length === 1 && lignes[0].id === 'T1' && lignes[0].estimationUsd === 0.63 && lignes[0].image === 'swoge' && lignes[0].cotes === '720x1280', 'l envoi est journalise (estimation, reference, cotes)');
    etats.T1 = { ok: true, id: 'T1', statut: 'succeeded', duree: 5, facturation: [{ type: 'unit', montant: '4.5', devise: 'video' }] };
    await M.avance(M.EN_COURS.get(nom));
    ok(!fs.existsSync(path.join(dossier, nom)) && M.fichier(nom) === null, 'tache finie : le clip est efface');
    ok(lignes.length === 2 && lignes[1].statut === 'succeeded' && lignes[1].facturation[0].montant === '4.5' && M.connue('T1'), 'la fin est journalisee une fois, avec la facturation');
    ok(M.conclut('T1', etats.T1) === false && lignes.length === 2, 'une seconde fin ne reecrit rien');
    /* une image fournie, puis le delai */
    const r2 = await M.lance({ addr: A, octets: clip(4), image: du(png(600, 600)) });
    ok(r2.ok && r2.reference === 'upload' && envois[1].image.startsWith('data:image/png'), 'une image fournie part a la place de SWOGE');
    const nom2 = envois[1].videoUrl.split('/').pop();
    t += 61000; await M.avance(M.EN_COURS.get(nom2));
    ok(!fs.existsSync(path.join(dossier, nom2)) && lignes[lignes.length - 1].statut === 'timeout', 'au dela du delai : clip efface, « timeout » journalise');
    ok((await M.lance({ addr: A, octets: clip(5), image: 'A'.repeat(9 * 1024 * 1024) })).code === 413, 'une reference de plus de 6 Mo : 413');
    refuse = true;
    const r3 = await M.lance({ addr: A, octets: clip(5) });
    ok(!r3.ok && r3.code === 502 && fs.readdirSync(dossier).filter((x) => E.NOM.test(x)).length === 0 && M.EN_COURS.size === 0, 'refus de Kling : clip efface, rien en cours');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
