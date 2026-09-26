'use strict';
/* ==================================================================
 * SWOGE STUDIO — IMAGES ET VIDÉOS (Grok Imagine), payées en $SWOGE
 * ==================================================================
 *
 * Demande du propriétaire, le 26 septembre 2026 : l'interface de Studio
 * « comme Grok, côté chat et côté génération d'images et de vidéos ». Même
 * règle d'argent que le chat (`studio_chat.js`) :
 *
 *   1. RÉSERVER le pire cas sur le solde de jeu de l'adresse de la SESSION ;
 *   2. FACTURER le coût réel que xAI rend (`usage.cost_in_usd_ticks`,
 *      1 $ = 1e10 ticks) × STUDIO_MARGE, arrondi au $SWOGE supérieur ;
 *   3. RENDRE le reste — TOUT si le fournisseur échoue ou si la vidéo n'arrive
 *      pas. Jamais facturer sous le coût, jamais plus que la réserve.
 *
 * Les prix de liste (grille xAI relue le 26 septembre 2026) : image « Speed »
 * grok-imagine-image 0,02 $, « Quality » grok-imagine-image-2.0 0,04 $ ;
 * vidéo grok-imagine-video 0,050 $/s, grok-imagine-video-1.5 0,080 $/s. La
 * grille dit que la résolution vidéo et la retouche (image d'entrée facturée)
 * changent le prix sans chiffrer l'écart : la RÉSERVE prend donc ×3, et c'est
 * le coût rendu par xAI qui est facturé. Sans `usage` (ça ne devrait pas
 * arriver), on facture la liste — plafonnée à la réserve — et on le COMPTE
 * (`MESURE.sansUsage`) : à relire avant de toucher un chiffre.
 *
 * Une vidéo prend du temps : on la LANCE, le serveur l'interroge lui-même
 * toutes les VIDEO_POLL_MS et règle quand elle arrive (la page peut partir, le
 * joueur est quand même remboursé ou facturé juste). La page interroge le
 * serveur, jamais xAI : la clé ne quitte pas l'hôte. Une vidéo n'est lisible
 * que par l'adresse qui l'a payée.
 * ================================================================== */

const crypto = require('crypto');
const config = require('./config');
const studio = require('./studio');

const IMAGE = [
  { id: 'rapide', nom: 'Speed', api: 'grok-imagine-image', usd: 0.02 },
  { id: 'qualite', nom: 'Quality (2.0)', api: 'grok-imagine-image-2.0', usd: 0.04 },
];
const VIDEO = [
  { id: 'rapide', nom: 'Speed', api: 'grok-imagine-video', usdSeconde: 0.05 },
  { id: 'qualite', nom: 'Quality (1.5)', api: 'grok-imagine-video-1.5', usdSeconde: 0.08 },
];
/* Les formats : ceux que l'API accepte (ImageAspectRatio / VideoAspectRatio),
   réduits à ceux qu'un joueur choisit vraiment. « auto » = on n'envoie rien. */
const FORMATS_IMAGE = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const FORMATS_VIDEO = ['auto', '16:9', '9:16', '1:1'];
const NOMBRES = [1, 2, 4];
const DUREES = [6, 10];
const RESOLUTIONS = ['480p', '720p'];
const RESERVE_X = 3;
const PROMPT_MAX = 4000;
const IMAGE_MAX_OCTETS = 6 * 1024 * 1024;
const VIDEO_POLL_MS = () => Math.max(200, Number(process.env.STUDIO_VIDEO_POLL_MS || 5000));
const VIDEO_MAX_MS = () => Math.max(1000, Number(process.env.STUDIO_VIDEO_MAX_MS || 15 * 60 * 1000));
const MARGE = () => Math.max(1, Number(process.env.STUDIO_MARGE || 1.5));
const MIN_USD = 0.001;
const PAR_MINUTE = () => Math.max(1, Number(process.env.STUDIO_MEDIA_PAR_MINUTE || 6));

const MESURE = { images: 0, videos: 0, echecs: 0, coutUsd: 0, factureUsd: 0, depassements: 0, sansUsage: 0 };
const EN_VOL = new Set();          /* une image en cours par adresse */
const RYTHME = new Map();
const JOBS = new Map();            /* id -> vidéo en cours ou finie (gardée 1 h) */

function rythmeOk(addr, t) {
  const l = (RYTHME.get(addr) || []).filter((x) => t - x < 60000);
  if (l.length >= PAR_MINUTE()) { RYTHME.set(addr, l); return false; }
  l.push(t); RYTHME.set(addr, l); return true;
}
const factureUsd = (cout) => Math.max(MIN_USD, cout * MARGE());
const coutDe = (usage) => (usage && Number.isFinite(Number(usage.cost_in_usd_ticks)) ? Number(usage.cost_in_usd_ticks) / 1e10 : null);

/** Une image jointe : un data-URL PNG/JPEG/WebP, borné. null si rien, false si refusé. */
function imageJointe(x) {
  if (x == null || x === '') return null;
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(x));
  if (!m) return false;
  if (m[2].length * 0.75 > IMAGE_MAX_OCTETS) return false;
  return String(x);
}

