'use strict';
/* ==========================================================================
 * KLING O1 — UNE VIDEO ENTIERE, DECOUPEE EN MORCEAUX (14 octobre 2026)
 *
 * Demande du proprietaire, 14/10/2026, apres l'essai reussi sur un clip de 8 s
 * (kling_edition.js) : faire la meme chose sur un clip ENTIER (ex. 94 s,
 * 720×1280, ~30 i/s, telephone). Kling O1 n'edite que 3 a 10 s par tache
 * (video-omni.md, lu le 14/10/2026) : le serveur coupe, envoie chaque morceau
 * avec les MEMES references et le MEME texte, recolle, et remet la piste son
 * d'ORIGINE sur le tout.
 *
 * ---- LE DECOUPAGE (coupes(), ffmpeg du Dockerfile) ----
 *   - Les changements de plan d'abord (filtre `select='gt(scene,0.3)'`) : une
 *     coupure de Kling tombe sur une coupure du montage, invisible. A defaut,
 *     des morceaux egaux de 9,5 s au plus (0,5 s de marge sous les 10 s de la
 *     doc). Jamais un morceau de moins de 3 s : une coupure de plan qui
 *     laisserait moins de 3 s d'un cote est ignoree.
 *   - Les coupures sont posees sur la grille des images (k / i/s) et chaque
 *     morceau est reencode en H.264 par son propre ffmpeg (recherche avant
 *     -i, exacte avec un reencodage) : coupure a l'image pres.
 *   - i/s : celle de la source arrondie si elle est dans 24-60 (bornes de la
 *     doc), sinon 30 ; toujours constante (une video de telephone est souvent
 *     a frequence variable). Cotes ramenees dans 700-2160 px si besoin.
 *
 * ---- LE PRIX, AVANT DE PAYER ----
 *   Grille « Kling O1, With Video Input » (pricing/base/video.md, lu le
 *   14/10/2026) : 0,126 $/s en 720p, 0,168 $/s en 1080p ; on compte au pire la
 *   seconde entamee de CHAQUE morceau (somme des ceil). Un plafond par passe :
 *   20 $ par defaut, KLING_ENTIER_PLAFOND_USD ne peut que l'abaisser. Le plan
 *   (nombre de morceaux, longueurs, prix au pire) est montre ; rien ne part
 *   sans le clic de confirmation, qui renvoie le prix montre (un plan qui
 *   aurait change est refuse). Le plafond couvre aussi les relances.
 *
 * ---- L'ENVOI ----
 *   Au plus KLING_ENTIER_PARALLELE morceaux a la fois (2 par defaut : la
 *   concurrence depend du pack, concurrency-rules.md). Un refus 1302 (trop de
 *   requetes) ou 1303 (concurrence du pack depassee) n'est pas un echec : le
 *   morceau attend (15 s, doublees jusqu'a 2 min, comme le conseille la doc)
 *   et repart. Un morceau rate se relance seul, au clic, sans refaire les autres.
 *
 * ---- LA FIN ----
 *   Resultats telecharges seulement depuis *.klingai.com (la doc montre
 *   p2-kling.klingai.com ; KLING_CDN_HOTES ajoute des domaines sans changer le
 *   code), 200 Mo au plus (telecharge_sur.js). Chaque resultat est ramene a la
 *   longueur EXACTE de son morceau source (prolonge ou coupe), puis tout est
 *   reencode a un format, une taille et une i/s uniques et recolle ; la piste
 *   son d'origine est posee sur l'ensemble, a la longueur d'origine : le
 *   mouvement des levres reste cale sur le son.
 *   Le resultat ne sort qu'avec la session du proprietaire qui l'a lance ; il
 *   est garde 48 h. Les morceaux et resultats intermediaires sont effaces a la
 *   fin ; au demarrage, les restes aussi.
 *
 * ---- LE REDEMARRAGE ----
 *   Railway redemarre a chaque poussee : l'etat d'une passe est ecrit sur le
 *   disque (etat.json, ecriture atomique) a chaque changement. Au demarrage,
 *   le suivi des taches deja soumises reprend par leur id Kling ; un morceau
 *   coupe ENTRE l'envoi et l'ecriture de l'id est retrouve par notre
 *   identifiant externe (external_task_ids) avant d'etre renvoye — jamais payé
 *   deux fois sans le savoir.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { telechargeSur } = require('./telecharge_sur');
const K = require('./kling');

/* 9,5 s : 0,5 s de marge sous les 10 s de la doc (une coupure posee sur la
   grille des images peut allonger un morceau d'une image). */
const DECOUPE = { min: K.EDITION_DUREE.min, max: K.EDITION_DUREE.max, cible: 9.5 };
const SCENE_SEUIL = 0.3;
const PLAFOND_USD = 20;
const PARALLELE = 2;
/* 100 Mo, 180 s : le proprietaire parle de ~120 s / ~60 Mo ; au-dela, le
   plafond de 20 $ refuserait de toute facon en 1080p (180 s × 0,168 = 30 $). */
const ENTREE_OCTETS_MAX = 100 * 1024 * 1024;
const DUREE_ENTIER_MAX = 180;
const RESULTAT_MAX = 200 * 1024 * 1024;
const GARDE_MS = 48 * 3600e3;
/* 20 min par morceau : la meme borne que l'edition d'un clip (kling_edition.js). */
const MORCEAU_MAX_MS = 20 * 60e3;
const ATTENTE_LIMITE_MS = { depart: 15000, max: 120000 };
const LIMITE_ESSAIS_MAX = 40;
const FPS_REPLI = 30;
const FPS_BORNES = { min: 24, max: 60 };
const NOM = /^[0-9a-f]{48}\.mp4$/;
const ID = /^[0-9a-f]{24}$/;
const VIDEO_PREFIXE = '/studio/kling-entier-clip/';
const HOTES = [/(^|\.)klingai\.com$/i];
/* Codes Kling qui disent « pas maintenant », pas « non » (error-codes.md, 14/10/2026). */
const CODES_LIMITE = [1302, 1303];

const arrondi3 = (x) => Math.round(x * 1000) / 1000;

