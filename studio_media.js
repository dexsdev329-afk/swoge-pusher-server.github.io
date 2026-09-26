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
const Comp = require('./studio_comprend');   /* la demande comprise avec son fil, et la reference SWOGE */

const IMAGE = [
  { id: 'rapide', fournisseur: 'grok', nom: 'Speed', api: 'grok-imagine-image', usd: 0.02 },
  { id: 'qualite', fournisseur: 'grok', nom: 'Quality (2.0)', api: 'grok-imagine-image-2.0', usd: 0.04 },
  /* ---- « ChatGPT Image » (OpenAI), ajouté le 26 septembre 2026 ----
   * Pas de prix à l'image : OpenAI facture des JETONS (grille relue le même
   * jour, par million) — gpt-image-2 : texte 5 $, image d'entrée 8 $, image de
   * sortie 30 $. Mesure du 18 septembre sur le compte (posts X, gpt-image-1.5,
   * 1536×1024 en « high ») : 6 893 jetons de sortie pour une image. La réserve
   * compte 12 000 jetons de sortie par image (×1,74 cette mesure), 2 000 de
   * texte et 12 000 d'image d'entrée pour une retouche ; la facture, elle, lit
   * `usage`. « Speed » = qualité medium, « Quality » = high. */
  { id: 'rapide', fournisseur: 'openai', nom: 'Speed', qualite: 'medium' },
  { id: 'qualite', fournisseur: 'openai', nom: 'Quality', qualite: 'high' },
];
const FOURNISSEURS_IMAGE = [{ id: 'grok', nom: 'Grok Imagine' }, { id: 'openai', nom: 'ChatGPT Image' }];
/* Prix OpenAI par million de jetons (texte, image d'entrée, image de sortie).
   Un modèle absent de la table est facturé au plus cher connu. */
const PRIX_OPENAI = {
  'gpt-image-2': { t: 5, i: 8, o: 30 }, 'gpt-image-1.5': { t: 5, i: 8, o: 32 },
  'gpt-image-1': { t: 5, i: 10, o: 40 }, 'gpt-image-1-mini': { t: 2, i: 2.5, o: 8 },
};
const OPENAI_MESURE_SORTIE = 6893;      /* jetons, une 1536x1024 « high », 18 septembre 2026 */
const OPENAI_RESERVE_SORTIE = 12000, OPENAI_RESERVE_TEXTE = 2000, OPENAI_RESERVE_ENTREE = 12000;
function modeleOpenai() { return (process.env.STUDIO_OPENAI_IMAGE || 'gpt-image-2').trim(); }
function prixOpenai() { return PRIX_OPENAI[modeleOpenai()] || { t: 5, i: 10, o: 40 }; }
function coutOpenai(usage) {
  if (!usage || !Number.isFinite(Number(usage.output_tokens))) return null;
  const p = prixOpenai(), d = usage.input_tokens_details || {};
  const entree = Number(usage.input_tokens) || 0;
  const texte = Number.isFinite(Number(d.text_tokens)) ? Number(d.text_tokens) : 0;
  const image = Number.isFinite(Number(d.image_tokens)) ? Number(d.image_tokens) : entree - texte;   /* sans detail : tout au prix image, le plus cher */
  return (texte * p.t + image * p.i + Number(usage.output_tokens) * p.o) / 1e6;
}
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
/* ---- LES VOIX DES SERIES ET DES PUBS (26 septembre 2026) ----
 * Les voix prededefinies d'xAI, nommees dans le guide reference-to-video et l'API
 * Text to Speech : seules les cinq CONFIRMEES par la documentation de l'API.
 * Le catalogue en annonce 28 ; `STUDIO_VOIX` (liste) en ajoute sans toucher au
 * code, une fois l'identifiant verifie avec la cle du serveur. */
const VOIX = [
  { id: 'eve', nom: 'Eve', ton: 'energetic' }, { id: 'ara', nom: 'Ara', ton: 'warm' },
  { id: 'rex', nom: 'Rex', ton: 'confident' }, { id: 'sal', nom: 'Sal', ton: 'balanced' },
  { id: 'leo', nom: 'Leo', ton: 'authoritative' },
];
function voixPermises() {
  const plus = String(process.env.STUDIO_VOIX || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z][a-z0-9_-]{1,30}$/.test(x));
  return VOIX.map((v) => v.id).concat(plus.filter((x) => !VOIX.some((v) => v.id === x)));
}
const REFERENCES_MAX = 3;
const RESOLUTIONS = ['480p', '720p'];
const RESERVE_X = 3;
const PROMPT_MAX = 4000;
const IMAGE_MAX_OCTETS = 6 * 1024 * 1024;
const VIDEO_POLL_MS = () => Math.max(200, Number(process.env.STUDIO_VIDEO_POLL_MS || 5000));
const VIDEO_MAX_MS = () => Math.max(1000, Number(process.env.STUDIO_VIDEO_MAX_MS || 15 * 60 * 1000));
const MARGE = () => Math.max(1, Number(process.env.STUDIO_MARGE || 1.5));
const MIN_USD = 0.001;
const PAR_MINUTE = () => Math.max(1, Number(process.env.STUDIO_MEDIA_PAR_MINUTE || 6));