function pourSwoge(usd, cours) { return cours > 0 ? Math.ceil(factureUsd(usd) / cours) : null; }

/** Le catalogue montré à la page : modèles, options, prix typiques en $SWOGE. */
function catalogue(cours, actif) {
  return {
    ouvert: !!actif && cours > 0,
    note: !actif ? 'Image and video generation is not switched on yet (the provider key is not set on the server).'
      : !(cours > 0) ? 'The $SWOGE price is unavailable right now — generation is paused so nobody is overcharged.' : null,
    marge: MARGE(),
    image: { modeles: IMAGE.map((m) => ({ id: m.id, nom: m.nom, parImageSwoge: pourSwoge(m.usd, cours) })),
             formats: FORMATS_IMAGE, nombres: NOMBRES },
    video: { modeles: VIDEO.map((m) => ({ id: m.id, nom: m.nom, parSecondeSwoge: pourSwoge(m.usdSeconde, cours),
                                           typiqueSwoge: pourSwoge(m.usdSeconde * DUREES[0], cours) })),
             formats: FORMATS_VIDEO, durees: DUREES, resolutions: RESOLUTIONS },
  };
}

/* Règle une réserve : facture le coût réel (ou la liste, comptée), jamais plus que la réserve. */
function regle(deps, addr, reserveWei, cours, cout, listeUsd) {
  const dec = config.DECIMALS || 18;
  let c = cout;
  if (c == null) { MESURE.sansUsage++; c = listeUsd; }
  const f = factureUsd(c);
  let fWei = studio.montantBaseDe(f, cours, dec);
  if (fWei > reserveWei) { MESURE.depassements++; console.error('[studio] DÉPASSEMENT de réserve : ' + f.toFixed(4) + ' $'); fWei = reserveWei; }
  const solde = deps.solde.regle(addr, reserveWei, fWei);
  MESURE.coutUsd += c; MESURE.factureUsd += f;
  return { solde, factureSwoge: studio.formateBase(fWei, dec), factureUsd: Number(f.toFixed(5)) };
}

async function reserve(deps, addr, usd) {
  const cours = await deps.cours();
  if (!(cours > 0)) return { erreur: { ok: false, code: 503, raison: 'the $SWOGE price is unavailable — try again shortly' } };
  const dec = config.DECIMALS || 18;
  const wei = studio.montantBaseDe(factureUsd(usd), cours, dec);
  if (!deps.solde.reserve(addr, wei)) {
    return { erreur: { ok: false, code: 402, raison: 'balance too low for this generation', requisSwoge: studio.formateBase(wei, dec) } };
  }
  return { cours, wei };
}

/** Des images. q = { addr, modele, prompt, n, format, image } */
async function images(q, deps) {
  const addr = q && q.addr;
  if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
  const m = IMAGE.find((x) => x.id === q.modele) || IMAGE[0];
  const prompt = String(q.prompt || '').trim().slice(0, PROMPT_MAX);
  if (!prompt) return { ok: false, code: 400, raison: 'describe the image to create' };
  const n = NOMBRES.includes(Number(q.n)) ? Number(q.n) : 1;
  const format = FORMATS_IMAGE.includes(q.format) ? q.format : 'auto';
  const image = imageJointe(q.image);
  if (image === false) return { ok: false, code: 400, raison: 'the attached image must be a PNG, JPEG or WebP under 6 MB' };
  if (EN_VOL.has(addr)) return { ok: false, code: 429, raison: 'one generation at a time' };
  if (!rythmeOk(addr, q.maintenant || Date.now())) return { ok: false, code: 429, raison: 'too many generations — wait a minute' };
  const listeUsd = m.usd * (n + (image ? 1 : 0));
  const r = await reserve(deps, addr, m.usd * n * RESERVE_X + (image ? m.usd * RESERVE_X : 0));
  if (r.erreur) return r.erreur;
  EN_VOL.add(addr);
  let rep;
  try { rep = await deps.fournisseur.images({ api: m.api, prompt, n, format, image }); }
  catch (e) {
    deps.solde.regle(addr, r.wei, 0n); MESURE.echecs++; EN_VOL.delete(addr);
    return { ok: false, code: 502, raison: 'the image provider failed — you were not charged', detail: String(e && e.message || e).slice(0, 200) };
  }
  EN_VOL.delete(addr);
  if (!rep.urls || !rep.urls.length) {
    deps.solde.regle(addr, r.wei, 0n); MESURE.echecs++;
    return { ok: false, code: 502, raison: 'no image came back (possibly refused by moderation) — you were not charged' };
  }
  MESURE.images += rep.urls.length;
  const f = regle(deps, addr, r.wei, r.cours, coutDe(rep.usage), listeUsd);
  return Object.assign({ ok: true, genre: 'image', modele: m.id, urls: rep.urls, retouche: !!image }, f);
}