/** Le plafond d'une passe : l'environnement ne peut que l'abaisser. */
function plafondUsd(env) {
  const v = Number(env);
  return v > 0 && v < PLAFOND_USD ? v : PLAFOND_USD;
}
/** Le nombre de morceaux envoyes a la fois (1 a 8). */
function parallele(env) {
  const v = parseInt(env, 10);
  return v >= 1 && v <= 8 ? v : PARALLELE;
}
/** Les hotes permis pour les resultats : *.klingai.com, plus KLING_CDN_HOTES (domaines separes par des virgules). */
function hotesPermis(env) {
  const plus = String(env || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x));
  return (h) => { const n = String(h || '').toLowerCase(); return HOTES.some((re) => re.test(n)) || plus.some((d) => n === d || n.endsWith('.' + d)); };
}

/**
 * Les morceaux d'une video de `duree` s, d'apres les instants de changement de
 * plan `scenes` (s). Rend [{ debut, duree }] qui couvrent exactement [0, duree].
 * Glouton : de la ou on en est, la coupure de plan la PLUS LOIN dans
 * ]debut+min, debut+cible] qui laisse au moins `min` s derriere elle ; a
 * defaut, le reste en parts egales (ceil(reste / cible) parts), dont on prend
 * la premiere. `fps` pose chaque coupure sur la grille des images.
 */
function coupes(duree, scenes, o) {
  o = Object.assign({}, DECOUPE, o || {});
  const D = Number(duree);
  if (!(D >= o.min)) return null;
  const grille = (t) => (o.fps > 0 ? Math.round(t * o.fps) / o.fps : t);
  const sc = (scenes || []).map(Number).filter((x) => x > 0 && x < D).sort((a, b) => a - b);
  const bornes = [0];
  let debut = 0;
  for (let garde = 0; D - debut > o.cible && garde < 1000; garde++) {
    const candidats = sc.map(grille).filter((t) => t - debut >= o.min && t - debut <= o.cible && D - t >= o.min);
    let t = candidats.length ? candidats[candidats.length - 1] : null;
    if (t === null) {
      const reste = D - debut, n = Math.ceil(reste / o.cible);
      t = grille(debut + reste / n);
      /* la grille ne doit pas faire sortir des bornes */
      if (t - debut > o.cible) t -= 1 / o.fps;
    }
    bornes.push(t); debut = t;
  }
  bornes.push(D);
  const r = [];
  /* bornes arrondies d'abord : les durees se suivent exactement (somme = duree) */
  const b = bornes.map(arrondi3);
  for (let i = 0; i + 1 < b.length; i++) r.push({ debut: b[i], duree: arrondi3(b[i + 1] - b[i]) });
  return r;
}

/** Le prix au pire : somme des secondes entamees × prix O1 de la resolution, ou null. */
function prixPire(durees, resolution) {
  const p = K.EDITION_PRIX[resolution];
  if (!(p > 0) || !Array.isArray(durees) || !durees.length) return null;
  let s = 0;
  for (const d of durees) { const x = K.prixEdition(resolution, d); if (x === null) return null; s += x; }
  return arrondi3(s);
}

/** L'i/s de sortie : celle de la source arrondie si elle est dans 24-60, sinon 30. */
function fpsSortie(fps) {
  const f = Number(fps);
  return f >= FPS_BORNES.min - 0.5 && f <= FPS_BORNES.max + 0.5 ? Math.min(FPS_BORNES.max, Math.max(FPS_BORNES.min, Math.round(f))) : FPS_REPLI;
}

/** Les cotes envoyees a Kling (700-2160 px par cote, paires), ou null si le rapport l'interdit. */
function cotesSortie(l, h) {
  l = Number(l); h = Number(h);
  if (!(l > 0 && h > 0)) return null;
  const C = K.EDITION_COTE;
  let s = 1;
  if (Math.min(l, h) * s < C.min) s = C.min / Math.min(l, h);
  if (Math.max(l, h) * s > C.max) s = C.max / Math.max(l, h);
  const pair = (x) => 2 * Math.round(x / 2);
  const L = pair(l * s), H = pair(h * s);
  if (Math.min(L, H) < C.min || Math.max(L, H) > C.max) return null;
  return { largeur: L, hauteur: H, change: L !== l || H !== h };
}

const executer = (bin, args, ms) => new Promise((res, rej) => execFile(bin, args, { timeout: ms || 600000, maxBuffer: 16 * 1024 * 1024 },
  (e, out, err) => (e ? rej(Object.assign(e, { err: String(err || '').slice(-400) })) : res({ out: String(out || ''), err: String(err || '') }))));

/**
 * deps : { dossier, kling, urlPublique(nom), imagesDefaut ([corps, visage], URL https)
 *          ou imageDefaut, journal(o),
 *          ffmpeg?, ffprobe?, fetchCdn?, hoteOk?, httpPermis?, maintenant?,
 *          plafondUsd?, parallele?, pollMs?, morceauMaxMs?, attenteLimiteMs? }
 */