const MESURE = { images: 0, videos: 0, echecs: 0, coutUsd: 0, factureUsd: 0, depassements: 0, sansUsage: 0,
  /* Les images payées en x402 (prix FIXE = le pire cas, faute de mesure) : ce
     qu'elles ont coûté vraiment, pour baisser ce prix sur mesure et non au jugé. */
  horsSolde: { images: 0, coutUsd: 0, prixUsd: 0, sansUsage: 0 } };
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
function catalogue(cours, actifs) {
  /* `actifs` : { grok, openai } — ou un booleen (l'ancien appel : Grok seul). */
  const a = (actifs && typeof actifs === 'object') ? actifs : { grok: !!actifs, openai: false };
  const actif = !!a.grok;
  const p = prixOpenai();
  const image = {
    fournisseurs: FOURNISSEURS_IMAGE.map((f) => ({ id: f.id, nom: f.nom, actif: !!a[f.id],
      modeles: IMAGE.filter((m) => m.fournisseur === f.id).map((m) => (m.fournisseur === 'openai'
        ? { id: m.id, nom: m.nom, parImageSwoge: pourSwoge(OPENAI_MESURE_SORTIE * p.o / 1e6, cours), estime: true }
        : { id: m.id, nom: m.nom, parImageSwoge: pourSwoge(m.usd, cours) })) })),
    formats: FORMATS_IMAGE, nombres: NOMBRES,
  };
  /* Compatibilite : l'ancienne page lit image.modeles (Grok). */
  image.modeles = image.fournisseurs[0].modeles;
  return {
    ouvert: (!!a.grok || !!a.openai) && cours > 0,
    videoOuverte: actif && cours > 0,
    note: !(a.grok || a.openai) ? 'Image and video generation is not switched on yet (the provider key is not set on the server).'
      : !(cours > 0) ? 'The $SWOGE price is unavailable right now — generation is paused so nobody is overcharged.' : null,
    videoNote: !actif ? 'Video is not switched on yet (the Grok Imagine key is not set on the server).'
      : !(cours > 0) ? 'The $SWOGE price is unavailable right now — generation is paused so nobody is overcharged.' : null,
    marge: MARGE(),
    image,
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

/**
 * Le prix « liste » et la réserve (pire cas, AVANT marge) d'une demande
 * d'image. Une seule fonction : la demande elle-même et le devis que l'API
 * des agents annonce avant de débiter (agentic.js) lisent le même calcul.
 */
function coutsImage(fid, m, n, avecImage, reecrit) {
  let listeUsd, reserveUsd;
  if (fid === 'openai') {
    const p = prixOpenai();
    listeUsd = (n * OPENAI_MESURE_SORTIE * p.o + OPENAI_RESERVE_TEXTE * p.t + (avecImage ? OPENAI_RESERVE_ENTREE * p.i : 0)) / 1e6;
    reserveUsd = (n * OPENAI_RESERVE_SORTIE * p.o + OPENAI_RESERVE_TEXTE * p.t + (avecImage ? OPENAI_RESERVE_ENTREE * p.i : 0)) / 1e6;
  } else {
    listeUsd = m.usd * (n + (avecImage ? 1 : 0));
    reserveUsd = m.usd * n * RESERVE_X + (avecImage ? m.usd * RESERVE_X : 0);
  }
  if (reecrit) reserveUsd += Comp.RESERVE_USD;
  return { listeUsd, reserveUsd };
}
/** Le pire cas facturé d'une demande d'image (marge comprise), pour un devis : avec image de départ et réécriture. */
function pireCasImageUsd(fournisseur, modele, n) {
  const fid = fournisseur === 'openai' ? 'openai' : 'grok';
  const m = IMAGE.find((x) => x.fournisseur === fid && x.id === modele) || IMAGE.find((x) => x.fournisseur === fid);
  return factureUsd(coutsImage(fid, m, NOMBRES.includes(Number(n)) ? Number(n) : 1, true, true).reserveUsd);
}

/**
 * Le prix FIXE d'une demande d'image payée d'avance (x402), marge comprise :
 * le pire cas de la réserve — la liste ×3 chez Grok, 12 000 jetons de sortie
 * par image chez OpenAI —, avec l'image de référence et la réécriture si la
 * demande nomme SWOGE. Pas de retouche (pas d'image jointe en x402). Relevé du
 * 26 septembre 2026 : AUCUNE mesure du coût réel Grok contre sa liste — ce
 * prix ne se baisse qu'avec `MESURE.horsSolde` (coût réel de chaque image payée).
 */
function prixFixeImageUsd({ fournisseur, modele, n, prompt }) {
  const fid = fournisseur === 'openai' ? 'openai' : 'grok';
  const m = IMAGE.find((x) => x.fournisseur === fid && x.id === modele) || IMAGE.find((x) => x.fournisseur === fid);
  const swoge = Comp.parleDeSwoge(String(prompt || ''), []);
  return factureUsd(coutsImage(fid, m, NOMBRES.includes(Number(n)) ? Number(n) : 1, swoge, swoge).reserveUsd);
}

/**
 * Des images. q = { addr, modele, prompt, n, format, image }
 * `deps.horsSolde` : payée AILLEURS (x402, d'avance) — ni réserve ni règlement
 * sur un solde de jeu ; le coût réel est quand même lu et compté.
 */
async function images(q, deps) {
  const addr = q && q.addr;
  if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
  const fid = q.fournisseur === 'openai' ? 'openai' : 'grok';
  const m = IMAGE.find((x) => x.fournisseur === fid && x.id === q.modele) || IMAGE.find((x) => x.fournisseur === fid);
  const four = (deps.fournisseurs && deps.fournisseurs[fid]) || (fid === 'grok' ? deps.fournisseur : null);
  if (!four || (four.actif && !four.actif())) return { ok: false, code: 503, raison: (fid === 'openai' ? 'ChatGPT Image' : 'Grok Imagine') + ' is not switched on yet.' };
  const prompt = String(q.prompt || '').trim().slice(0, PROMPT_MAX);
  if (!prompt) return { ok: false, code: 400, raison: 'describe the image to create' };
  const n = NOMBRES.includes(Number(q.n)) ? Number(q.n) : 1;
  const format = FORMATS_IMAGE.includes(q.format) ? q.format : 'auto';
  const image = imageJointe(q.image);
  if (image === false) return { ok: false, code: 400, raison: 'the attached image must be a PNG, JPEG or WebP under 6 MB' };
  if (EN_VOL.has(addr)) return { ok: false, code: 429, raison: 'one generation at a time' };
  if (!rythmeOk(addr, q.maintenant || Date.now())) return { ok: false, code: 429, raison: 'too many generations — wait a minute' };
  /* ---- COMPRENDRE AVANT DE DESSINER (26 septembre 2026, voir studio_comprend.js) ----
   * Une demande qui nomme SWOGE (elle, ou le fil auquel elle renvoie) part avec
   * l'image officielle quand le joueur n'a rien joint ; une demande qui a un
   * fil derriere elle est reecrite en une consigne complete. */
  const contexte = Comp.contexteDe(q.contexte);
  const refSwoge = !image && deps.reference && Comp.parleDeSwoge(prompt, contexte) ? await deps.reference() : null;
  const envoyee = image || refSwoge || null;
  const reecrit = !!(deps.comprend && contexte.length);
  const { listeUsd, reserveUsd } = coutsImage(fid, m, n, !!envoyee, reecrit);
  const r = deps.horsSolde ? { cours: null, wei: 0n } : await reserve(deps, addr, reserveUsd);
  if (r.erreur) return r.erreur;
  const rend = () => { if (!deps.horsSolde) deps.solde.regle(addr, r.wei, 0n); };
  EN_VOL.add(addr);
  let rep, compris = { prompt, coutUsd: 0, reecrit: false };
  try {
    if (reecrit || refSwoge) compris = await Comp.comprend({ prompt, contexte: reecrit ? contexte : [], reference: image ? 'jointe' : refSwoge ? 'swoge' : null }, deps.comprend ? deps.comprend.deps : {});
    rep = await four.images({ api: m.api || modeleOpenai(), prompt: compris.prompt.slice(0, PROMPT_MAX), n, format, image: envoyee, qualite: m.qualite });
  } catch (e) {
    rend(); MESURE.echecs++; EN_VOL.delete(addr);
    return { ok: false, code: 502, raison: 'the image provider failed — you were not charged', detail: String(e && e.message || e).slice(0, 200) };
  }
  EN_VOL.delete(addr);
  if (!rep.urls || !rep.urls.length) {
    rend(); MESURE.echecs++;
    return { ok: false, code: 502, raison: 'no image came back (possibly refused by moderation) — you were not charged' };
  }
  MESURE.images += rep.urls.length;
  /* La reecriture est un vrai cout : elle s'ajoute a celui de l'image. */
  const brut = fid === 'openai' ? coutOpenai(rep.usage) : coutDe(rep.usage);
  let f;
  if (deps.horsSolde) {
    /* Payée d'avance : on COMPTE le coût réel contre le prix fixe encaissé. */
    const c = (brut == null ? listeUsd : brut) + compris.coutUsd;
    const H = MESURE.horsSolde;
    H.images += rep.urls.length; H.coutUsd += c; H.prixUsd += Number(q.prixUsd) || 0; if (brut == null) H.sansUsage++;
    MESURE.coutUsd += c;
    f = { coutUsd: Number(c.toFixed(5)) };
  } else f = regle(deps, addr, r.wei, r.cours, brut == null ? null : brut + compris.coutUsd, listeUsd + compris.coutUsd);
  /* Les images en base64 (OpenAI) sont rangees chez nous : la page recoit une
     adresse, pas des megaoctets (voir studio_fichiers.js). */
  const urls = rep.urls.map((u) => (/^data:/.test(u) && deps.range ? (deps.range(u) || u) : u));
  return Object.assign({ ok: true, genre: 'image', fournisseur: fid, modele: m.id, urls, retouche: !!envoyee,
    reference: image ? 'jointe' : refSwoge ? 'swoge' : null, compris: compris.reecrit || refSwoge ? compris.prompt : null }, f);
}

/** Lance une vidéo. q = { addr, modele, prompt, duree, resolution, format, image } */
async function lanceVideo(q, deps) {
  const addr = q && q.addr;
  if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
  /* Des references imposent le modele qui les comprend : « grok-imagine-video-1.5 ». */
  const avecRefs = (Array.isArray(q.references) && q.references.length) || (Array.isArray(q.voix) && q.voix.length);
  const m = avecRefs ? VIDEO.find((x) => x.api === 'grok-imagine-video-1.5') : (VIDEO.find((x) => x.id === q.modele) || VIDEO[0]);
  const prompt = String(q.prompt || '').trim().slice(0, PROMPT_MAX);
  const image = imageJointe(q.image);
  if (image === false) return { ok: false, code: 400, raison: 'the attached image must be a PNG, JPEG or WebP under 6 MB' };
  if (!prompt && !image) return { ok: false, code: 400, raison: 'describe the video, or attach an image to animate' };
  /* Les references (series, pubs) : des images (data URL, ou une adresse publique
     d'un fichier range chez nous) et des voix du catalogue, trois au plus chacune. */
  const refs = Array.isArray(q.references) ? q.references : [];
  const voix = Array.isArray(q.voix) ? q.voix.map((v) => String(v).toLowerCase()) : [];
  if (refs.length > REFERENCES_MAX || voix.length > REFERENCES_MAX) return { ok: false, code: 400, raison: 'at most ' + REFERENCES_MAX + ' reference images and ' + REFERENCES_MAX + ' voices per scene' };
  if (refs.some((r) => !(imageJointe(r) || (deps.referenceOk && deps.referenceOk(r))))) return { ok: false, code: 400, raison: 'each reference must be a PNG, JPEG or WebP under 6 MB' };
  if (voix.some((v) => !voixPermises().includes(v))) return { ok: false, code: 400, raison: 'unknown voice — pick one of ' + voixPermises().join(', ') };
  if ((refs.length || voix.length) && image) return { ok: false, code: 400, raison: 'use either a start image or references, not both' };
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
  const fv = (deps.fournisseurs && deps.fournisseurs.grok) || deps.fournisseur;
  if (!fv || (fv.actif && !fv.actif())) { deps.solde.regle(addr, r.wei, 0n); return { ok: false, code: 503, raison: 'Video is not switched on yet (Grok Imagine).' }; }
  try { rid = await fv.lanceVideo({ api: m.api, prompt, duree, resolution, format, image, references: refs.length ? refs.map((r) => (deps.urlReference ? deps.urlReference(r) : r)) : undefined, voix: voix.length ? voix : undefined }); }
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
  try { v = await ((deps.fournisseurs && deps.fournisseurs.grok) || deps.fournisseur).litVideo(job.rid); } catch (e) { v = null; }
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

module.exports = { VOIX, voixPermises, REFERENCES_MAX, pireCasImageUsd, prixFixeImageUsd, coutsImage, FOURNISSEURS_IMAGE, PRIX_OPENAI, coutOpenai, modeleOpenai, IMAGE, VIDEO, FORMATS_IMAGE, FORMATS_VIDEO, NOMBRES, DUREES, RESOLUTIONS, RESERVE_X,
                   MESURE, JOBS, EN_VOL, RYTHME, catalogue, images, lanceVideo, avance, etatVideo, imageJointe, coutDe };
