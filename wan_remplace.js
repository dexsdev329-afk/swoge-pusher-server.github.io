'use strict';
/* ==========================================================================
 * WAN 2.2 ANIMATE « REPLACE » (fal) — LE SECOND MOTEUR DE L'ESSAI D'EDITION
 *
 * Demande du proprietaire, 14 octobre 2026 : a cote de Kling O1, faire tourner
 * Wan 2.2 Animate Replace sur LE MEME clip pour comparer. Proprietaire seul,
 * meme garde que /studio/kling ; FAL_KEY vit dans l'environnement de l'hote.
 *
 * ---- CE QUI A ETE LU (14/10/2026) ----
 *   Modele   fal-ai/wan/v2.2-14b/animate/replace — schema OpenAPI
 *            https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/wan/v2.2-14b/animate/replace
 *            entree : video_url, image_url (requis), resolution 480p|580p|720p
 *            (defaut 480p), le reste a ses defauts ; sortie : { video: { url },
 *            prompt, seed }. AUCUN texte en entree : le modele choisit la
 *            personne a remplacer. Aucun son n'est decrit en sortie.
 *            Les deux entrees sont decrites comme des URL (« URL of the input
 *            video / image ») ; la page generale parle de data URI pour les
 *            clients, sans le confirmer pour ces champs : on envoie des URL.
 *   File     https://docs.fal.ai/model-apis/model-endpoints/queue.md :
 *            POST https://queue.fal.run/<modele>, en-tete « Authorization: Key
 *            <FAL_KEY> » → { request_id, status_url, response_url } ;
 *            GET status_url → { status: IN_QUEUE | IN_PROGRESS | COMPLETED,
 *            error?, error_type? } ; GET response_url → la sortie. On suit les
 *            adresses rendues par fal (verifiees : https://queue.fal.run/), sinon
 *            les chemins du schema (…/requests/<id>/status, …/requests/<id>).
 *   Prix     page du modele (fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace) :
 *            « billed based on the number of frames, at a rate of 16 frames per
 *            video second » — 720p 0,08 $, 580p 0,06 $, 480p 0,04 $ la seconde
 *            video ; secondes facturees = images totales ÷ 16. Un clip de
 *            telephone a 30 i/s couterait donc ~1,9 fois sa duree : le serveur le
 *            reechantillonne a 16 i/s (ffmpeg, Dockerfile) AVANT l'envoi, et
 *            l'estimation compte les images reelles du clip envoye.
 *
 * ---- LE SON ----
 *   Wan rend une video muette : ffmpeg y remet la piste son du clip d'origine
 *   (-shortest, meme longueur), et le fichier final n'est servi qu'au
 *   proprietaire qui l'a lance (route sous session). Sans ffmpeg : 503, rien
 *   ne part (ni le reechantillonnage ni le son ne seraient possibles).
 *
 * ---- LES FICHIERS ----
 *   Le clip reechantillonne et l'image fournie sont servis SANS session, par un
 *   nom de 48 hexa, le temps que fal les lise, puis effaces des que la tache
 *   finit, echoue ou depasse le delai. Le clip d'origine (pour son son) n'est
 *   jamais servi. Le resultat final est garde 24 h. Au demarrage, toutes les
 *   entrees sont effacees, et les resultats de plus de 24 h.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { dureeMp4 } = require('./essai_montage');
const { telechargeSur } = require('./telecharge_sur');
const K = require('./kling');

const MODELE = 'fal-ai/wan/v2.2-14b/animate/replace';
const QUEUE = 'https://queue.fal.run';
const PRIX = { '480p': 0.04, '580p': 0.06, '720p': 0.08 };   /* $ par « seconde video » = 16 images */
const IMAGES_PAR_SECONDE_FACTUREE = 16;
const FPS = 16;
/* Les memes bornes que l'edition Kling : la comparaison se fait sur le meme
   clip (fal ne publie pas de limite de duree pour ce modele). */
