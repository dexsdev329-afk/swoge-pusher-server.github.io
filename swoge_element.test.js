'use strict';
/* ============================================================================
 * L'ELEMENT SWOGE ET LA PREMIERE IMAGE (15/10/2026) : kling.js, swoge_element.js,
 * premiere_image.js, et leur usage par kling_edition.js, kling_entier.js, swap.js
 *
 * Ce qui DOIT tenir, d'apres la doc lue le 15/10/2026 (elements.md, video-omni.md,
 * image/o1/image-generation.md) et ce que le proprietaire a mesure le meme jour :
 *   1. kling.js : les corps exacts (element : frontal_image + refer_images[{image_url}],
 *      reference_type image_refer ; suivi task_result.elements[].element_id rendu en
 *      CHAINE ; effacement { element_id } ; image O1 : image_list[{image}], n) ; dans
 *      une edition, { type:'element', element_id, id:'element_1' } et « images +
 *      elements <= 4 », le texte doit citer @element_1. Aucun refus ne part chez Kling.
 *   2. swoge_element.js : vues generees DEPUIS LE MEME seul, plafond du jour, une a la
 *      fois, telechargees des hotes Kling seulement ; televersement aux bornes d'un
 *      element ; creation : frontal = le meme, autres = visage + vues choisies ; suivi
 *      jusqu'a l'id ; l'id survit au redemarrage ; recreer garde l'ancien en service
 *      puis l'efface ; effacer retombe sur les images.
 *   3. Les editions : l'element A LA PLACE des deux images quand il existe (clip,
 *      video entiere du proprietaire, SWOGE Swap) ; jamais avec des images a soi ni
 *      avec celles d'un joueur ; sans element, @image_1 = le meme, @image_2 = le visage.
 *   4. La premiere image : extraite par ffmpeg, 2 candidats par clic, seule la personne
 *      visee, choisie par son adresse seulement, envoyee en DERNIERE refer_image avec
 *      « The first frame of the result must look exactly like @image_N » (morceau 1).
 * Kling est simule : aucun appel reel. ffmpeg est le vrai.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const K = require('./kling');
const ST = require('./swoge_texte');
const SE = require('./swoge_element');
const PI = require('./premiere_image');
const KEd = require('./kling_edition');
const KE = require('./kling_entier');
const SW = require('./swap');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const rep = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j });
function png(l, h, plus) { const b = Buffer.alloc(40 + (plus || 0)); b.writeUInt32BE(0x89504E47, 0); b.writeUInt32BE(0x0D0A1A0A, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(l, 16); b.writeUInt32BE(h, 20); return b; }
const webp = () => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(40)]);
const SITE = 'https://site.example';
const ffmpegOk = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

/* un faux Kling au niveau des FONCTIONS de kling.js (sections 2 a 5) */
function fauxKling() {
  const F = { images: [], etatsImage: {}, elements: [], etatElement: {}, effaces: [], editions: [], refusElement: null };
  let k = 0;
  F.kling = {
    actif: () => true,
    lanceImageOmni: async (q) => { F.images.push(q); const id = 'IMG' + (++k); F.etatsImage[id] = { statut: 'processing' }; return { ok: true, id, estimationUsd: Math.round(0.028 * (q.n || 1) * 1000) / 1000 }; },
    etatImageOmni: async (id) => { const e = F.etatsImage[id]; return e ? Object.assign({ ok: true, id }, e) : { ok: false, code: 404 }; },
    creeElement: async (q) => { F.elements.push(q); if (F.refusElement) return { ok: false, code: 502, raison: F.refusElement }; const t = 'EL' + F.elements.length; F.etatElement[t] = { statut: 'processing' }; return { ok: true, tache: t, externe: q.externe }; },
    etatElement: async (t) => { const e = F.etatElement[t]; return e ? Object.assign({ ok: true }, e) : { ok: false, code: 404 }; },
    supprimeElement: async (id) => { F.effaces.push(id); return { ok: true }; },
    lanceEdition: async (q) => { F.editions.push(q); return { ok: true, id: 'V' + F.editions.length, externe: q.externe, modele: 'kling-o1', resolution: q.resolution || '720p', audio: q.audio, dureeS: q.dureeS,
      estimationUsd: K.prixEdition(q.resolution || '720p', q.dureeS), images: (q.images || []).map(() => 'url'), element: q.element || null }; },
    etat: async (id) => ({ ok: true, id, statut: 'processing' }),
    etatExterne: async () => ({ ok: false, code: 404 }),
  };
  /* le CDN de Kling : une image PNG (en-tete) pour chaque URL p2-kling */
  F.cdn = [];
  F.fetchCdn = async (u) => {
    F.cdn.push(u);
    const b = /cand/.test(u) ? png(720, 1280, 2000) : png(832, 1248, 2000);
    return { status: 200, ok: true, headers: { get: (h) => (h === 'content-length' ? String(b.length) : null) }, arrayBuffer: async () => b };
  };
  return F;
}