/** Lance une vidéo. q = { addr, modele, prompt, duree, resolution, format, image } */
async function lanceVideo(q, deps) {
  const addr = q && q.addr;
  if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
  const m = VIDEO.find((x) => x.id === q.modele) || VIDEO[0];
  const prompt = String(q.prompt || '').trim().slice(0, PROMPT_MAX);
  const image = imageJointe(q.image);
  if (image === false) return { ok: false, code: 400, raison: 'the attached image must be a PNG, JPEG or WebP under 6 MB' };
  if (!prompt && !image) return { ok: false, code: 400, raison: 'describe the video, or attach an image to animate' };
  const duree = DUREES.includes(Number(q.duree)) ? Number(q.duree) : DUREES[0];
  const resolution = RESOLUTIONS.includes(q.resolution) ? q.resolution : RESOLUTIONS[0];
  const format = FORMATS_VIDEO.includes(q.format) ? q.format : 'auto';
  for (const j of JOBS.values()) if (j.addr === addr && j.status === 'pending') return { ok: false, code: 429, raison: 'one video at a time — wait for the current one' };
  const t = q.maintenant || Date.now();
  if (!rythmeOk(addr, t)) return { ok: false, code: 429, raison: 'too many generations — wait a minute' };
  const listeUsd = m.usdSeconde * duree;
  const r = await reserve(deps, addr, listeUsd * RESERVE_X);
  if (r.erreur) return r.erreur;
  let rid;
  try { rid = await deps.fournisseur.lanceVideo({ api: m.api, prompt, duree, resolution, format, image }); }
  catch (e) {
    deps.solde.regle(addr, r.wei, 0n); MESURE.echecs++;
    return { ok: false, code: 502, raison: 'the video provider failed — you were not charged', detail: String(e && e.message || e).slice(0, 200) };
  }
  const id = crypto.randomBytes(12).toString('hex');
  const job = { id, rid, addr, modele: m.id, duree, resolution, t0: t, status: 'pending', progress: 0,
                reserveWei: r.wei, cours: r.cours, listeUsd, url: null, factureSwoge: null, solde: null, raison: null };
  JOBS.set(id, job);
  if (!deps.sansBoucle) suit(job, deps);
  return { ok: true, genre: 'video', id, status: 'pending', duree, resolution, modele: m.id };
}

/** Un pas de suivi d'une vidéo : interroge xAI, règle si elle est finie. */
async function avance(job, deps, maintenant) {
  if (job.status !== 'pending') return job;
  const t = maintenant || Date.now();
  let v = null;
  try { v = await deps.fournisseur.litVideo(job.rid); } catch (e) { v = null; }
  if (v && v.status === 'done' && v.video && v.video.url) {
    job.status = 'done'; job.url = v.video.url; job.progress = 100;
    const secondes = Number(v.video.duration) > 0 ? Number(v.video.duration) : job.duree;
    Object.assign(job, regle(deps, job.addr, job.reserveWei, job.cours, coutDe(v.usage), job.listeUsd * secondes / job.duree));
    MESURE.videos++;
  } else if (v && (v.status === 'failed' || v.status === 'expired')) {
    job.status = 'failed'; job.raison = 'the video could not be generated' + (v.erreur ? ' (' + v.erreur + ')' : '') + ' — you were not charged';
    job.solde = deps.solde.regle(job.addr, job.reserveWei, 0n); MESURE.echecs++;
  } else if (t - job.t0 > VIDEO_MAX_MS()) {
    /* Trop long : on rend tout. Si xAI la livre plus tard, c'est la maison qui paie. */
    job.status = 'failed'; job.raison = 'the video took too long — you were not charged';
    job.solde = deps.solde.regle(job.addr, job.reserveWei, 0n); MESURE.echecs++;
  } else if (v && Number.isFinite(Number(v.progress))) {
    job.progress = Number(v.progress);
  }
  return job;
}

function suit(job, deps) {
  const tour = async () => {
    await avance(job, deps);
    if (job.status === 'pending') setTimeout(tour, VIDEO_POLL_MS()).unref();
    else setTimeout(() => JOBS.delete(job.id), 60 * 60 * 1000).unref();
  };
  setTimeout(tour, VIDEO_POLL_MS()).unref();
}

/** L'état d'une vidéo, pour SON propriétaire seulement. */
function etatVideo(id, addr) {
  const j = JOBS.get(String(id || ''));
  if (!j || !addr || j.addr !== addr) return { ok: false, code: 404, raison: 'unknown video' };
  return { ok: true, genre: 'video', id: j.id, status: j.status, progress: j.progress, url: j.url,
           duree: j.duree, resolution: j.resolution, modele: j.modele, factureSwoge: j.factureSwoge, factureUsd: j.factureUsd || null,
           solde: j.solde, raison: j.raison };
}

module.exports = { IMAGE, VIDEO, FORMATS_IMAGE, FORMATS_VIDEO, NOMBRES, DUREES, RESOLUTIONS, RESERVE_X,
                   MESURE, JOBS, EN_VOL, RYTHME, catalogue, images, lanceVideo, avance, etatVideo, imageJointe, coutDe };