const DUREE = { min: K.EDITION_DUREE.min, max: K.EDITION_DUREE.max };
const OCTETS_MAX = 20 * 1024 * 1024;
const RESULTAT_MAX = 200 * 1024 * 1024;
const GARDE_MS = 24 * 3600e3;
const ENTREE = /^[0-9a-f]{48}\.(mp4|png|jpg)$/;
const ID = /^[0-9a-f]{24}$/;
const VIDEO_PREFIXE = '/studio/wan-clip/';
/* fal sert ses resultats sur ses CDN (*.fal.media) ; rien d'autre n'est telecharge. */
const HOTES = [/(^|\.)fal\.media$/i, /(^|\.)fal\.run$/i];
const DELAI_MS = 30000;

/** L'estimation : images × prix ÷ 16, au millieme. */
function prixUsd(resolution, images) {
  const p = PRIX[resolution]; const n = Number(images);
  if (!(p > 0) || !(n > 0)) return null;
  return Math.round(p * n / IMAGES_PAR_SECONDE_FACTUREE * 1000) / 1000;
}

const lance_ = (bin, args, ms) => new Promise((res, rej) => execFile(bin, args, { timeout: ms || 120000, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => (e ? rej(Object.assign(e, { err: String(err || '').slice(-300) })) : res(String(out || '')))));

/**
 * deps : { dossier, cle() → FAL_KEY, urlPublique(nom), imageDefaut (URL https),
 *          journal(o), fetch?, ffmpeg?, ffprobe?, maintenant?, pollMs?, maxMs?, httpPermis? }
 */
function cree(deps) {
  const dossier = deps.dossier;
  const cle = () => String((deps.cle ? deps.cle() : process.env.FAL_KEY) || '').trim();
  const chercher = deps.fetch || ((u, o) => fetch(u, Object.assign({ signal: AbortSignal.timeout(DELAI_MS) }, o || {})));
  const ffmpeg = deps.ffmpeg || 'ffmpeg', ffprobe = deps.ffprobe || 'ffprobe';
  const temps = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const POLL = deps.pollMs != null ? Math.max(1, Number(deps.pollMs)) : 10000;
  /* 30 min : fal annonce une file sans limite ; pas encore de mesure d'attente. */
  const MAX = deps.maxMs != null ? Number(deps.maxMs) : 30 * 60e3;
  const actif = () => !!cle();
  const note = (o) => { try { if (deps.journal) deps.journal(o); } catch (e) { /* jamais bloquant */ } };
  const JOBS = new Map();
  const propre = (m) => { let s = String(m || '').replace(/[\u0000-\u001f]/g, ' '); const k = cle(); if (k) s = s.split(k).join('[key]'); return s.slice(0, 200); };

  try {
    for (const f of fs.readdirSync(dossier)) {
      const p = path.join(dossier, f);
      if (ENTREE.test(f) || /\.orig\.mp4$/.test(f) || /\.tmp\.mp4$/.test(f)) fs.unlinkSync(p);
      else if (/\.final\.mp4$/.test(f) && temps() - fs.statSync(p).mtimeMs > GARDE_MS) fs.unlinkSync(p);
    }
  } catch (e) { /* pas encore de dossier */ }

  const efface = (...noms) => { for (const n of noms) if (n) try { fs.unlinkSync(path.join(dossier, n)); } catch (e) { /* deja parti */ } };
  const effaceEntrees = (job) => { efface(job.clip, job.image, job.orig); job.clip = job.image = job.orig = null; };

  async function falJson(url, o) {
    const r = await chercher(url, Object.assign({}, o, { headers: Object.assign({ authorization: 'Key ' + cle(), 'content-type': 'application/json' }, (o && o.headers) || {}) }));
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok) {
      const m = j && (j.detail ? (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)) : (j.error || j.message));
      const e = new Error(propre(m || ('HTTP ' + r.status))); e.statut = r.status; throw e;
    }
    return j;
  }
  const deFal = (u, repli) => (typeof u === 'string' && u.startsWith(QUEUE + '/') ? u : repli);

  function fin(job, statut, message, extra) {
    effaceEntrees(job);
    job.statut = statut; job.message = message || null;
    note(Object.assign({ id: job.id, moteur: 'wan', rid: job.rid, statut, message: job.message, secondes: Math.round((temps() - job.t) / 100) / 10 }, extra || {}));
  }

  /** Un pas de suivi : statut fal, puis resultat, telechargement et son. */
  async function avance(job) {
    if (!['queued', 'processing'].includes(job.statut) || job.occupe) return job;
    job.occupe = true;
    try {
      let s = null;
      try { s = await falJson(job.statusUrl, { method: 'GET' }); } catch (e) { s = null; job.derniere = e.message; }
      if (s && s.status === 'COMPLETED') {
        if (s.error) return fin(job, 'failed', 'fal: ' + propre(s.error) + (s.error_type ? ' (' + propre(s.error_type) + ')' : '')), job;
        job.statut = 'muxing';
        let sortie;
        try { sortie = await falJson(job.responseUrl, { method: 'GET' }); }
        catch (e) { return fin(job, 'failed', 'fal result: ' + e.message), job; }
        const url = sortie && sortie.video && sortie.video.url;
        job.urlFal = typeof url === 'string' && /^https:\/\//.test(url) ? url.slice(0, 2000) : null;
        if (!job.urlFal) return fin(job, 'failed', 'fal answered without a video URL'), job;
        await assemble(job);
        return job;
      }
      if (s && s.status === 'IN_PROGRESS') job.statut = 'processing';
      if (temps() - job.t > MAX) fin(job, 'timeout', 'no result from fal after ' + Math.round(MAX / 60000) + ' min — inputs deleted');
      return job;
    } finally { job.occupe = false; }
  }

  /* Le resultat muet de fal + le son du clip d'origine → le fichier final. */
  async function assemble(job) {
    const brut = job.id + '.tmp.mp4', final = job.id + '.final.mp4';
    try {
      const b = await telechargeSur(job.urlFal, { fetch: deps.fetchCdn || chercher, hoteOk: (h) => (deps.hoteOk || ((x) => HOTES.some((re) => re.test(x))))(h),
                                                   httpPermis: !!deps.httpPermis, max: RESULTAT_MAX, delaiMs: 120000 });
      fs.writeFileSync(path.join(dossier, brut), b);
    } catch (e) { efface(brut); return fin(job, 'failed', 'could not download the fal result: ' + propre(e.message), { urlFal: job.urlFal }); }
    let son = false;
    try {
      if (job.garderSon) {
        /* -map 1:a:0? : la piste son du clip d'origine si elle existe ; -shortest : meme longueur */
        await lance_(ffmpeg, ['-v', 'error', '-y', '-i', path.join(dossier, brut), '-i', path.join(dossier, job.orig), '-map', '0:v:0', '-map', '1:a:0?',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', path.join(dossier, final)], 120000);
        /* sans ffprobe, on ne sait pas : null, jamais « pas de son » a tort */
        const sonde = await lance_(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(dossier, final)], 30000).catch(() => null);
        son = sonde === null ? null : /audio/.test(sonde);
      } else fs.renameSync(path.join(dossier, brut), path.join(dossier, final));
    } catch (e) { efface(brut, final); return fin(job, 'failed', 'could not put the sound back: ' + propre(e.err || e.message), { urlFal: job.urlFal }); }
    efface(brut);
    job.final = final; job.son = son;
    fin(job, 'succeeded', job.garderSon && son === false ? 'the original clip has no sound track' : null, { urlFal: job.urlFal, son });
  }

  function suit(job) {
    const tour = async () => { await avance(job).catch(() => {}); if (['queued', 'processing'].includes(job.statut)) setTimeout(tour, POLL).unref(); };
    setTimeout(tour, POLL).unref();
  }

  /**
   * Lance UN remplacement pour `addr` (la SESSION). Controles avant tout envoi :
   * adresse, taille, MP4, 3-10 s, image (PNG/JPEG, 300 px), un a la fois, cle,
   * ffmpeg ; puis reechantillonnage a 16 i/s et estimation sur les images reelles.
   */
  async function lance({ addr, octets, image, resolution, garderSon }) {
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    const buf = Buffer.isBuffer(octets) ? octets : Buffer.alloc(0);
    if (!buf.length) return { ok: false, code: 400, raison: 'choose an MP4 clip first' };
    if (buf.length > OCTETS_MAX) return { ok: false, code: 413, raison: 'the clip is ' + (buf.length / 1048576).toFixed(1) + ' MB — ' + (OCTETS_MAX / 1048576) + ' MB max' };
    const d = dureeMp4(buf);
    if (d == null) return { ok: false, code: 400, raison: 'not an MP4 video (or its length could not be read)' };
    if (d < DUREE.min || d > DUREE.max) return { ok: false, code: 400, raison: 'the clip is ' + d.toFixed(2) + ' s long — ' + DUREE.min + ' to ' + DUREE.max + ' s for this test' };
    const res = PRIX[resolution] ? resolution : '720p';
    let img = null;
    if (image != null && image !== '') {
      const m = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(String(image));
      if (!m) return { ok: false, code: 400, raison: 'the reference must be a PNG or JPEG picture' };
      img = Buffer.from(String(image).slice(m[0].length), 'base64');
      if (img.length > 6 * 1024 * 1024) return { ok: false, code: 413, raison: 'the reference picture is too large (6 MB max)' };
      const dim = K.dimensionsImage(img);
      if (!dim) return { ok: false, code: 400, raison: 'the reference must be a PNG or JPEG picture' };
      if (Math.min(dim.largeur, dim.hauteur) < 300) return { ok: false, code: 400, raison: 'the reference is ' + dim.largeur + '×' + dim.hauteur + ' px — 300 px at least on each side' };
      img = { octets: img, ext: dim.format === 'png' ? 'png' : 'jpg' };
    }
    for (const j of JOBS.values()) if (j.addr === addr && ['queued', 'processing', 'muxing', 'prep'].includes(j.statut)) return { ok: false, code: 429, raison: 'one Wan edit at a time — wait for the current one' };
    if (!actif()) return { ok: false, code: 503, raison: 'fal is not set up (FAL_KEY)' };
    try { await lance_(ffmpeg, ['-version'], 10000); }
    catch (e) { return { ok: false, code: 503, raison: 'ffmpeg is missing on the server (needed for 16 fps and the sound)' }; }

    const id = crypto.randomBytes(12).toString('hex');
    const job = { id, addr, t: temps(), statut: 'prep', dureeS: Math.round(d * 1000) / 1000, resolution: res, garderSon: garderSon !== false,
                  orig: id + '.orig.mp4', clip: crypto.randomBytes(24).toString('hex') + '.mp4', image: null, rid: null };
    JOBS.set(id, job);
    const echec = (code, raison) => { effaceEntrees(job); JOBS.delete(id); return { ok: false, code, raison }; };
    try {
      fs.mkdirSync(dossier, { recursive: true });
      fs.writeFileSync(path.join(dossier, job.orig), buf);
      if (img) { job.image = crypto.randomBytes(24).toString('hex') + '.' + img.ext; fs.writeFileSync(path.join(dossier, job.image), img.octets); }
    } catch (e) { console.error('[wan] ' + e.message); return echec(500, 'the server could not store the clip'); }
    /* 16 i/s, sans son (fal ne le rend pas), H.264 lisible partout */
    /* H.264 si ffmpeg a libx264 (le paquet Alpine du Dockerfile l'a), sinon MPEG-4 part 2 (natif a ffmpeg). */
    const reech = (codec) => lance_(ffmpeg, ['-v', 'error', '-y', '-i', path.join(dossier, job.orig), '-vf', 'fps=' + FPS, '-an'].concat(codec,
      ['-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dossier, job.clip)]), 120000);
    try { await reech(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17']); }
    catch (e1) {
      try { await reech(['-c:v', 'mpeg4', '-q:v', '2']); }
      catch (e) { return echec(400, 'ffmpeg could not read this clip: ' + propre(e.err || e.message)); }
    }
    let images = null;
    try {
      const out = await lance_(ffprobe, ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path.join(dossier, job.clip)], 30000);
      images = parseInt(out, 10);
    } catch (e) { images = null; }
    if (!(images > 0)) { const d2 = dureeMp4(fs.readFileSync(path.join(dossier, job.clip))); images = d2 ? Math.ceil(d2 * FPS) : Math.ceil(d * FPS); }
    job.images = images;
    job.estimationUsd = prixUsd(res, images);
    const corps = { video_url: deps.urlPublique(job.clip), image_url: job.image ? deps.urlPublique(job.image) : deps.imageDefaut, resolution: res };
    let r;
    try { r = await falJson(QUEUE + '/' + MODELE, { method: 'POST', body: JSON.stringify(corps) }); }
    catch (e) { return echec(502, 'fal refused: ' + e.message); }
    if (!r || !r.request_id) return echec(502, 'fal returned no request id');
    job.rid = String(r.request_id).slice(0, 80);
    const enc = encodeURIComponent(job.rid);
    job.statusUrl = deFal(r.status_url, QUEUE + '/' + MODELE + '/requests/' + enc + '/status');
    job.responseUrl = deFal(r.response_url, QUEUE + '/' + MODELE + '/requests/' + enc);
    job.statut = 'queued';
    /* accepte par fal, donc facture : ecrit tout de suite */
    note({ id, moteur: 'wan', modele: 'wan-2.2-animate-replace', rid: job.rid, edition: true, dureeS: job.dureeS, resolution: res, images, fps: FPS,
           image: job.image ? 'upload' : 'swoge', octets: buf.length, estimationUsd: job.estimationUsd, garderSon: job.garderSon });
    suit(job);
    return { ok: true, id, statut: 'queued', moteur: 'wan', resolution: res, dureeS: job.dureeS, images, estimationUsd: job.estimationUsd, reference: job.image ? 'upload' : 'swoge' };
  }

  /** L'etat d'un remplacement, pour SON adresse seulement. */
  function etat(id, addr) {
    const j = ID.test(String(id || '')) ? JOBS.get(String(id)) : null;
    if (!j || j.addr !== addr) return { ok: false, code: 404, raison: 'unknown edit' };
    return { ok: true, id: j.id, moteur: 'wan', statut: j.statut === 'prep' ? 'queued' : j.statut, message: j.message || null, dureeS: j.dureeS, images: j.images,
             resolution: j.resolution, estimationUsd: j.estimationUsd, son: j.statut === 'succeeded' ? j.son : null,
             video: j.statut === 'succeeded' && j.final ? '/studio/kling/wan/' + j.id + '/video' : null };
  }

  /** Le suivi demande par la page : un pas tout de suite (sans attendre le tour de fond), puis l'etat. */
  async function rafraichit(id, addr) {
    const j = ID.test(String(id || '')) ? JOBS.get(String(id)) : null;
    if (j && j.addr === addr) await avance(j).catch(() => {});
    return etat(id, addr);
  }

  /** Le resultat final (avec le son), pour le proprietaire qui l'a lance. */
  function resultat(id, addr) {
    const j = ID.test(String(id || '')) ? JOBS.get(String(id)) : null;
    if (!j || j.addr !== addr || !j.final) return null;
    try { return { octets: fs.readFileSync(path.join(dossier, j.final)), type: 'video/mp4' }; } catch (e) { return null; }
  }

  /** Une entree EN COURS (clip 16 i/s ou image), par son nom : ce que fal lit. */
  function fichier(nom) {
    const n = String(nom || '');
    if (!ENTREE.test(n)) return null;
    let ok = false;
    for (const j of JOBS.values()) if (['queued', 'processing', 'prep'].includes(j.statut) && (j.clip === n || j.image === n)) ok = true;
    if (!ok) return null;
    try { return { octets: fs.readFileSync(path.join(dossier, n)), type: n.endsWith('.mp4') ? 'video/mp4' : n.endsWith('.png') ? 'image/png' : 'image/jpeg' }; }
    catch (e) { return null; }
  }

  function vue(addr) {
    return { modele: MODELE, actif: actif(), prixParSeconde: PRIX, fps: FPS, imagesParSecondeFacturee: IMAGES_PAR_SECONDE_FACTUREE, dureeMinS: DUREE.min, dureeMaxS: DUREE.max,
             octetsMax: OCTETS_MAX, enCours: [...JOBS.values()].filter((j) => j.addr === addr && ['queued', 'processing', 'muxing'].includes(j.statut)).map((j) => j.id) };
  }

  return { actif, lance, etat, rafraichit, resultat, fichier, vue, avance, JOBS };
}

module.exports = { cree, prixUsd, MODELE, QUEUE, PRIX, FPS, OCTETS_MAX, VIDEO_PREFIXE, ENTREE, HOTES };