(async () => {
  console.log('-- 1. kling.js : les corps de la doc, et ce qui ne part pas --');
  {
    const vus = [];
    const f = async (u, o) => {
      vus.push({ u, o, corps: o && o.body ? JSON.parse(o.body) : null });
      if (/advanced-custom-elements\/T1$/.test(u)) return rep(200, { code: 0, data: { task_id: 'T1', task_status: 'succeed', task_result: { elements: [{ element_id: 829, element_name: 'SWOGE', status: 'succeed' }] }, final_unit_deduction: '2' } });
      if (/advanced-custom-elements$/.test(u)) return rep(200, { code: 0, data: { task_id: 'T1', task_status: 'submitted' } });
      if (/delete-advanced-elements$/.test(u)) return rep(200, { code: 0, data: { task_id: 'D1', task_status: 'succeed' } });
      if (/omni-image\/I1$/.test(u)) return rep(200, { code: 0, data: { task_id: 'I1', task_status: 'succeed', task_result: { images: [{ index: 0, url: 'https://p2-kling.klingai.com/a.png' }, { index: 1, url: 'https://p2-kling.klingai.com/b.png' }, { index: 2, url: 'http://evil/c.png' }] } } });
      if (/omni-image$/.test(u)) return rep(200, { code: 0, data: { task_id: 'I1', task_status: 'submitted' } });
      return rep(200, { code: 0, data: { id: 'V1', status: 'submitted' } });
    };
    const k = K.cree({ cle: () => 'cle-kling', fetch: f });
    const c = await k.creeElement({ nom: 'SWOGE', description: SE.DESCRIPTION_ELEMENT, frontal: SITE + ST.REF_CORPS, autres: [SITE + ST.REF_VISAGE, 'QUJD'], externe: 'a'.repeat(24) });
    const b = vus[0].corps;
    ok(c.ok && c.tache === 'T1' && vus[0].u === K.BASE + '/v1/general/advanced-custom-elements' && vus[0].o.method === 'POST' && vus[0].o.headers.authorization === 'Bearer cle-kling',
       'creer : POST ' + K.BASE + '/v1/general/advanced-custom-elements, Bearer');
    ok(JSON.stringify(Object.keys(b)) === JSON.stringify(['element_name', 'element_description', 'reference_type', 'element_image_list', 'external_task_id'])
       && b.element_name === 'SWOGE' && b.reference_type === 'image_refer' && b.external_task_id === 'a'.repeat(24)
       && JSON.stringify(b.element_image_list) === JSON.stringify({ frontal_image: SITE + ST.REF_CORPS, refer_images: [{ image_url: SITE + ST.REF_VISAGE }, { image_url: 'QUJD' }] }),
       'le corps : element_name, element_description, reference_type image_refer, element_image_list { frontal_image, refer_images: [{ image_url }] } ' + JSON.stringify(b.element_image_list).slice(0, 90));
    ok(SE.DESCRIPTION_ELEMENT.length <= 100 && SE.NOM_ELEMENT.length <= 20, 'nom <= 20 et description <= 100 signes (' + SE.DESCRIPTION_ELEMENT.length + ')');
    const avant = vus.length;
    const r0 = await k.creeElement({ nom: 'SWOGE', description: 'x', frontal: 'QUJD', autres: [] });
    const r4 = await k.creeElement({ nom: 'SWOGE', description: 'x', frontal: 'QUJD', autres: ['A', 'B', 'C', 'D'] });
    const rn = await k.creeElement({ nom: 'x'.repeat(21), description: 'x', frontal: 'QUJD', autres: ['A'] });
    const rd = await k.creeElement({ nom: 'SWOGE', description: 'x'.repeat(101), frontal: 'QUJD', autres: ['A'] });
    ok(r0.code === 400 && r4.code === 400 && rn.code === 400 && rd.code === 400 && vus.length === avant, 'aucune autre image, 4 autres, un nom de 21 ou une description de 101 signes : 400, rien envoye');
    const e = await k.etatElement('T1');
    ok(vus[vus.length - 1].u === K.BASE + '/v1/general/advanced-custom-elements/T1' && vus[vus.length - 1].o.method === 'GET' && e.ok && e.statut === 'succeed' && e.elementId === '829' && typeof e.elementId === 'string' && e.deduction === '2',
       'suivre : GET …/advanced-custom-elements/<task_id> ; element_id (un entier chez Kling) rendu en chaine, deduction gardee');
    const d = await k.supprimeElement('829');
    ok(d.ok && vus[vus.length - 1].u === K.BASE + '/v1/general/delete-advanced-elements' && JSON.stringify(vus[vus.length - 1].corps) === JSON.stringify({ element_id: '829' }),
       'effacer : POST /v1/general/delete-advanced-elements { element_id: "829" } (chaine, comme la table de la doc)');
    const im = await k.lanceImageOmni({ prompt: 'A view of <<<image_1>>>', images: [SITE + ST.REF_CORPS, 'QUJD'], n: 2, format: '9:16', resolution: '1k' });
    const bi = vus[vus.length - 1].corps;
    ok(im.ok && im.estimationUsd === 0.056 && vus[vus.length - 1].u === K.BASE + '/v1/images/omni-image' && bi.model_name === 'kling-image-o1' && bi.n === 2 && bi.aspect_ratio === '9:16' && bi.resolution === '1k'
       && JSON.stringify(bi.image_list) === JSON.stringify([{ image: SITE + ST.REF_CORPS }, { image: 'QUJD' }]),
       'image O1 : POST /v1/images/omni-image, kling-image-o1, image_list [{ image }], n 2 = 0,056 $');
    const ei = await k.etatImageOmni('I1');
    ok(ei.ok && ei.statut === 'succeed' && ei.urls.length === 2 && ei.url === 'https://p2-kling.klingai.com/a.png', 'suivi image O1 : les URL https seulement (2 sur 3)');

    const base = { videoUrl: 'https://srv.example/c.mp4', dureeS: 5 };
    const avant2 = vus.length;
    const sansJeton = await k.lanceEdition(Object.assign({ prompt: 'Replace him with SWOGE in @video_1', element: '829', images: [] }, base));
    const cinq = await k.lanceEdition(Object.assign({ prompt: '@element_1 in @video_1', element: '829', images: [png(400, 400), png(400, 400), png(400, 400), png(400, 400)].map((x) => x.toString('base64')) }, base));
    const mauvais = await k.lanceEdition(Object.assign({ prompt: '@element_1 in @video_1', element: '82 9', images: [] }, base));
    ok(sansJeton.code === 400 && /@element_1/.test(sansJeton.raison) && cinq.code === 400 && /4/.test(cinq.raison) && mauvais.code === 400 && vus.length === avant2,
       'un texte sans @element_1, element + 4 images (5 > 4), un id illisible : 400, rien envoye');
    const v = await k.lanceEdition(Object.assign({ prompt: 'Replace the only person in @video_1 with @element_1.', element: '829', images: [] }, base));
    const bv = vus[vus.length - 1].corps;
    ok(v.ok && v.element === '829' && bv.contents.length === 3 && JSON.stringify(bv.contents[1]) === JSON.stringify({ type: 'element', element_id: '829', id: 'element_1' })
       && bv.contents[2].type === 'base_video' && !bv.contents.some((x) => x.type === 'refer_image'),
       'edition avec l element : { type: element, element_id: "829", id: element_1 }, aucune refer_image');
    const v3 = await k.lanceEdition(Object.assign({ prompt: '@element_1 like @image_1 in @video_1', element: '829', images: [png(400, 400), png(400, 400), png(400, 400)].map((x) => x.toString('base64')) }, base));
    const b3 = vus[vus.length - 1].corps;
    ok(v3.ok && b3.contents.length === 6 && b3.contents.filter((x) => x.type === 'refer_image').map((x) => x.id).join() === 'image_1,image_2,image_3' && b3.contents[1].type === 'element',
       'element + 3 images = 4 : accepte (image_1..image_3)');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-element-'));
  let t = Date.parse('2026-10-15T10:00:00Z');
  const lignes = [];

  console.log('\n-- 2. les vues : depuis le meme, plafond, hotes Kling, televersement --');
  const dE = path.join(tmp, 'element');
  const F = fauxKling();
  const fab = (d, FK) => SE.cree({ dossier: d, kling: FK.kling, site: SITE, journal: (x) => lignes.push(x), maintenant: () => t, fetchCdn: FK.fetchCdn, pollMs: 1e9 });
  let M = fab(dE, F);
  {
    const v0 = M.vue();
    ok(v0.choix.frontal === 'site' && v0.choix.visage === 'site' && v0.choix.pied === null && v0.defauts.frontal === '/img/site/swoge_meme_ref.jpg' && v0.defauts.visage === '/img/site/swoge_face_ref.jpg' && M.elementPret() === null && v0.element === null,
       'au depart : frontal = le meme du site, visage = le visage du site, aucun element');
    ok(v0.cibles.map((c) => c.id).join() === 'gauche,centre,droite,seule', 'la page lit les quatre cibles');
    ok((await M.prepare({ vues: ['dos'] })).code === 400 && F.images.length === 0, 'une vue inconnue : 400, rien chez Kling');
    const p = await M.prepare({});
    ok(p.ok && p.lancees.length === 2 && F.images.length === 2 && F.images.every((q) => q.images.length === 1 && q.images[0] === SITE + '/img/site/swoge_meme_ref.jpg' && q.format === '2:3' && q.resolution === '1k'),
       'Prepare : 2 images (de face, de trois quarts), DEPUIS LE MEME seul, 2:3, 1K');
    const [qp, qs] = F.images;
    ok(/full-body front view of the exact character of <<<image_1>>>/.test(qp.prompt) && /three-quarter side view/.test(qs.prompt) && F.images.every((q) => /from the ears to the feet, legs and feet included/.test(q.prompt)
       && /small Doge head on a thick tall neck/.test(q.prompt) && /short thin legs/.test(q.prompt) && /cream-beige fur everywhere in one uniform colour, no bare skin anywhere/.test(q.prompt)
       && /dark pads/.test(q.prompt) && /black gym shorts/.test(q.prompt) && /plain light neutral background/.test(q.prompt) && !/orange/i.test(q.prompt)),
       'les textes : corps entier, proportions du meme, creme-beige partout, aucune peau, coussinets, short noir, fond neutre, pas d orange');
    ok((await M.prepare({ vues: ['pied'] })).code === 409 && F.images.length === 2, 'une vue deja en cours : 409');
    /* Kling rend la premiere ; la seconde vient d un hote qui n est pas Kling */
    const [v1, v2] = p.lancees;
    F.etatsImage.IMG1 = { statut: 'succeed', url: 'https://p2-kling.klingai.com/vue1.png', urls: ['https://p2-kling.klingai.com/vue1.png'] };
    F.etatsImage.IMG2 = { statut: 'succeed', url: 'https://evil.example/vue2.png', urls: ['https://evil.example/vue2.png'] };
    await M.tour();
    const vv = M.vue().vues;
    const a = vv.find((x) => x.id === v1.id), b = vv.find((x) => x.id === v2.id);
    ok(a.statut === 'pret' && a.image === '/studio/kling/swoge/image/' + a.id && a.largeur === 832 && M.image(a.id).type === 'image/png' && F.cdn.length === 1,
       'la vue de face telechargee de p2-kling.klingai.com, gardee, servie par la route du proprietaire');
    ok(b.statut === 'echec' && /refused host/.test(b.message) && M.image(b.id) === null, 'une URL hors des hotes Kling : refusee, rien garde [' + b.message + ']');
    for (let i = 0; i < 2; i++) { await M.prepare({}); for (const id of Object.keys(F.etatsImage)) if (F.etatsImage[id].statut === 'processing') F.etatsImage[id] = { statut: 'failed', message: 'risk' }; await M.tour(); }
    ok(M.vue().imagesJour === 6, '6 images faites aujourd hui (ratees comprises : Kling les a peut-etre facturees)');
    const plein = await M.prepare({});
    ok(plein.ok && M.vue().imagesJour === 8, '8 : le plafond du jour atteint juste');
    for (const id of Object.keys(F.etatsImage)) if (F.etatsImage[id].statut === 'processing') F.etatsImage[id] = { statut: 'succeed', url: 'https://p2-kling.klingai.com/' + id + '.png', urls: [] };
    await M.tour();
    const nImg = F.images.length;
    const refus = await M.prepare({ vues: ['profil'] });
    ok(refus.code === 429 && /8 pictures per day/.test(refus.raison) && F.images.length === nImg, 'au-dela de 8 images par jour UTC : 429, rien chez Kling');
    t += 24 * 3600e3;
    ok(M.vue().imagesJour === 0, 'le lendemain (UTC) : le compteur repart');
    ok((await M.televerse('pied', webp())).code === 400 && (await M.televerse('pied', png(299, 600))).code === 400 && (await M.televerse('pied', png(300, 760))).code === 400
       && (await M.televerse('pied', png(1000, 1000, 10 * 1024 * 1024))).code === 400 && (await M.televerse('dos', png(800, 800))).code === 400,
       'televerser : WebP, 299 px, 1:2,53, plus de 10 Mo, une vue inconnue : 400 (bornes d un element)');
    const up = M.televerse('profil', png(900, 1350));
    ok(up.ok && up.vue.source === 'upload' && up.vue.statut === 'pret' && M.image(up.vue.id), 'une image du proprietaire (PNG 900×1350) : acceptee pour la vue de trois quarts');
    ok(M.choisit('pied', b.id).code === 400 && M.choisit('frontal', null).code === 400 && M.choisit('pied', 'site').code === 400 && M.choisit('profil', a.id).code === 400,
       'choisir : une vue ratee, aucun frontal, « site » pour la vue de face, une image d une autre vue : 400');
    ok(M.choisit('pied', a.id).ok && M.choisit('profil', up.vue.id).ok && M.vue().choix.pied === a.id, 'le proprietaire choisit la vue de face generee et sa vue de trois quarts');
    /* au plus 6 candidats par vue : les plus vieux non choisis partent */
    ok(M.vue().vues.filter((x) => x.slot === 'pied').length <= SE.CANDIDATS_MAX && M.vue().vues.some((x) => x.id === a.id), 'au plus ' + SE.CANDIDATS_MAX + ' candidats par vue, le choisi garde');
  }

  console.log('\n-- 3. l element : creation, suivi, redemarrage, recreation, effacement --');
  {
    const c = await M.creeElement();
    const q = F.elements[0];
    const pied = fs.readFileSync(path.join(dE, M.etat().vues.find((x) => x.id === M.vue().choix.pied).fichier)).toString('base64');
    ok(c.ok && q.nom === 'SWOGE' && q.frontal === SITE + '/img/site/swoge_meme_ref.jpg' && q.autres.length === 3 && q.autres[0] === SITE + '/img/site/swoge_face_ref.jpg' && q.autres[1] === pied && !/^data:/.test(q.autres[2]),
       'creer : frontal = le meme (URL du site), autres = le visage (URL), la vue de face et la vue de trois quarts (base64 sans prefixe)');
    ok(M.vue().element.statut === 'creation' && M.elementPret() === null && (await M.creeElement()).code === 409, 'en creation : rien en service, une seconde creation : 409');
    ok((await M.supprime()).code === 409, 'effacer pendant la creation : 409');
    /* redemarrage pendant la creation : le suivi reprend par le task_id ecrit */
    M.arrete();
    M = fab(dE, F);
    ok(M.vue().element.statut === 'creation' && M.etat().element.tache === 'EL1', 'apres un redemarrage : la creation reprend (task_id relu du disque)');
    await M.tour();
    ok(M.elementPret() === null, 'Kling n a pas fini : toujours rien en service');
    F.etatElement.EL1 = { statut: 'succeed', elementId: '829', deduction: '2' };
    await M.tour();
    ok(M.elementPret() === '829' && M.vue().element.statut === 'pret' && M.vue().element.deduction === '2' && lignes.some((x) => x.swogeElement && x.element === 'pret' && x.elementId === '829'),
       'Kling a fini : l element 829 en service, la deduction lue, journalise');
    const M2 = fab(dE, F);
    ok(M2.elementPret() === '829' && JSON.parse(fs.readFileSync(path.join(dE, 'etat.json'), 'utf8')).element.elementId === '829', 'un nouveau processus (redemarrage) lit le meme element dans DATA_DIR');
    /* recreer : l ancien sert jusqu a ce que le nouveau soit pret, puis il est efface chez Kling */
    const r = await M.creeElement();
    ok(r.ok && M.vue().element.statut === 'creation' && M.elementPret() === '829', 'recreer : 829 reste en service pendant la creation');
    F.etatElement.EL2 = { statut: 'succeed', elementId: '930' };
    await M.tour();
    ok(M.elementPret() === '930' && F.effaces.join() === '829', 'le nouveau (930) en service, l ancien (829) efface chez Kling');
    F.refusElement = 'element_name invalid';
    const rr = await M.creeElement();
    ok(rr.code === 502 && M.elementPret() === '930' && /refused/.test(M.vue().element.message), 'une recreation refusee par Kling : 930 reste en service, le refus est dit');
    F.refusElement = null;
    await M.creeElement();
    F.etatElement.EL4 = { statut: 'failed', message: 'image risk' };
    await M.tour();
    ok(M.elementPret() === '930' && /failed: Kling failed: image risk/.test(M.vue().element.message), 'une recreation ratee chez Kling : 930 reste en service');
    /* une creation coupee AVANT l ecriture du task_id : dite, jamais refaite en silence */
    const dX = path.join(tmp, 'coupe');
    fs.mkdirSync(dX, { recursive: true });
    fs.writeFileSync(path.join(dX, 'etat.json'), JSON.stringify({ element: { statut: 'creation', tache: null, externe: 'b'.repeat(24), t } }));
    const MX = fab(dX, fauxKling());
    ok(MX.elementPret() === null && MX.vue().element.statut === 'echec' && /restart/.test(MX.vue().element.message), 'creation coupee avant le task_id : echec dit, rien en service');
    const s = await M.supprime();
    ok(s.ok && F.effaces.join() === '829,930' && M.elementPret() === null && fab(dE, F).elementPret() === null, 'effacer : supprime chez Kling (930), plus rien en service, meme apres redemarrage');
    ok(M.elementPret() === null && (await M.supprime()).ok, 'effacer sans element : ok, rien a faire');
    M.choisit('visage', null); M.choisit('pied', null); M.choisit('profil', null);
    const seul = await M.creeElement();
    ok(seul.code === 400 && /at least one picture besides the frontal/.test(seul.raison), 'le meme seul : 400 (la doc veut 1 a 3 autres images)');
  }

  console.log('\n-- 4. les editions : l element A LA PLACE des deux images, sinon le meme et le visage --');
  {
    const FK = fauxKling();
    let el = null;
    const dEd = path.join(tmp, 'edition');
    const Ed = KEd.cree({ dossier: dEd, kling: FK.kling, urlPublique: (x) => 'https://srv.example/c/' + x, imagesDefaut: [SITE + KEd.REFERENCE_EDITION, SITE + KEd.REFERENCE_VISAGE], element: () => el, pollMs: 1e9 });
    const mp4 = (s) => { const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x); return b; }; const bo = (ty, c) => Buffer.concat([u32(8 + c.length), Buffer.from(ty, 'latin1'), c]);
      const mv = Buffer.alloc(100); mv.writeUInt32BE(1000, 12); mv.writeUInt32BE(s * 1000, 16); const tk = Buffer.alloc(84); tk.writeUInt32BE(720 * 65536, 76); tk.writeUInt32BE(1280 * 65536, 80);
      return Buffer.concat([bo('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1')), bo('mdat', Buffer.alloc(500, 1)), bo('moov', Buffer.concat([bo('mvhd', mv), bo('trak', bo('tkhd', tk))]))]); };
    const texte = ST.texte('droite', false);
    const r0 = await Ed.lance({ addr: 'moi', octets: mp4(5), prompt: texte });
    const q0 = FK.editions[0];
    ok(r0.ok && r0.reference === 'swoge' && !q0.element && q0.images.join() === SITE + '/img/site/swoge_meme_ref.jpg,' + SITE + '/img/site/swoge_face_ref.jpg' && q0.prompt === texte,
       'sans element : @image_1 = le meme, @image_2 = le visage, le texte tel quel (repli, rien ne casse)');
    Ed.EN_COURS.clear(); el = '829';
    await Ed.lance({ addr: 'moi', octets: mp4(5), prompt: texte });
    const q1 = FK.editions[1];
    ok(q1.element === '829' && q1.images.length === 0 && q1.prompt === ST.texte('droite', true) && /@element_1/.test(q1.prompt) && !/@image_/.test(q1.prompt),
       'clip, element en service : element 829 SEUL, aucune image, le texte cite @element_1 (et plus aucun @image_)');
    Ed.EN_COURS.clear();
    const mienne = 'data:image/png;base64,' + png(600, 900).toString('base64');
    await Ed.lance({ addr: 'moi', octets: mp4(5), prompt: 'Replace the only person in @video_1 with @image_1.', image: mienne });
    const q2 = FK.editions[2];
    ok(!q2.element && !q2.images && q2.image === mienne && q2.prompt === 'Replace the only person in @video_1 with @image_1.', 'clip avec une image a soi : jamais l element');
    Ed.EN_COURS.clear();
    /* la premiere image : en DERNIERE refer_image, avec sa phrase */
    const still = png(720, 1280).toString('base64');
    await Ed.lance({ addr: 'moi', octets: mp4(5), prompt: texte, premiere: { base64: still } });
    const q3 = FK.editions[3];
    ok(q3.element === '829' && q3.images.length === 1 && q3.images[0] === still && /The first frame of the result must look exactly like @image_1: same character, fur and proportions; then follow the motion of @video_1\.$/.test(q3.prompt),
       'clip + premiere image (element) : l image en @image_1, « The first frame of the result must look exactly like @image_1 »');
    Ed.EN_COURS.clear(); el = null;
    await Ed.lance({ addr: 'moi', octets: mp4(5), prompt: texte, premiere: { base64: still } });
    const q4 = FK.editions[4];
    ok(!q4.element && q4.images.length === 3 && q4.images[2] === still && /must look exactly like @image_3/.test(q4.prompt), 'clip + premiere image sans element : le meme, le visage, puis l image en @image_3');
    ok(ST.versElement('Replace the singer with @image_1 and @image_2.') === 'Replace the singer with @element_1.' && /^SWOGE is @element_1\. /.test(ST.versElement('Replace him.')),
       'versElement : « @image_1 and @image_2 » → @element_1 ; un texte sans mention nomme l element en tete');
  }

  if (!ffmpegOk) { console.log('ffmpeg absent : la suite reelle est sautee'); console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe')); process.exit(rates ? 1 : 0); }

  /* une video de 14 s (deux plans de 7 s), 720×1280, avec son */
  const V = path.join(tmp, 'deux.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '7', '-i', 'testsrc2=size=720x1280:rate=25', '-f', 'lavfi', '-t', '7', '-i', 'mandelbrot=size=720x1280:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=14', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', V]);
  const attend = async (Mo, id, addr, statuts) => { for (let k = 0; k < 400; k++) { const e = Mo.etat(id, addr); if (statuts.includes(e.statut)) return e; await Mo.attend(id); await Mo.tour(); await new Promise((r) => setTimeout(r, 25)); } return Mo.etat(id, addr); };

  console.log('\n-- 5. la video entiere du proprietaire, et SWOGE Swap --');
  {
    const FK = fauxKling();
    let el = '829';
    let Mo = null;
    FK.kling.lanceEdition = (orig => async (q) => { const f = Mo.fichier(q.videoUrl.split('/').pop()); return orig(Object.assign({ lu: !!f }, q)); })(FK.kling.lanceEdition);
    Mo = KE.cree({ dossier: path.join(tmp, 'entier'), kling: FK.kling, urlPublique: (x) => 'https://srv.example/e/' + x, imagesDefaut: [SITE + ST.REF_CORPS, SITE + ST.REF_VISAGE],
      element: () => el, maintenant: () => t, pollMs: 1e9 });
    const texte = ST.texte('gauche', false);
    const plan = async () => { const r = await Mo.cree('moi', fs.createReadStream(V)); return attend(Mo, r.id, 'moi', ['pret', 'erreur']); };
    let e = await plan();
    ok(e.statut === 'pret' && e.morceaux.length === 2, 'plan : 2 morceaux');
    const l1 = await Mo.lance(e.id, 'moi', { images: ['swoge', 'swoge-face'], prompt: texte, confirmeUsd: e.prixPire['720p'] });
    ok(l1.ok && l1.element === true && FK.editions.length === 2 && FK.editions.every((q) => q.element === '829' && q.images.length === 0 && q.prompt === ST.texte('gauche', true) && q.lu),
       'video entiere, SWOGE par defaut + element : chaque morceau part avec l element 829 seul, texte en @element_1');
    Mo.abandonne(e.id, 'moi');
    e = await plan();
    const mienne = 'data:image/png;base64,' + png(600, 900).toString('base64');
    await Mo.lance(e.id, 'moi', { images: ['swoge', mienne], prompt: 'Replace with @image_1 and @image_2 in @video_1', confirmeUsd: e.prixPire['720p'] });
    ok(FK.editions.slice(2).length === 2 && FK.editions.slice(2).every((q) => !q.element && q.images.length === 2 && q.images[0] === SITE + ST.REF_CORPS), 'une image a soi dans la liste : les images, jamais l element');
    Mo.abandonne(e.id, 'moi');
    e = await plan();
    el = null;
    const still = png(720, 1280).toString('base64');
    const quatre = await Mo.lance(e.id, 'moi', { images: ['swoge', 'swoge-face', mienne, mienne], prompt: texte, confirmeUsd: e.prixPire['720p'], premiere: { base64: still, format: 'png' } });
    ok(quatre.code === 400 && /first frame counts as one/.test(quatre.raison) && FK.editions.length === 4, '4 images + la premiere image = 5 : 400, rien chez Kling');
    const lp = await Mo.lance(e.id, 'moi', { images: [], prompt: texte, confirmeUsd: e.prixPire['720p'], premiere: { base64: still, format: 'png' } });
    const [m0, m1] = FK.editions.slice(4);
    ok(lp.ok && lp.premiere === true && m0 && m1 && m0.images.length === 3 && m0.images[2] === still && m1.images[2] === still
       && /The first frame of the result must look exactly like @image_3/.test(m0.prompt) && !/first frame/.test(m1.prompt) && /@image_3 shows exactly how the new character must look/.test(m1.prompt),
       'video entiere + premiere image (morceau 1) : en @image_3 ; « the first frame … » pour le morceau 1 seulement, les autres « shows exactly how … look »');
    ok(Mo.cheminMorceau(e.id, 'autre', 0) === null, 'le morceau 1 ne sort que pour son adresse');

    /* SWOGE Swap */
    const FS = fauxKling();
    let Ms = null;
    const garde = { actif: () => true, image: (id) => (id === 'c'.repeat(64) ? { base64: png(800, 800).toString('base64') } : null), verifie: async () => ({ ok: true }) };
    el = '829';
    Ms = SW.cree({ dossier: path.join(tmp, 'swap'), kling: FS.kling, site: SITE, moi: 'https://srv.example', journal: (x) => lignes.push(x), maintenant: () => t, pollMs: 1e9,
      paie: { reserve: () => 'jeton', regle: () => true, ravive: () => true, solde: () => 100 }, garde, element: () => el, env: {} });
    FS.kling.lanceEdition = (orig => async (q) => orig(Object.assign({ lu: !!Ms.fichier(q.videoUrl.split('/').pop()) }, q)))(FS.kling.lanceEdition);
    const planS = async (a) => { const r = await Ms.cree(a, fs.createReadStream(V), null, { droits: true }); return attend(Ms, r.id, a, ['pret', 'erreur']); };
    let s = await planS('0xa');
    const sansCible = await Ms.lance(s.id, '0xa', { personnage: 'swoge', confirmeUsd: s.prixUsd });
    ok(sansCible.code === 400 && /left, center, right or the only person/.test(sansCible.raison) && FS.editions.length === 0, 'Swap sans cible : 400 (le choix est obligatoire), rien chez Kling');
    const ls = await Ms.lance(s.id, '0xa', { personnage: 'swoge', cible: 'droite', confirmeUsd: s.prixUsd });
    ok(ls.ok && FS.editions.length === 2 && FS.editions.every((q) => q.element === '829' && q.images.length === 0 && q.prompt === SW.prompt(SW.PERSONNAGES[0], ST.cible('droite'), { element: true })
       && /^Replace ONLY the person on the RIGHT side of the frame in @video_1 with the exact SWOGE character of @element_1:/.test(q.prompt)),
       'Swap, SWOGE + element : l element 829 seul, « Replace ONLY the person on the RIGHT side of the frame … @element_1 »');
    s = await planS('0xb');
    await Ms.lance(s.id, '0xb', { cible: 'chante', confirmeUsd: s.prixUsd, images: ['c'.repeat(64)] });
    ok(FS.editions.slice(2).length === 2 && FS.editions.slice(2).every((q) => !q.element && q.images.length === 1 && /^Replace the only person in @video_1 with the character shown in @image_1/.test(q.prompt)),
       'Swap avec l image d un joueur : jamais l element (1 image), l ancien id « chante » = la seule personne');
    el = null;
    s = await planS('0xc');
    await Ms.lance(s.id, '0xc', { personnage: 'swoge', cible: 'centre', confirmeUsd: s.prixUsd });
    ok(FS.editions.slice(4).every((q) => !q.element && q.images.join() === SITE + ST.REF_CORPS + ',' + SITE + ST.REF_VISAGE && /ONLY the person in the CENTER of the frame/.test(q.prompt)),
       'Swap sans element : repli sur le meme et le visage par URL');
  }

  console.log('\n-- 6. la premiere image : ffmpeg, 2 candidats, seule la personne visee, son adresse --');
  {
    const FK = fauxKling();
    const P = PI.cree({ dossier: path.join(tmp, 'premiere'), kling: FK.kling, site: SITE, journal: (x) => lignes.push(x), maintenant: () => t, fetchCdn: FK.fetchCdn });
    const clip5 = path.join(tmp, 'cinq.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', '5', '-i', 'testsrc2=size=720x1280:rate=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip5]);
    ok((await P.prepare('moi', { octets: fs.readFileSync(clip5) })).code === 400 && FK.images.length === 0, 'sans cible : 400, rien chez Kling');
    ok((await P.prepare('moi', { octets: Buffer.from('pas une video'), cible: 'seule' })).code === 400 && FK.images.length === 0, 'pas une video : 400 (ffmpeg), rien chez Kling');
    const r = await P.prepare('moi', { octets: fs.readFileSync(clip5), cible: 'droite' });
    const q = FK.images[0];
    const img = q && Buffer.from(q.images[0], 'base64');
    ok(r.ok && r.premiere.cotes === '720x1280' && r.premiere.format === '9:16' && q.n === 2 && q.format === '9:16' && img[0] === 0xFF && img[1] === 0xD8
       && q.images[1] === SITE + ST.REF_CORPS && q.images[2] === SITE + ST.REF_VISAGE,
       'la premiere image du clip (JPEG 720×1280, ffmpeg) en <<<image_1>>>, le meme et le visage ensuite ; 2 candidats, 9:16');
    ok(/^Edit <<<image_1>>>: replace ONLY the person on the RIGHT side of the frame with the exact SWOGE character of <<<image_2>>> \(full body\) and <<<image_3>>> \(face\)/.test(q.prompt)
       && /Same pose, same place in the frame, same lighting/.test(q.prompt) && /The other people stay exactly as they are/.test(q.prompt) && /Everything else in <<<image_1>>> stays exactly the same/.test(q.prompt)
       && /no bare human skin anywhere/.test(q.prompt) && /Plain black gym shorts/.test(q.prompt) && !/@image_|@video_/.test(q.prompt),
       'le texte de l image : seule la personne de droite, le personnage du meme, meme pose et lumiere, rien d autre ne change (jetons <<<image_n>>>)');
    const id = r.premiere.id;
    ok(P.etat(id, 'autre').code === 404 && P.fichier(id, 'autre') === null && P.choisie(id, 'autre').code === 404, 'une autre adresse : rien (404)');
    ok(P.choisie(id, 'moi').code === 400, 'avant le choix : rien a envoyer');
    FK.etatsImage.IMG1 = { statut: 'succeed', urls: ['https://p2-kling.klingai.com/cand1.png', 'https://p2-kling.klingai.com/cand2.png'] };
    await P.tour();
    const e = P.etat(id, 'moi').premiere;
    ok(e.candidats.length === 2 && e.candidats[1].image === '/studio/kling/premiere/' + id + '/candidat/1' && P.fichier(id, 'moi', 1).type === 'image/png' && P.fichier(id, 'moi').type === 'image/jpeg' && e.prixClicUsd === 0.056,
       '2 candidats telecharges (hotes Kling), servis a leur adresse ; 0,056 $ le clic');
    ok(P.choisit(id, 'moi', 5).code === 400 && P.choisit(id, 'moi', 1).ok, 'choisir un candidat qui n existe pas : 400 ; le second : ok');
    const c = P.choisie(id, 'moi');
    ok(c.ok && Buffer.from(c.base64, 'base64').equals(png(720, 1280, 2000)) && c.depuis === 'clip', 'l image choisie, prete pour Kling (base64, ses octets)');
    for (let k = 0; k < 3; k++) { const g = await P.regenere(id, 'moi'); ok(g.ok, 'regenerer ' + (k + 2) + '/4'); FK.etatsImage['IMG' + (k + 2)] = { statut: 'failed', message: 'x' }; await P.tour(); }
    const trop = await P.regenere(id, 'moi');
    ok(trop.code === 429 && FK.images.length === 4, 'un 5e essai sur la meme image : 429');
    const P2 = PI.cree({ dossier: path.join(tmp, 'premiere'), kling: FK.kling, site: SITE, maintenant: () => t, fetchCdn: FK.fetchCdn });
    ok(P2.choisie(id, 'moi').ok, 'apres un redemarrage : le choix est relu du disque');
    ok(PI.formatProche(1280, 720) === '16:9' && PI.formatProche(1170, 1141) === '1:1' && PI.formatProche(1000, 1500) === '2:3', 'le format Kling le plus proche du cadre');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('ESSAI CASSE : ' + (e && e.stack || e)); process.exit(1); });
