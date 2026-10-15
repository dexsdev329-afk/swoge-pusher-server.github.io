'use strict';
/* ==========================================================================
 * LA PREMIERE IMAGE — L'IDENTITE FIXEE SUR UNE IMAGE AVANT DE PAYER LA VIDEO
 * (proprietaire seulement, 15 octobre 2026)
 *
 * Mesure du 15/10/2026 (clip de magasin, 10 s, le joueur de ukulele remplace) :
 * la BONNE personne a ete remplacee (cible par position) et SWOGE portait le
 * short noir, mais c'etait encore un culturiste HUMAIN, peau nue bronzee, mains
 * humaines, tete de shiba realiste : ni la fourrure ni les proportions du meme.
 * Une image coute 0,028 $ ; dix secondes de video O1, 1,26 $. On fixe donc
 * l'identite sur UNE image, ou elle est bon marche et precise, avant la video.
 *
 * ---- LE CHEMIN ----
 *   1. ffmpeg extrait la premiere image du clip (edition d'un clip) ou du
 *      morceau 1 deja coupe (video entiere).
 *   2. Kling Image O1 (/v1/images/omni-image, kling.js lanceImageOmni ; doc
 *      api/image/o1/image-generation.md lue le 15/10/2026 : `image_list` d'images
 *      de reference + `prompt` qui les cite <<<image_n>>>, exemple « Merge all the
 *      people in the images into the <<<object_1>>> image ») remplace SEULEMENT la
 *      personne choisie (gauche / centre / droite / seule) par SWOGE :
 *      <<<image_1>>> l'image du clip, <<<image_2>>> le meme (corps entier),
 *      <<<image_3>>> le visage. 2 candidats par clic (`n: 2`, « Value range [1, 9] »),
 *      0,028 $ l'image (pricing/base/image.md), donc 0,056 $ le clic.
 *      L'element SWOGE n'est PAS envoye a l'image : `element_list` de omni-image
 *      renvoie a la page « Kling Image O1 - Element Management », distincte de
 *      celle des elements video (elements.md) — rien ne dit que l'id d'un element
 *      video y vaut. Ambigu, donc pas utilise : les deux images de SWOGE suffisent.
 *   3. Le proprietaire choisit un candidat (ou regenere). L'image choisie part
 *      avec l'edition video comme REFERENCE de scene (refer_image) : video-omni.md
 *      dit qu'un base_video « does not support defining the first or last frame »,
 *      d'ou une reference et une phrase : « The first frame of the result must look
 *      exactly like @image_N … follow the motion of @video_1 ». Toujours dans
 *      « images + elements <= 4 ».
 *   Video entiere : l'image du MORCEAU 1. Elle part avec chaque morceau ; seul le
 *   morceau 1 recoit « the first frame … must look exactly like » (les autres
 *   commencent ailleurs : pour eux, elle montre seulement a quoi SWOGE ressemble).
 *
 * Plafonds : 4 clics (8 candidats) par image, PREMIERES_JOUR_MAX images par jour
 * UTC (24 = 0,672 $). Une preparation par adresse a la fois. Garde 48 h.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const K = require('./kling');
const T = require('./swoge_texte');
const { telechargeSur } = require('./telecharge_sur');

const ID = /^[0-9a-f]{24}$/;
const PAR_CLIC = 2;
const CLICS_MAX = 4;
const PREMIERES_JOUR_MAX = 24;
const GARDE_MS = 48 * 3600e3;
const IMAGE_MAX_MS = 15 * 60e3;
const FORMATS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '3:2': 3 / 2, '2:3': 2 / 3, '21:9': 21 / 9 };

const executer = (bin, args, ms) => new Promise((res, rej) => execFile(bin, args, { timeout: ms || 120000, maxBuffer: 16 * 1024 * 1024 },
  (e, out, err) => (e ? rej(Object.assign(e, { err: String(err || '').slice(-400) })) : res())));
const propre = (m) => String(m || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 240);
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);

/** Le format Kling le plus proche des cotes de l'image (meme cadrage que le clip). */
function formatProche(l, h) {
  const r = l / h;
  let best = '1:1';
  for (const [k, v] of Object.entries(FORMATS)) if (Math.abs(Math.log(v / r)) < Math.abs(Math.log(FORMATS[best] / r))) best = k;
  return best;
}