function cree(deps) {
  const dossier = deps.dossier;
  const kling = deps.kling;
  const ffmpeg = deps.ffmpeg || 'ffmpeg', ffprobe = deps.ffprobe || 'ffprobe';
  const temps = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const PLAFOND = deps.plafondUsd != null ? plafondUsd(deps.plafondUsd) : plafondUsd(process.env.KLING_ENTIER_PLAFOND_USD);
  const PAR = deps.parallele != null ? parallele(deps.parallele) : parallele(process.env.KLING_ENTIER_PARALLELE);
  const POLL = deps.pollMs != null ? Math.max(1, Number(deps.pollMs)) : 10000;
  const MORCEAU_MAX = deps.morceauMaxMs != null ? Number(deps.morceauMaxMs) : MORCEAU_MAX_MS;
  const ATTENTE = Object.assign({}, ATTENTE_LIMITE_MS, deps.attenteLimiteMs || {});
  const hoteOk = deps.hoteOk || hotesPermis(process.env.KLING_CDN_HOTES);
  const note = (o) => { try { if (deps.journal) deps.journal(o); } catch (e) { /* jamais bloquant */ } };
  const DEFAUT = Array.isArray(deps.imagesDefaut) && deps.imagesDefaut.length ? deps.imagesDefaut.slice(0, K.EDITION_IMAGES_MAX) : [deps.imageDefaut];
  const JETONS = { swoge: DEFAUT[0], 'swoge-face': DEFAUT[1] };
  const propre = (m) => String(m || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 240);
  /* par id de passe */
  const PASSES = new Map();
  let minuteur = null, tourEnCours = null;
  /* les envois en vol DANS CE PROCESSUS : un morceau « envoi » qui n'y est pas
     vient d'avant un redemarrage, et seulement lui est cherche par son id externe */
  const EN_VOL = new Set();

  const rep = (id) => path.join(dossier, id);
  const fic = (P, nom) => path.join(rep(P.id), nom);
  const efface = (P, nom) => { if (nom) try { fs.unlinkSync(fic(P, nom)); } catch (e) { /* deja parti */ } };
  function ecrit(P) {
    const s = Object.assign({}, P); delete s.travail;
    const f = fic(P, 'etat.json'), t = f + '.tmp';
    try { fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, f); }
    catch (e) { console.error('[kling-entier] etat non ecrit : ' + e.message); }
  }
  const ACTIFS = ['decoupe', 'en_cours', 'assemblage'];

  /* ---- au demarrage : relire, purger, reprendre ---- */
  function relit() {
    let noms = [];
    try { noms = fs.readdirSync(dossier); } catch (e) { return; }
    for (const n of noms) {
      const d = path.join(dossier, n);
      if (!ID.test(n)) continue;
      let P = null;
      try { P = JSON.parse(fs.readFileSync(path.join(d, 'etat.json'), 'utf8')); } catch (e) { P = null; }
      if (!P || P.id !== n || temps() - Number(P.t) > GARDE_MS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* rien */ } continue; }
      /* les restes d'une ecriture coupee */
      try { for (const f of fs.readdirSync(d)) if (/\.tmp$|\.part$/.test(f) || /^seg_\d+\.mp4$/.test(f)) fs.unlinkSync(path.join(d, f)); } catch (e) { /* rien */ }
      if (P.statut === 'decoupe') { P.statut = 'erreur'; P.message = 'the server restarted while cutting — upload the video again'; }
      if (['fini', 'erreur', 'abandon'].includes(P.statut)) nettoie(P);
      P.travail = null;
      PASSES.set(P.id, P);
      ecrit(P);
    }
  }

  /** Efface tout ce qui n'est pas le resultat final ni l'etat. */
  function nettoie(P) {
    let fs_ = [];
    try { fs_ = fs.readdirSync(rep(P.id)); } catch (e) { return; }
    for (const f of fs_) if (f !== 'etat.json' && f !== P.final) efface(P, f);
    for (const s of P.segments || []) { s.fichier = null; s.resultat = null; }
    P.images = (P.images || []).map((im) => (im.type === 'fichier' ? { type: 'efface', format: im.format } : im));
  }

  /* ---- ffprobe ---- */
  async function sonde(chemin) {
    const { out } = await executer(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate',
      '-of', 'json', chemin], 60000);
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    const a = (j.streams || []).some((s) => s.codec_type === 'audio');
    const frac = (x) => { const m = /^(\d+)\/(\d+)$/.exec(String(x || '')); return m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN; };
    let fps = frac(v && v.avg_frame_rate); if (!(fps > 0)) fps = frac(v && v.r_frame_rate);
    return { duree: Number(j.format && j.format.duration), largeur: v ? Number(v.width) : 0, hauteur: v ? Number(v.height) : 0, fps: fps > 0 ? fps : null, son: a, video: !!v };
  }

  /** Les instants de changement de plan (filtre scene de ffmpeg, image reduite : seul le score compte). */
  async function scenes(chemin) {
    const { err } = await executer(ffmpeg, ['-hide_banner', '-nostats', '-i', chemin, '-an', '-sn',
      '-vf', "scale=160:-2,select='gt(scene," + SCENE_SEUIL + ")',showinfo", '-f', 'null', '-'], 600000);
    const t = [];
    const re = /pts_time:\s*([0-9.]+)/g; let m;
    while ((m = re.exec(err))) t.push(Number(m[1]));
    return t;
  }

  /* ---- 1. le televersement et le plan ---- */

  /**
   * Recoit le flux de la requete dans un fichier, `max` octets au plus. Le
   * proprietaire est verifie AVANT par la route ; rien n'est lu sinon.
   */
  function recoit(flux, chemin, max) {
    return new Promise((res, rej) => {
      let n = 0, fini = false;
      const sortie = fs.createWriteStream(chemin);
      const stop = (e) => { if (fini) return; fini = true; sortie.destroy(); try { fs.unlinkSync(chemin); } catch (x) { /* rien */ } rej(e); };
      flux.on('data', (c) => { n += c.length; if (n > max) { stop(Object.assign(new Error('too large'), { trop: true })); try { flux.destroy(); } catch (e) { /* rien */ } return; } if (!sortie.write(c)) { flux.pause(); sortie.once('drain', () => flux.resume()); } });
      flux.on('end', () => { if (fini) return; sortie.end(() => { if (fini) return; fini = true; res(n); }); });
      flux.on('error', stop);
      sortie.on('error', stop);
    });
  }

  /**
   * Une nouvelle passe pour `addr` (la SESSION) a partir du flux `flux` (le
   * corps brut, video/mp4). Rend { ok, id, statut: 'decoupe' } tout de suite ;
   * le decoupage tourne en fond (la page suit par etat()).
   */
  async function cree_(addr, flux, octetsAnnonces) {
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    if (Number(octetsAnnonces) > ENTREE_OCTETS_MAX) return { ok: false, code: 413, raison: 'the video is ' + (Number(octetsAnnonces) / 1048576).toFixed(1) + ' MB — ' + (ENTREE_OCTETS_MAX / 1048576) + ' MB max' };
    for (const P of PASSES.values()) {
      if (P.addr !== addr) continue;
      if (ACTIFS.includes(P.statut) || P.statut === 'incomplet') return { ok: false, code: 429, raison: 'a whole-video edit is already running — wait for it (or retry its failed parts)' };
    }
    /* un plan non lance (ou rate) du meme proprietaire est remplace */
    for (const P of [...PASSES.values()]) if (P.addr === addr && ['pret', 'erreur', 'abandon'].includes(P.statut)) supprime(P);
    try { await executer(ffmpeg, ['-version'], 10000); await executer(ffprobe, ['-version'], 10000); }
    catch (e) { return { ok: false, code: 503, raison: 'ffmpeg is missing on the server (needed to cut and glue the video)' }; }
    const id = crypto.randomBytes(12).toString('hex');
    const P = { id, addr, t: temps(), statut: 'decoupe', message: null, source: null, fps: null, cotes: null, segments: [], resolution: null,
                prompt: null, images: [], prixPlan: null, depenseMaxUsd: 0, final: null, tFin: null };
    try { fs.mkdirSync(rep(id), { recursive: true }); }
    catch (e) { return { ok: false, code: 500, raison: 'the server could not store the video' }; }
    let n;
    try { n = await recoit(flux, fic(P, 'orig.mp4'), ENTREE_OCTETS_MAX); }
    catch (e) { try { fs.rmSync(rep(id), { recursive: true, force: true }); } catch (x) { /* rien */ } return e.trop ? { ok: false, code: 413, raison: 'the video is larger than ' + (ENTREE_OCTETS_MAX / 1048576) + ' MB' } : { ok: false, code: 400, raison: 'upload interrupted' }; }
    if (!n) { try { fs.rmSync(rep(id), { recursive: true, force: true }); } catch (x) { /* rien */ } return { ok: false, code: 400, raison: 'choose a video first' }; }
    P.octets = n;
    PASSES.set(id, P); ecrit(P);
    P.travail = decoupe(P).catch((e) => { P.statut = 'erreur'; P.message = 'cutting failed: ' + propre(e.err || e.message); nettoie(P); ecrit(P); })
      .finally(() => { P.travail = null; });
    return { ok: true, id, statut: 'decoupe' };
  }

  async function decoupe(P) {
    const orig = fic(P, 'orig.mp4');
    let s;
    try { s = await sonde(orig); } catch (e) { s = null; }
    const refuse = (m) => { P.statut = 'erreur'; P.message = m; efface(P, 'orig.mp4'); ecrit(P); };
    if (!s || !s.video || !(s.duree > 0)) return refuse('not a video ffmpeg can read');
    if (s.duree < DECOUPE.min) return refuse('the video is ' + s.duree.toFixed(2) + ' s long — ' + DECOUPE.min + ' s at least');
    if (s.duree > DUREE_ENTIER_MAX) return refuse('the video is ' + s.duree.toFixed(1) + ' s long — ' + DUREE_ENTIER_MAX + ' s at most');
    const cotes = cotesSortie(s.largeur, s.hauteur);
    if (!cotes) return refuse('the video is ' + s.largeur + '×' + s.hauteur + ' px — too narrow for Kling (700 to 2160 px per side)');
    const F = fpsSortie(s.fps);
    P.source = { duree: arrondi3(s.duree), largeur: s.largeur, hauteur: s.hauteur, fps: s.fps ? Math.round(s.fps * 100) / 100 : null, son: s.son };
    P.fps = F; P.cotes = cotes;
    let sc = [];
    try { sc = await scenes(orig); } catch (e) { sc = []; }
    const plan = coupes(s.duree, sc, { fps: F });
    /* Un ffmpeg par morceau, recherche AVANT -i : avec un reencodage, ffmpeg
       decode depuis l'image cle precedente et jette ce qui precede `debut` —
       coupure a l'image pres (mesure du 14/10/2026 sur 30 i/s : 6,033 s →
       181 images, 7,367 s → 221). Le muxer `segment` d'une seule passe a ete
       essaye d'abord : il a saute une coupure (decalage de 0,066 s du depart
       de la piste video) — ecarte. */
    const segs = [];
    const effaceTout = () => { for (const x of segs) efface(P, x.fichier); };
    for (let i = 0; i < plan.length; i++) {
      const nom = crypto.randomBytes(24).toString('hex') + '.mp4';
      const args = ['-v', 'error', '-y', '-ss', plan[i].debut.toFixed(3), '-i', orig, '-t', plan[i].duree.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', 'fps=' + F + (cotes.change ? ',scale=' + cotes.largeur + ':' + cotes.hauteur : '') + ',setsar=1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', fic(P, nom + '.part')];
      try { await executer(ffmpeg, args, 10 * 60e3); fs.renameSync(fic(P, nom + '.part'), fic(P, nom)); }
      catch (e) { efface(P, nom + '.part'); effaceTout(); return refuse('ffmpeg could not cut part ' + (i + 1) + ': ' + propre(e.err || e.message)); }
      let d = null;
      try { d = (await sonde(fic(P, nom))).duree; } catch (e) { d = null; }
      /* la duree du conteneur (son compris), au millieme : ce que Kling mesurera */
      d = d ? arrondi3(d) : null;
      if (!(d >= DECOUPE.min && d <= DECOUPE.max)) {
        efface(P, nom); effaceTout();
        return refuse('part ' + (i + 1) + ' came out at ' + (d ? d.toFixed(2) + ' s' : 'an unreadable length') + ' — outside Kling\'s 3–10 s');
      }
      segs.push({ i, debut: plan[i].debut, duree: d, dureePlan: plan[i].duree, fichier: nom, statut: 'plan',
                  rid: null, externe: null, essais: 0, limites: 0, reessaiA: null, message: null, url: null, resultat: null, estimationUsd: null, facturation: null, t0: null, t1: null });
    }
    P.segments = segs;
    P.scenes = sc.length;
    P.prixPlan = { '720p': prixPire(segs.map((x) => x.duree), '720p'), '1080p': prixPire(segs.map((x) => x.duree), '1080p') };
    P.statut = 'pret';
    ecrit(P);
    note({ entier: P.id, plan: true, dureeS: P.source.duree, morceaux: segs.length, scenes: sc.length, durees: segs.map((x) => x.duree), fps: F, prixPire: P.prixPlan });
  }

  /* ---- 2. la confirmation ---- */

  /**
   * Lance une passe planifiee. q : { images: [URL https | data-URL PNG/JPEG]
   * (vide : SWOGE), prompt, resolution, confirmeUsd (le prix montre) }.
   * Tout est verifie AVANT le premier envoi : etat, texte, images (1 a 4),
   * prix au pire sous le plafond, et egal a celui que la page a montre.
   */
  async function lance(id, addr, q) {
    q = q || {};
    const P = ID.test(String(id || '')) ? PASSES.get(String(id)) : null;
    if (!P || P.addr !== addr) return { ok: false, code: 404, raison: 'unknown whole-video edit' };
    if (P.statut !== 'pret') return { ok: false, code: 409, raison: 'this edit is ' + P.statut + ', not waiting for a go' };
    const texte = String(q.prompt || '').trim();
    if (!texte) return { ok: false, code: 400, raison: 'write what to change in the video' };
    if (texte.length > K.TEXTE_MAX) return { ok: false, code: 400, raison: 'prompt too long (' + K.TEXTE_MAX + ' characters at most)' };
    /* 'swoge' (le corps) et 'swoge-face' (le visage) : les references par
       defaut des editions, a leur place dans la liste ; liste vide : les deux */
    const brutes = Array.isArray(q.images) ? q.images.filter((x) => x != null && x !== '').map((x) => (Object.prototype.hasOwnProperty.call(JETONS, x) ? JETONS[x] : x)) : [];
    const liste = brutes.length ? brutes : DEFAUT.slice();
    if (liste.some((x) => x == null)) return { ok: false, code: 400, raison: 'unknown default picture' };
    if (liste.length > K.EDITION_IMAGES_MAX) return { ok: false, code: 400, raison: K.EDITION_IMAGES_MAX + ' reference pictures at most (Kling limit with a video)' };
    const refs = [];
    for (let i = 0; i < liste.length; i++) {
      const r = K.referenceEdition(liste[i]);
      if (!r.ok) return { ok: false, code: 400, raison: 'picture ' + (i + 1) + ': ' + r.raison };
      if (r.source !== 'url' && Buffer.byteLength(r.image, 'base64') > 6 * 1024 * 1024) return { ok: false, code: 413, raison: 'picture ' + (i + 1) + ' is too large (6 MB max)' };
      refs.push(r);
    }
    const resolution = q.resolution === '1080p' ? '1080p' : '720p';
    const prix = prixPire(P.segments.map((s) => s.duree), resolution);
    if (prix === null) return { ok: false, code: 400, raison: 'no price for this plan' };
    if (prix > PLAFOND + 1e-9) return { ok: false, code: 402, raison: 'worst case $' + prix.toFixed(2) + ' is over the $' + PLAFOND.toFixed(2) + ' cap per run — use 720p or a shorter video' };
    if (!(Math.abs(Number(q.confirmeUsd) - prix) < 0.0005)) return { ok: false, code: 409, raison: 'the price to confirm is $' + prix.toFixed(3) + ' — confirm that amount' };
    if (!kling.actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    /* les images fournies vont sur le disque (l'etat reste petit) */
    P.images = refs.map((r, i) => {
      if (r.source === 'url') return { type: 'url', url: r.image };
      const nom = 'ref_' + (i + 1) + '.' + (r.source === 'png' ? 'png' : 'jpg');
      fs.writeFileSync(fic(P, nom), Buffer.from(r.image, 'base64'));
      return { type: 'fichier', nom, format: r.source };
    });
    P.prompt = texte; P.resolution = resolution; P.prixConfirme = prix; P.tLance = temps();
    for (const s of P.segments) s.statut = 'attente';
    P.statut = 'en_cours';
    ecrit(P);
    note({ entier: P.id, lance: true, morceaux: P.segments.length, resolution, images: P.images.map((x) => (x.type === 'url' ? (x.url === DEFAUT[0] ? 'swoge' : x.url === DEFAUT[1] ? 'swoge-face' : 'url') : x.format)), prixPire: prix, plafondUsd: PLAFOND, parallele: PAR });
    /* les premiers envois partent avant la reponse : la page voit tout de suite un refus de Kling */
    await pompe(P).catch((e) => console.error('[kling-entier] ' + e.message));
    return Object.assign({ ok: true }, vue1(P));
  }

  /** Les references telles que Kling les attend (URL, ou base64 lu sur le disque). */
  function references(P) {
    return P.images.map((im) => (im.type === 'url' ? im.url : fs.readFileSync(fic(P, im.nom)).toString('base64')));
  }

  /* ---- 3. l'envoi, au plus PAR a la fois ---- */
  async function envoie(P, s) {
    s.statut = 'envoi'; s.essais++; s.externe = crypto.randomBytes(12).toString('hex'); s.message = null;
    ecrit(P);   /* l'identifiant externe est sur le disque AVANT l'appel */
    EN_VOL.add(s.externe);
    let r;
    try {
      r = await kling.lanceEdition({ videoUrl: deps.urlPublique(s.fichier), images: references(P), prompt: P.prompt, resolution: P.resolution,
                                     audio: 'original', dureeS: s.duree, externe: s.externe });
    } catch (e) { r = { ok: false, code: 502, raison: 'Kling refused: ' + (e && e.message) }; }
    EN_VOL.delete(s.externe);
    if (r && r.ok) {
      s.rid = r.id; s.statut = 'soumis'; s.t0 = temps(); s.estimationUsd = r.estimationUsd; s.limites = 0; s.reessaiA = null;
      P.depenseMaxUsd = arrondi3(P.depenseMaxUsd + (r.estimationUsd || 0));
      ecrit(P);
      note({ id: r.id, entier: P.id, morceau: s.i, edition: true, modele: r.modele, dureeS: r.dureeS, resolution: r.resolution, audio: r.audio,
             images: (r.images || []).length, estimationUsd: r.estimationUsd, essai: s.essais });
      return;
    }
    const code = r && r.klingCode != null ? Number(r.klingCode) : null;
    const limite = CODES_LIMITE.includes(code) || (r && r.http === 429 && ![1100, 1101, 1102, 1304].includes(code));
    if (limite && s.limites < LIMITE_ESSAIS_MAX) {
      /* « pas maintenant » : on attend, on ne compte pas un essai */
      s.limites++; s.essais--;
      s.reessaiA = temps() + Math.min(ATTENTE.max, ATTENTE.depart * Math.pow(2, s.limites - 1));
      s.statut = 'attente'; s.externe = null; s.message = 'Kling is busy (' + (code || 429) + '), waiting ' + Math.round((s.reessaiA - temps()) / 1000) + ' s';
      ecrit(P);
      note({ entier: P.id, morceau: s.i, limite: true, code, attenteS: Math.round((s.reessaiA - temps()) / 1000) });
      return;
    }
    s.statut = 'echec'; s.externe = null; s.message = propre((r && r.raison) || 'Kling refused');
    ecrit(P);
    note({ entier: P.id, morceau: s.i, statut: 'refuse', message: s.message, code });
  }

  async function pompe(P) {
    if (P.statut !== 'en_cours') return;
    for (;;) {
      const enVol = P.segments.filter((s) => s.statut === 'envoi' || s.statut === 'soumis').length;
      if (enVol >= PAR) break;
      const s = P.segments.find((x) => x.statut === 'attente' && !(x.reessaiA > temps()));
      if (!s) break;
      await envoie(P, s);
    }
    bilan(P);
  }

  /** Tout est conclu ? assemble si tout a reussi, sinon attend le clic de relance. */
  function bilan(P) {
    if (P.statut !== 'en_cours' && P.statut !== 'incomplet') return;
    const ouverts = P.segments.filter((s) => ['attente', 'envoi', 'soumis', 'telechargement'].includes(s.statut)).length;
    if (ouverts) { if (P.statut !== 'en_cours') { P.statut = 'en_cours'; ecrit(P); } return; }
    if (P.segments.every((s) => s.statut === 'reussi')) { P.statut = 'assemblage'; ecrit(P); P.travail = assemble(P); return; }
    if (P.statut !== 'incomplet') { P.statut = 'incomplet'; P.message = 'some parts failed — retry them one by one'; ecrit(P); }
  }

  /* ---- le suivi : un pas pour chaque morceau soumis ---- */
  async function telecharge(P, s) {
    const nom = 'res_' + String(s.i).padStart(3, '0') + '.mp4';
    try {
      const b = await telechargeSur(s.url, { fetch: deps.fetchCdn, hoteOk, httpPermis: !!deps.httpPermis, max: RESULTAT_MAX, delaiMs: 180000 });
      if (!b.length) throw new Error('size 0');
      fs.writeFileSync(fic(P, nom + '.part'), b); fs.renameSync(fic(P, nom + '.part'), fic(P, nom));
      s.resultat = nom; s.statut = 'reussi'; s.message = null;
      /* Kling a lu le morceau : il ne sert plus */
      efface(P, s.fichier); s.fichier = null;
    } catch (e) {
      efface(P, nom + '.part');
      s.statut = 'echec'; s.message = 'Kling finished but the result could not be downloaded: ' + propre(e.message) + ' — retry downloads it again (no new charge)';
    }
    ecrit(P);
  }

  async function suitMorceau(P, s) {
    if (s.statut === 'envoi') {
      if (EN_VOL.has(s.externe)) return;
      /* un redemarrage entre l'envoi et l'id : la tache existe-t-elle ? */
      const e = await kling.etatExterne(s.externe).catch(() => null);
      if (e && e.ok) { s.rid = e.id; s.statut = 'soumis'; s.t0 = s.t0 || temps(); s.estimationUsd = K.prixEdition(P.resolution, s.duree);
        P.depenseMaxUsd = arrondi3(P.depenseMaxUsd + (s.estimationUsd || 0)); ecrit(P);
        note({ id: e.id, entier: P.id, morceau: s.i, edition: true, retrouve: true, estimationUsd: s.estimationUsd }); }
      else if (e && e.code === 404) { s.statut = 'attente'; s.externe = null; s.essais = Math.max(0, s.essais - 1); ecrit(P); }
      return;
    }
    if (s.statut === 'telechargement') return telecharge(P, s);
    if (s.statut !== 'soumis') return;
    let e = null;
    try { e = await kling.etat(s.rid); } catch (x) { e = null; }
    if (e && e.ok && e.statut === 'succeeded') {
      s.t1 = temps(); s.facturation = e.facturation || null; s.dureeKling = e.duree || null;
      note({ id: s.rid, entier: P.id, morceau: s.i, edition: true, statut: 'succeeded', duree: e.duree || null, facturation: e.facturation || null, secondes: Math.round((s.t1 - s.t0) / 100) / 10 });
      if (!e.url) { s.statut = 'echec'; s.message = 'Kling answered without a video URL'; ecrit(P); return; }
      s.url = String(e.url).slice(0, 2000); s.statut = 'telechargement'; ecrit(P);
      return telecharge(P, s);
    }
    if (e && e.ok && e.statut === 'failed') {
      s.t1 = temps(); s.statut = 'echec'; s.message = 'Kling failed: ' + propre(e.message || 'no reason given'); s.facturation = e.facturation || null; ecrit(P);
      note({ id: s.rid, entier: P.id, morceau: s.i, edition: true, statut: 'failed', message: s.message, facturation: e.facturation || null, secondes: Math.round((s.t1 - s.t0) / 100) / 10 });
      return;
    }
    if (temps() - s.t0 > MORCEAU_MAX) {
      s.t1 = temps(); s.statut = 'echec'; s.message = 'no answer from Kling after ' + Math.round(MORCEAU_MAX / 60000) + ' min'; ecrit(P);
      note({ id: s.rid, entier: P.id, morceau: s.i, edition: true, statut: 'timeout' });
    }
  }

  /** Un tour de fond : chaque passe en cours avance d'un pas. */
  async function tour() {
    if (tourEnCours) return tourEnCours;
    tourEnCours = (async () => {
      for (const P of PASSES.values()) {
        if (P.statut === 'en_cours') {
          for (const s of P.segments) await suitMorceau(P, s).catch((e) => console.error('[kling-entier] ' + e.message));
          await pompe(P).catch((e) => console.error('[kling-entier] ' + e.message));
        } else if (P.statut === 'assemblage' && !P.travail) {
          P.travail = assemble(P);
        }
        if (P.travail) await P.travail.catch(() => {});
        if (['fini', 'erreur', 'abandon'].includes(P.statut) && temps() - Number(P.t) > GARDE_MS) supprime(P);
      }
    })();
    try { await tourEnCours; } finally { tourEnCours = null; }
  }

  /* ---- 4. la relance d'UN morceau ---- */
  async function relance(id, addr, i) {
    const P = ID.test(String(id || '')) ? PASSES.get(String(id)) : null;
    if (!P || P.addr !== addr) return { ok: false, code: 404, raison: 'unknown whole-video edit' };
    const s = P.segments[Number(i)];
    if (!s || !/^\d+$/.test(String(i))) return { ok: false, code: 404, raison: 'unknown part' };
    if (!['en_cours', 'incomplet'].includes(P.statut) || s.statut !== 'echec') return { ok: false, code: 409, raison: 'part ' + (s.i + 1) + ' is ' + s.statut + ', nothing to retry' };
    if (s.url && !s.resultat) {
      /* deja fait (et paye) chez Kling : on retelecharge seulement */
      s.statut = 'telechargement'; P.statut = 'en_cours'; ecrit(P);
      await telecharge(P, s); bilan(P);
      return Object.assign({ ok: true, retelecharge: true }, vue1(P));
    }
    if (!s.fichier) return { ok: false, code: 409, raison: 'the source of this part is gone — upload the video again' };
    const p = K.prixEdition(P.resolution, s.duree);
    if (P.depenseMaxUsd + p > PLAFOND + 1e-9) return { ok: false, code: 402, raison: 'retrying would take this run to $' + (P.depenseMaxUsd + p).toFixed(2) + ', over the $' + PLAFOND.toFixed(2) + ' cap' };
    s.statut = 'attente'; s.reessaiA = null; s.limites = 0; s.message = null; s.rid = null; s.url = null;
    P.statut = 'en_cours'; P.message = null; ecrit(P);
    note({ entier: P.id, morceau: s.i, relance: true });
    await pompe(P);
    return Object.assign({ ok: true }, vue1(P));
  }

  /* ---- 5. le recollage, le son d'origine ---- */
  async function assemble(P) {
    try {
      const segs = P.segments;
      const premier = await sonde(fic(P, segs[0].resultat));
      const W = 2 * Math.round(premier.largeur / 2) || P.cotes.largeur, H = 2 * Math.round(premier.hauteur / 2) || P.cotes.hauteur, F = P.fps;
      const args = ['-v', 'error', '-y'];
      for (const s of segs) args.push('-i', fic(P, s.resultat));
      const orig = fic(P, 'orig.mp4');
      args.push('-i', orig);
      /* chaque resultat ramene a la longueur EXACTE de son morceau source :
         prolonge (derniere image tenue) puis coupe ; meme taille, meme i/s */
      const f = segs.map((s, k) => '[' + k + ':v]fps=' + F + ',scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,'
        + 'tpad=stop_mode=clone:stop_duration=' + (s.dureePlan + 1).toFixed(3) + ',trim=duration=' + s.dureePlan.toFixed(3) + ',setpts=PTS-STARTPTS[v' + k + ']');
      const filtre = f.join(';') + ';' + segs.map((s, k) => '[v' + k + ']').join('') + 'concat=n=' + segs.length + ':v=1:a=0[v]';
      const D = P.source.duree;
      const nomFinal = 'swoge_' + P.id + '.final.mp4';
      args.push('-filter_complex', filtre, '-map', '[v]');
      if (P.source.son) args.push('-map', segs.length + ':a:0', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(F), '-t', D.toFixed(3), '-movflags', '+faststart', '-f', 'mp4', fic(P, nomFinal + '.part'));
      await executer(ffmpeg, args, 30 * 60e3);
      fs.renameSync(fic(P, nomFinal + '.part'), fic(P, nomFinal));
      let dF = null;
      try { dF = (await sonde(fic(P, nomFinal))).duree; } catch (e) { dF = null; }
      P.final = nomFinal; P.statut = 'fini'; P.tFin = temps(); P.dureeFinale = dF ? arrondi3(dF) : null; P.message = null;
      /* garde 48 h a partir de la fin */
      P.t = temps();
      nettoie(P); ecrit(P);
      const factures = segs.map((s) => s.facturation).filter(Boolean);
      note({ entier: P.id, statut: 'fini', morceaux: segs.length, dureeS: D, dureeFinaleS: P.dureeFinale, son: P.source.son, estimationUsd: P.depenseMaxUsd, facturations: factures.length,
             secondes: Math.round((temps() - (P.tLance || P.t)) / 100) / 10 });
    } catch (e) {
      efface(P, 'swoge_' + P.id + '.final.mp4.part');
      P.statut = 'incomplet'; P.message = 'gluing failed: ' + propre(e.err || e.message);
      /* les resultats sont gardes : un clic de relance sur un morceau n'est pas
         necessaire, « Glue again » relance seulement l'assemblage */
      ecrit(P);
      note({ entier: P.id, statut: 'assemblage-rate', message: P.message });
    } finally { P.travail = null; }
  }

  /** Relance seulement l'assemblage (tous les morceaux reussis). */
  async function recolle(id, addr) {
    const P = ID.test(String(id || '')) ? PASSES.get(String(id)) : null;
    if (!P || P.addr !== addr) return { ok: false, code: 404, raison: 'unknown whole-video edit' };
    if (P.statut !== 'incomplet' || !P.segments.every((s) => s.statut === 'reussi' && s.resultat)) return { ok: false, code: 409, raison: 'nothing to glue' };
    P.statut = 'assemblage'; ecrit(P);
    P.travail = assemble(P);
    return Object.assign({ ok: true }, vue1(P));
  }

  /** Abandonner une passe : tout est efface (ce que Kling fait deja reste facture). */
  function abandonne(id, addr) {
    const P = ID.test(String(id || '')) ? PASSES.get(String(id)) : null;
    if (!P || P.addr !== addr) return { ok: false, code: 404, raison: 'unknown whole-video edit' };
    if (P.statut === 'assemblage' || P.statut === 'decoupe') return { ok: false, code: 409, raison: 'wait a moment: the server is ' + (P.statut === 'decoupe' ? 'cutting' : 'gluing') };
    if (P.statut === 'fini') { supprime(P); return { ok: true, statut: 'supprime' }; }
    P.statut = 'abandon'; P.message = 'abandoned by the owner';
    nettoie(P); ecrit(P);
    note({ entier: P.id, statut: 'abandon', estimationUsd: P.depenseMaxUsd });
    return Object.assign({ ok: true }, vue1(P));
  }

  function supprime(P) {
    try { fs.rmSync(rep(P.id), { recursive: true, force: true }); } catch (e) { /* rien */ }
    PASSES.delete(P.id);
  }

  /* ---- ce qui sort ---- */
  function vue1(P) {
    const segs = P.segments.map((s) => ({ i: s.i, debut: s.debut, duree: s.duree, statut: s.statut === 'plan' ? 'planned' : s.statut === 'attente' ? 'waiting'
      : s.statut === 'envoi' ? 'sending' : s.statut === 'soumis' ? 'processing' : s.statut === 'telechargement' ? 'downloading' : s.statut === 'reussi' ? 'done' : 'failed',
      message: s.message, essais: s.essais, estimationUsd: s.estimationUsd != null ? s.estimationUsd : K.prixEdition(P.resolution || '720p', s.duree),
      facturation: s.facturation, rejouable: s.statut === 'echec' && !!(s.fichier || (s.url && !s.resultat)) }));
    return { id: P.id, statut: P.statut, message: P.message, source: P.source, fps: P.fps, cotes: P.cotes, morceaux: segs, scenes: P.scenes != null ? P.scenes : null,
             prixPire: P.prixPlan, plafondUsd: PLAFOND, parallele: PAR, resolution: P.resolution, prixConfirme: P.prixConfirme || null, depenseMaxUsd: P.depenseMaxUsd,
             video: P.statut === 'fini' && P.final ? '/studio/kling/entier/' + P.id + '/video' : null, dureeFinale: P.dureeFinale || null,
             expire: P.statut === 'fini' ? Number(P.t) + GARDE_MS : null };
  }

  /** L'etat d'une passe, pour SON adresse seulement. */
  function etat(id, addr) {
    const P = ID.test(String(id || '')) ? PASSES.get(String(id)) : null;
    if (!P || P.addr !== addr) return { ok: false, code: 404, raison: 'unknown whole-video edit' };
    return Object.assign({ ok: true }, vue1(P));
  }

  /** Le fichier final (chemin et taille), pour le proprietaire qui l'a lance. */
  function resultat(id, addr) {
    const P = ID.test(String(id || '')) ? PASSES.get(String(id)) : null;
    if (!P || P.addr !== addr || P.statut !== 'fini' || !P.final) return null;
    try { const c = fic(P, P.final); return { chemin: c, taille: fs.statSync(c).size, nom: 'swoge_whole_' + P.id.slice(0, 8) + '.mp4' }; } catch (e) { return null; }
  }

  /** Un morceau EN COURS chez Kling, par son nom (48 hexa) : ce que Kling lit. */
  function fichier(nom) {
    const n = String(nom || '');
    if (!NOM.test(n)) return null;
    for (const P of PASSES.values()) {
      if (P.statut !== 'en_cours') continue;
      const s = P.segments.find((x) => x.fichier === n);
      if (!s || !['envoi', 'soumis'].includes(s.statut)) continue;
      try { return { octets: fs.readFileSync(fic(P, n)), type: 'video/mp4' }; } catch (e) { return null; }
    }
    return null;
  }

  /** Ce que la page lit : les bornes, la grille, le plafond, la passe en cours. */
  function vue(addr) {
    const mienne = [...PASSES.values()].filter((P) => P.addr === addr).sort((a, b) => b.t - a.t)[0];
    return { modele: K.EDITION_MODELE, prixParSeconde: K.EDITION_PRIX, dureeMinS: DECOUPE.min, dureeMaxS: DECOUPE.max, cibleS: DECOUPE.cible,
             dureeEntierMaxS: DUREE_ENTIER_MAX, octetsMax: ENTREE_OCTETS_MAX, imagesMax: K.EDITION_IMAGES_MAX, imageOctetsMax: 6 * 1024 * 1024,
             plafondUsd: PLAFOND, parallele: PAR, gardeH: GARDE_MS / 3600e3, passe: mienne ? mienne.id : null };
  }

  function demarre() {
    if (minuteur) return;
    minuteur = setInterval(() => { tour().catch(() => {}); }, POLL);
    if (minuteur.unref) minuteur.unref();
  }
  function arrete() { if (minuteur) clearInterval(minuteur); minuteur = null; }

  relit();
  /* les passes reprises au demarrage repartent au premier tour */
  return { cree: cree_, lance, relance, recolle, abandonne, etat, resultat, fichier, vue, tour, demarre, arrete, PASSES,
           attend: async (id) => { const P = PASSES.get(id); if (P && P.travail) await P.travail; } };
}

module.exports = { cree, coupes, prixPire, plafondUsd, parallele, hotesPermis, fpsSortie, cotesSortie,
  DECOUPE, PLAFOND_USD, PARALLELE, ENTREE_OCTETS_MAX, DUREE_ENTIER_MAX, GARDE_MS, NOM, ID, VIDEO_PREFIXE, HOTES, CODES_LIMITE, SCENE_SEUIL };