/** Le texte de l'image : remplacer la seule personne visee par SWOGE, rien d'autre ne bouge. */
function texteImage(idCible) {
  const c = T.cible(idCible) || T.cible('seule');
  return 'Edit <<<image_1>>>: replace ' + c.qui + ' with ' + T.personnage({ corps: '<<<image_2>>>', visage: '<<<image_3>>>' }) + '. '
    + 'Same pose, same place in the frame, same lighting and camera angle.' + c.autres
    + ' Everything else in <<<image_1>>> stays exactly the same. Video-realistic 3D fur, no text.';
}

/** La phrase ajoutee au texte de la video. `n` : le numero de l'image dans refer_image. */
function phraseVideo(n, premierMorceau) {
  return premierMorceau
    ? ' The first frame of the result must look exactly like @image_' + n + ': same character, fur and proportions; then follow the motion of @video_1.'
    : ' @image_' + n + ' shows exactly how the new character must look in this video: same character, fur and proportions; follow the motion of @video_1.';
}

/**
 * deps : { dossier, kling, site, journal?, ffmpeg?, fetchCdn?, hoteOk?, httpPermis?, maintenant? }
 */
function cree(deps) {
  const dossier = deps.dossier;
  const kling = deps.kling;
  const site = String(deps.site || '').replace(/\/+$/, '');
  const ffmpeg = deps.ffmpeg || 'ffmpeg';
  const temps = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const hoteOk = deps.hoteOk || require('./kling_entier').hotesPermis(process.env.KLING_CDN_HOTES);
  const note = (o) => { try { if (deps.journal) deps.journal(Object.assign({ premiere: true }, o)); } catch (e) { /* jamais bloquant */ } };
  const JOBS = new Map();
  const rep = (id) => path.join(dossier, id);
  const fJour = () => path.join(dossier, 'jour.json');

  function ecrit(J) {
    try {
      fs.mkdirSync(rep(J.id), { recursive: true });
      const f = path.join(rep(J.id), 'job.json'), tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(J)); fs.renameSync(tmp, f);
    } catch (e) { console.error('[premiere] etat non ecrit : ' + e.message); }
  }
  function lisJour() { try { const j = JSON.parse(fs.readFileSync(fJour(), 'utf8')); return j.jour === jourDe(temps()) ? j : { jour: jourDe(temps()), images: 0 }; } catch (e) { return { jour: jourDe(temps()), images: 0 }; } }
  function ajouteJour(n) { const j = lisJour(); j.images += n; try { fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(fJour(), JSON.stringify(j)); } catch (e) { /* jamais bloquant */ } }
  function relit() {
    let noms = [];
    try { noms = fs.readdirSync(dossier); } catch (e) { return; }
    for (const n of noms) {
      if (!ID.test(n)) continue;
      let J = null;
      try { J = JSON.parse(fs.readFileSync(path.join(rep(n), 'job.json'), 'utf8')); } catch (e) { J = null; }
      if (!J || temps() - J.t > GARDE_MS) { fs.rmSync(rep(n), { recursive: true, force: true }); continue; }
      for (const g of J.generations || []) if (g.statut === 'en_cours' && !g.tache) { g.statut = 'echec'; g.message = 'interrupted by a server restart before Kling answered — generate again'; }
      JOBS.set(n, J);
    }
  }

  async function genere(J) {
    if (J.generations.length >= CLICS_MAX) return { ok: false, code: 429, raison: CLICS_MAX + ' tries per frame at most — prepare the frame again from the clip' };
    if (J.generations.some((g) => g.statut === 'en_cours')) return { ok: false, code: 409, raison: 'candidates are already being made — wait for them' };
    if (lisJour().images + PAR_CLIC > PREMIERES_JOUR_MAX) return { ok: false, code: 429, raison: 'daily cap reached: ' + PREMIERES_JOUR_MAX + ' first-frame pictures per day (UTC)' };
    if (!kling.actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    const g = { statut: 'en_cours', tache: null, t: temps(), message: null };
    J.generations.push(g); ajouteJour(PAR_CLIC); ecrit(J);   /* compte AVANT l'appel */
    const image = fs.readFileSync(path.join(rep(J.id), 'image.jpg')).toString('base64');
    const r = await kling.lanceImageOmni({ prompt: texteImage(J.cible), images: [image, site + T.REF_CORPS, site + T.REF_VISAGE], n: PAR_CLIC, format: J.format, resolution: '1k' });
    if (!r || !r.ok) { g.statut = 'echec'; g.message = propre((r && r.raison) || 'Kling refused'); ecrit(J); return { ok: false, code: (r && r.code) || 502, raison: g.message }; }
    g.tache = r.id; g.estimationUsd = r.estimationUsd; ecrit(J);
    note({ id: J.id, tache: r.id, cible: J.cible, estimationUsd: r.estimationUsd, essai: J.generations.length });
    return { ok: true };
  }

  /**
   * Prepare la premiere image pour `addr` (la SESSION) : q { chemin (un MP4 sur le disque) |
   * octets (Buffer MP4), cible, depuis: 'clip' | 'entier' }. Extrait l'image 0, puis lance 2 candidats.
   */
  async function prepare(addr, q) {
    q = q || {};
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    const c = T.cible(q.cible);
    if (!c) return { ok: false, code: 400, raison: 'pick who to replace: left, center, right or the only person' };
    for (const J of JOBS.values()) if (J.addr === addr && J.generations.some((g) => g.statut === 'en_cours')) return { ok: false, code: 429, raison: 'one first frame at a time — wait for the current one' };
    if (!kling.actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    const id = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(rep(id), { recursive: true });
    let source = q.chemin;
    if (!source) {
      if (!Buffer.isBuffer(q.octets) || !q.octets.length) return { ok: false, code: 400, raison: 'choose a clip first' };
      source = path.join(rep(id), 'clip.mp4'); fs.writeFileSync(source, q.octets);
    }
    const sortie = path.join(rep(id), 'image.jpg');
    try { await executer(ffmpeg, ['-v', 'error', '-y', '-i', source, '-frames:v', '1', '-q:v', '2', '-f', 'image2', sortie]); }
    catch (e) { fs.rmSync(rep(id), { recursive: true, force: true }); return { ok: false, code: 400, raison: 'ffmpeg could not read the first frame: ' + propre(e.err || e.message) }; }
    finally { if (!q.chemin) try { fs.unlinkSync(path.join(rep(id), 'clip.mp4')); } catch (e) { /* deja parti */ } }
    let b = null;
    try { b = fs.readFileSync(sortie); } catch (e) { b = null; }
    const r = b ? K.referenceElement(b) : { ok: false, raison: 'no frame' };
    if (!r.ok) { fs.rmSync(rep(id), { recursive: true, force: true }); return { ok: false, code: 400, raison: 'the first frame is not usable by Kling: ' + r.raison }; }
    const J = { id, addr, t: temps(), cible: c.id, depuis: q.depuis === 'entier' ? 'entier' : 'clip', entier: q.entier || null, largeur: r.largeur, hauteur: r.hauteur,
                format: formatProche(r.largeur, r.hauteur), generations: [], candidats: [], choisi: null };
    JOBS.set(id, J); ecrit(J);
    const g = await genere(J);
    if (!g.ok) return Object.assign(g, { premiere: vue1(J) });
    return { ok: true, premiere: vue1(J) };
  }

  async function regenere(id, addr) {
    const J = ID.test(String(id || '')) ? JOBS.get(String(id)) : null;
    if (!J || J.addr !== addr) return { ok: false, code: 404, raison: 'unknown first frame' };
    const g = await genere(J);
    return g.ok ? { ok: true, premiere: vue1(J) } : Object.assign(g, { premiere: vue1(J) });
  }

  function choisit(id, addr, k) {
    const J = ID.test(String(id || '')) ? JOBS.get(String(id)) : null;
    if (!J || J.addr !== addr) return { ok: false, code: 404, raison: 'unknown first frame' };
    if (k === null) { J.choisi = null; ecrit(J); return { ok: true, premiere: vue1(J) }; }
    const c = J.candidats[Number(k)];
    if (!c || !Number.isInteger(Number(k))) return { ok: false, code: 400, raison: 'pick one of the candidates' };
    J.choisi = Number(k); ecrit(J);
    note({ id: J.id, choisi: J.choisi });
    return { ok: true, premiere: vue1(J) };
  }

  /** L'image choisie, prete pour Kling : { base64, format } ou un refus (jamais rien d'une autre adresse). */
  function choisie(id, addr) {
    const J = ID.test(String(id || '')) ? JOBS.get(String(id)) : null;
    if (!J || J.addr !== addr) return { ok: false, code: 404, raison: 'unknown first frame' };
    if (J.choisi == null) return { ok: false, code: 400, raison: 'pick one of the first-frame candidates first' };
    const c = J.candidats[J.choisi];
    let b;
    try { b = fs.readFileSync(path.join(rep(J.id), c.fichier)); } catch (e) { return { ok: false, code: 410, raison: 'the chosen first frame is gone — prepare it again' }; }
    const r = K.referenceEdition(b.toString('base64'));
    if (!r.ok) return { ok: false, code: 400, raison: 'first frame: ' + r.raison };
    return { ok: true, base64: r.image, format: r.source, id: J.id, entier: J.entier, depuis: J.depuis };
  }

  async function suit(J, g) {
    const e = await kling.etatImageOmni(g.tache);
    const trop = temps() - g.t > IMAGE_MAX_MS;
    if (!e || !e.ok || (e.statut !== 'succeed' && e.statut !== 'failed')) { if (trop) { g.statut = 'echec'; g.message = 'no answer from Kling after ' + Math.round(IMAGE_MAX_MS / 60e3) + ' min'; ecrit(J); } return; }
    if (e.statut === 'failed' || !(e.urls || []).length) { g.statut = 'echec'; g.message = propre('Kling failed: ' + (e.message || 'no picture returned')); ecrit(J); return; }
    let n = 0;
    for (const u of e.urls.slice(0, PAR_CLIC)) {
      let b;
      try { b = await telechargeSur(u, { fetch: deps.fetchCdn, hoteOk, httpPermis: !!deps.httpPermis, max: 20 * 1024 * 1024, delaiMs: 60000 }); }
      catch (x) { g.message = propre('a download failed: ' + x.message); continue; }
      const r = K.dimensionsImage(b);
      if (!r) { g.message = 'Kling returned a picture that is not PNG or JPEG'; continue; }
      const fichier = 'cand_' + J.candidats.length + (r.format === 'png' ? '.png' : '.jpg');
      fs.writeFileSync(path.join(rep(J.id), fichier), b);
      J.candidats.push({ fichier, format: r.format, largeur: r.largeur, hauteur: r.hauteur, t: temps() });
      n++;
    }
    g.statut = n ? 'pret' : 'echec'; g.recus = n; ecrit(J);
    note({ id: J.id, tache: g.tache, candidats: n, secondes: Math.round((temps() - g.t) / 1000) });
  }
  let tourEnCours = null;
  async function tour() {
    if (tourEnCours) return tourEnCours;
    tourEnCours = (async () => {
      for (const J of JOBS.values()) {
        if (temps() - J.t > GARDE_MS) { JOBS.delete(J.id); fs.rmSync(rep(J.id), { recursive: true, force: true }); continue; }
        for (const g of J.generations) if (g.statut === 'en_cours' && g.tache) { try { await suit(J, g); } catch (x) { console.error('[premiere] ' + x.message); } }
      }
    })().finally(() => { tourEnCours = null; });
    return tourEnCours;
  }

  function vue1(J) {
    return { id: J.id, cible: J.cible, depuis: J.depuis, cotes: J.largeur + 'x' + J.hauteur, format: J.format, choisi: J.choisi,
      image: '/studio/kling/premiere/' + J.id + '/image',
      enCours: J.generations.some((g) => g.statut === 'en_cours'), essais: J.generations.length, essaisMax: CLICS_MAX,
      message: (J.generations.slice().reverse().find((g) => g.message) || {}).message || null,
      candidats: J.candidats.map((c, k) => ({ k, image: '/studio/kling/premiere/' + J.id + '/candidat/' + k, largeur: c.largeur, hauteur: c.hauteur })),
      prixClicUsd: Math.round(K.IMAGE_PRIX_USD * PAR_CLIC * 1000) / 1000 };
  }
  function etat(id, addr) {
    const J = ID.test(String(id || '')) ? JOBS.get(String(id)) : null;
    if (!J || J.addr !== addr) return { ok: false, code: 404, raison: 'unknown first frame' };
    return { ok: true, premiere: vue1(J) };
  }
  /** Une image d'un job (l'image du clip, ou un candidat k), pour SON adresse seulement. */
  function fichier(id, addr, k) {
    const J = ID.test(String(id || '')) ? JOBS.get(String(id)) : null;
    if (!J || J.addr !== addr) return null;
    const f = k == null ? { fichier: 'image.jpg', format: 'jpeg' } : J.candidats[Number(k)];
    if (!f) return null;
    try { return { octets: fs.readFileSync(path.join(rep(J.id), f.fichier)), type: f.format === 'png' ? 'image/png' : 'image/jpeg' }; }
    catch (e) { return null; }
  }

  relit();
  return { prepare, regenere, choisit, choisie, tour, etat, fichier, JOBS };
}

module.exports = { cree, texteImage, phraseVideo, formatProche, PAR_CLIC, CLICS_MAX, PREMIERES_JOUR_MAX };
