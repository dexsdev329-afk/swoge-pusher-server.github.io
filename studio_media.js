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
 *
 * ---- UNE VIDÉO AU CRÉDIT EN DOLLARS (14 octobre 2026) ----
 * Payée au crédit (credits.js), une vidéo prend une réserve DURABLE : son
 * identifiant xAI, son départ et sa liste sont écrits AVEC la réserve, dans le
 * fichier du crédit. Au redémarrage elle n'est pas rendue : `reprendVideos`
 * remet la vidéo dans JOBS sous le MÊME identifiant (la page continue de la
 * suivre) et le suivi la règle une fois — coût réel × marge à l'arrivée, tout
 * rendu si elle échoue ou dépasse VIDEO_MAX_MS (compté depuis son départ, arrêt
 * compris). Le $SWOGE ne change pas : sa réserve vit dans le solde de jeu et la
 * vidéo, en mémoire seulement (voir EXPLOITATION.md, 14/10).
 * ================================================================== */

const crypto = require('crypto');
const config = require('./config');
const studio = require('./studio');
const Comp = require('./studio_comprend');   /* la demande comprise avec son fil, et la reference SWOGE */
const AlerteSolde = require('./alerte_solde'); /* credit epuise chez un fournisseur : alerte privee */

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
  /* ---- « Free » (18 octobre 2026, studio_gratuit.js) ----
   * Rien a payer, rien a facturer : Pollinations (~5 s, filigrane) et SDXL chez
   * OVH (~66 s). Une image par demande, pas de retouche, au plus
   * GRATUIT_IMAGES_JOUR par joueur et par jour. */
  { id: 'rapide', fournisseur: 'gratuit', nom: 'Fast (~5 s, watermarked)', api: 'pollinations', usd: 0 },
  { id: 'qualite', fournisseur: 'gratuit', nom: 'SDXL (~1 min)', api: 'sdxl', usd: 0 },
];
const FOURNISSEURS_IMAGE = [{ id: 'grok', nom: 'Grok Imagine' }, { id: 'openai', nom: 'ChatGPT Image' }, { id: 'gratuit', nom: 'Free' }];
const GRATUIT_IMAGES_JOUR = () => Math.max(1, Number(process.env.STUDIO_GRATUIT_IMAGES_JOUR || 10));
/* adresse (minuscules) -> { jour, n } ; en memoire, comme le quota du chat gratuit. */
const QUOTA_GRATUIT = new Map();
const jourUtc = (t) => new Date(t).toISOString().slice(0, 10);
function imagesGratuitesRestantes(addr, t) {
  const q = QUOTA_GRATUIT.get(String(addr).toLowerCase());
  return Math.max(0, GRATUIT_IMAGES_JOUR() - (q && q.jour === jourUtc(t || Date.now()) ? q.n : 0));
}
function prendImageGratuite(addr, t) {
  const k = String(addr).toLowerCase(), j = jourUtc(t || Date.now()), q = QUOTA_GRATUIT.get(k);
  QUOTA_GRATUIT.set(k, q && q.jour === j ? { jour: j, n: q.n + 1 } : { jour: j, n: 1 });
}
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
  /* Vidéos au crédit retrouvées au démarrage : reprises (suivies), ou rendues faute d'identifiant xAI. */
  reprises: 0, reprisesRendues: 0,
  /* Les images gratuites (18/10) : servies, refusees par le garde, echecs du service. */
  gratuites: { n: 0, refus: 0, echecs: 0 },
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
/* Le meme prix en dollars, pour le credit (credits.js, 29/09) : il ne depend pas du cours. */
function pourUsd(usd) { return Math.ceil(factureUsd(usd) * 1e4) / 1e4; }

/** Le catalogue montré à la page : modèles, options, prix typiques en $SWOGE. */
function catalogue(cours, actifs) {
  /* `actifs` : { grok, openai, gratuit } — ou un booleen (l'ancien appel : Grok seul). */
  const a = (actifs && typeof actifs === 'object') ? actifs : { grok: !!actifs, openai: false };
  const actif = !!a.grok;
  const p = prixOpenai();
  const image = {
    fournisseurs: FOURNISSEURS_IMAGE.map((f) => ({ id: f.id, nom: f.nom, actif: !!a[f.id],
      gratuit: f.id === 'gratuit' || undefined,
      modeles: IMAGE.filter((m) => m.fournisseur === f.id).map((m) => (m.fournisseur === 'gratuit'
        ? { id: m.id, nom: m.nom, parImageSwoge: 0, parImageUsd: 0, gratuit: true }
        : m.fournisseur === 'openai'
        ? { id: m.id, nom: m.nom, parImageSwoge: pourSwoge(OPENAI_MESURE_SORTIE * p.o / 1e6, cours), parImageUsd: pourUsd(OPENAI_MESURE_SORTIE * p.o / 1e6), estime: true }
        : { id: m.id, nom: m.nom, parImageSwoge: pourSwoge(m.usd, cours), parImageUsd: pourUsd(m.usd) })) })),
    formats: FORMATS_IMAGE, nombres: NOMBRES, gratuitJour: GRATUIT_IMAGES_JOUR(),
  };
  /* Compatibilite : l'ancienne page lit image.modeles (Grok). */
  image.modeles = image.fournisseurs[0].modeles;
  return {
    /* Le gratuit ne lit pas le cours : la generation d'images reste ouverte pour lui seul. */
    ouvert: ((!!a.grok || !!a.openai) && cours > 0) || !!a.gratuit,
    videoOuverte: actif && cours > 0,
    note: !(a.grok || a.openai) ? (a.gratuit ? 'Only the free image models are on right now.' : 'Image and video generation is not switched on yet (the provider key is not set on the server).')
      : !(cours > 0) ? 'The $SWOGE price is unavailable right now — generation is paused so nobody is overcharged.' : null,
    videoNote: !actif ? 'Video is not switched on yet (the Grok Imagine key is not set on the server).'
      : !(cours > 0) ? 'The $SWOGE price is unavailable right now — generation is paused so nobody is overcharged.' : null,
    marge: MARGE(),
    image,
    /* `credit` : la route accepte payeur 'credit' pour une video (14/10, reserve durable). Les prix en
       dollars sont la MEME liste × marge que le $SWOGE (pourUsd), sans conversion par le cours. */
    video: { credit: true,
             modeles: VIDEO.map((m) => ({ id: m.id, nom: m.nom, parSecondeSwoge: pourSwoge(m.usdSeconde, cours),
                                           typiqueSwoge: pourSwoge(m.usdSeconde * DUREES[0], cours),
                                           parSecondeUsd: pourUsd(m.usdSeconde), typiqueUsd: pourUsd(m.usdSeconde * DUREES[0]) })),
             formats: FORMATS_VIDEO, durees: DUREES, resolutions: RESOLUTIONS },
  };
}

/* Rend ou règle une réserve : par son jeton quand elle est DURABLE (crédit, vidéo), sinon par
   (adresse, montant) comme toujours. Une réserve durable déjà réglée rend null : rien ne bouge. */
function regleSolde(deps, addr, reserveWei, fWei, jeton) {
  return jeton ? deps.solde.regleJeton(jeton, fWei) : deps.solde.regle(addr, reserveWei, fWei);
}

/* Règle une réserve : facture le coût réel (ou la liste, comptée), jamais plus que la réserve. */
function regle(deps, addr, reserveWei, cours, cout, listeUsd, jeton) {
  const dec = config.DECIMALS || 18;
  let c = cout;
  if (c == null) { MESURE.sansUsage++; c = listeUsd; }
  const f = factureUsd(c);
  let fWei = studio.montantBaseDe(f, cours, dec);
  if (fWei > reserveWei) { MESURE.depassements++; console.error('[studio] DÉPASSEMENT de réserve : ' + f.toFixed(4) + ' $'); fWei = reserveWei; }
  const solde = regleSolde(deps, addr, reserveWei, fWei, jeton);
  MESURE.coutUsd += c; MESURE.factureUsd += f;
  return { solde, factureSwoge: studio.formateBase(fWei, dec), factureUsd: Number(f.toFixed(5)) };
}

/* `info` : avec un solde DURABLE (deps.solde.durable, le credit pour une video), la reserve garde
   ce qu'il faut pour reprendre le travail apres un redemarrage, et son jeton est rendu. */
async function reserve(deps, addr, usd, info) {
  const cours = await deps.cours();
  if (!(cours > 0)) return { erreur: { ok: false, code: 503, raison: 'the $SWOGE price is unavailable — try again shortly' } };
  const dec = config.DECIMALS || 18;
  const wei = studio.montantBaseDe(factureUsd(usd), cours, dec);
  const durable = !!(info && deps.solde.durable);
  const j = durable ? deps.solde.reserve(addr, wei, info) : deps.solde.reserve(addr, wei);
  if (!j) {
    return { erreur: { ok: false, code: 402, raison: 'balance too low for this generation', requisSwoge: studio.formateBase(wei, dec) } };
  }
  return { cours, wei, jeton: durable ? j : null };
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
  /* Le gratuit n'existe que pour la page (canal studio, solde de jeu ou credit) : jamais revendu en
     x402 ni par une cle d'agent — un autre fournisseur demande y retombe sur Grok, comme avant. */
  const gratuitOk = q.fournisseur === 'gratuit' && !deps.horsSolde && (!q.canal || q.canal === 'studio');
  const fid = q.fournisseur === 'openai' ? 'openai' : gratuitOk ? 'gratuit' : 'grok';
  const m = IMAGE.find((x) => x.fournisseur === fid && x.id === q.modele) || IMAGE.find((x) => x.fournisseur === fid);
  const four = (deps.fournisseurs && deps.fournisseurs[fid]) || (fid === 'grok' ? deps.fournisseur : null);
  if (!four || (four.actif && !four.actif())) return { ok: false, code: 503, raison: (fid === 'openai' ? 'ChatGPT Image' : fid === 'gratuit' ? 'Free image generation' : 'Grok Imagine') + ' is not switched on yet.' };
  const prompt = String(q.prompt || '').trim().slice(0, PROMPT_MAX);
  if (!prompt) return { ok: false, code: 400, raison: 'describe the image to create' };
  if (fid === 'gratuit') return imageGratuite(q, deps, { addr, m, four, prompt });
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
    AlerteSolde.erreur(fid === 'openai' ? 'openai' : 'xai', e);   /* credit epuise : alerte privee (09/10) */
    return { ok: false, code: 502, raison: 'the image provider failed — you were not charged', detail: String(e && e.message || e).slice(0, 200) };
  }
  EN_VOL.delete(addr);
  if (!rep.urls || !rep.urls.length) {
    rend(); MESURE.echecs++;
    return { ok: false, code: 502, raison: 'no image came back (possibly refused by moderation) — you were not charged' };
  }
  MESURE.images += rep.urls.length;
  AlerteSolde.succes(fid === 'openai' ? 'openai' : 'xai');
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
  /* Les compteurs durables (compteurs.js) : facturé contre coût RÉEL, seulement
     quand le fournisseur a dit son coût (sinon null : la marge ne se mesure pas sur une liste). */
  if (deps.note) {
    try {
      deps.note('image_facturee', { outil: 'generate_image', canal: q.canal || (deps.horsSolde ? 'rest' : 'studio'), qui: addr, sorte: fid + '/' + m.id,
        usd: deps.horsSolde ? (Number(q.prixUsd) || 0) : f.factureUsd, coutUsd: brut == null ? null : brut + compris.coutUsd });
    } catch (e) { /* jamais bloquant */ }
  }
  /* Les images en base64 (OpenAI) sont rangees chez nous : la page recoit une
     adresse, pas des megaoctets (voir studio_fichiers.js). */
  const urls = rep.urls.map((u) => (/^data:/.test(u) && deps.range ? (deps.range(u) || u) : u));
  return Object.assign({ ok: true, genre: 'image', fournisseur: fid, modele: m.id, urls, retouche: !!envoyee,
    reference: image ? 'jointe' : refSwoge ? 'swoge' : null, compris: compris.reecrit || refSwoge ? compris.prompt : null }, f);
}

/* Une image gratuite : une seule, sans photo jointe ni reecriture (la reecriture se paie), ni
   reserve ni facture. Le quota se prend a l'image LIVREE ; un refus du garde ne le prend pas. */
async function imageGratuite(q, deps, { addr, m, four, prompt }) {
  const t = q.maintenant || Date.now();
  if (q.image) return { ok: false, code: 400, raison: 'the free models can\'t edit a photo — pick Grok Imagine or ChatGPT Image, or remove the photo' };
  if (!imagesGratuitesRestantes(addr, t)) return { ok: false, code: 429, gratuitRestant: 0, raison: 'you have used your ' + GRATUIT_IMAGES_JOUR() + ' free images for today — they come back at midnight UTC, or pick a paid model' };
  if (EN_VOL.has(addr)) return { ok: false, code: 429, raison: 'one generation at a time' };
  if (!rythmeOk(addr, t)) return { ok: false, code: 429, raison: 'too many generations — wait a minute' };
  const format = FORMATS_IMAGE.includes(q.format) ? q.format : 'auto';
  EN_VOL.add(addr);
  let rep;
  try { rep = await four.images({ api: m.api, prompt, n: 1, format }); }
  catch (e) {
    EN_VOL.delete(addr);
    if (e && e.refus) { MESURE.gratuites.refus++; return { ok: false, code: 400, gratuit: true, raison: e.raison || 'this request was refused by the free model\'s safety check' }; }
    MESURE.gratuites.echecs++;
    return { ok: false, code: 502, gratuit: true, raison: 'the free image service failed — try again, or pick a paid model', detail: String(e && e.message || e).slice(0, 200) };
  }
  EN_VOL.delete(addr);
  if (!rep || !rep.urls || !rep.urls.length) { MESURE.gratuites.echecs++; return { ok: false, code: 502, gratuit: true, raison: 'no image came back — try again' }; }
  prendImageGratuite(addr, t);
  MESURE.gratuites.n++;
  if (deps.note) { try { deps.note('image_gratuite', { outil: 'generate_image', canal: 'studio', qui: addr, sorte: 'gratuit/' + m.id, usd: 0, coutUsd: 0 }); } catch (e) { /* jamais bloquant */ } }
  const urls = rep.urls.map((u) => (/^data:/.test(u) && deps.range ? (deps.range(u) || u) : u));
  return { ok: true, genre: 'image', fournisseur: 'gratuit', modele: m.id, urls, retouche: false, reference: null, compris: null,
    gratuit: true, factureSwoge: '0', factureUsd: 0, gratuitRestant: imagesGratuitesRestantes(addr, t) };
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
  /* La suite d'une scene (27/09) : la derniere image de la scene d'avant, posee
     par le serveur (jamais par le joueur), part EN PLUS des references. La
     specification d'xAI ne dit pas si `image` et `reference_images` se
     combinent : si le fournisseur refuse, on relance avec la premiere image
     seule — c'est elle qui porte la suite — dans la meme reservation. */
  const debut = q.debut ? imageJointe(q.debut) : null;
  if (debut === false) return { ok: false, code: 400, raison: 'the continuation frame could not be read' };
  const duree = DUREES.includes(Number(q.duree)) ? Number(q.duree) : DUREES[0];
  const resolution = RESOLUTIONS.includes(q.resolution) ? q.resolution : RESOLUTIONS[0];
  const format = FORMATS_VIDEO.includes(q.format) ? q.format : 'auto';
  for (const j of JOBS.values()) if (j.addr === addr && j.status === 'pending') return { ok: false, code: 429, raison: 'one video at a time — wait for the current one' };
  const t = q.maintenant || Date.now();
  if (!rythmeOk(addr, t)) return { ok: false, code: 429, raison: 'too many generations — wait a minute' };
  const listeUsd = m.usdSeconde * duree;
  const id = crypto.randomBytes(12).toString('hex');
  const canal = q.canal || 'studio';
  /* Au credit, la reserve est DURABLE : elle porte deja l'identifiant de la video et sa liste ;
     l'identifiant xAI s'y ajoute des qu'xAI repond (sans lui, la reprise la rend). */
  const r = await reserve(deps, addr, listeUsd * RESERVE_X, { genre: 'video', id, addr, canal, modele: m.id, duree, resolution, t0: t, listeUsd });
  if (r.erreur) return r.erreur;
  const rend = () => regleSolde(deps, addr, r.wei, 0n, r.jeton);
  let rid;
  const fv = (deps.fournisseurs && deps.fournisseurs.grok) || deps.fournisseur;
  if (!fv || (fv.actif && !fv.actif())) { rend(); return { ok: false, code: 503, raison: 'Video is not switched on yet (Grok Imagine).' }; }
  let seule = false;
  try { rid = await fv.lanceVideo({ api: m.api, prompt, duree, resolution, format, image: image || debut || undefined, references: refs.length ? refs.map((r) => (deps.urlReference ? deps.urlReference(r) : r)) : undefined, voix: voix.length ? voix : undefined }); }
  catch (e) {
    let e2 = e;
    if (debut && (refs.length || voix.length)) {
      try { rid = await fv.lanceVideo({ api: m.api, prompt, duree, resolution, format, image: debut }); seule = true; MESURE.suitesSeules = (MESURE.suitesSeules || 0) + 1; e2 = null; }
      catch (e3) { e2 = e3; }
    }
    if (e2) {
      rend(); MESURE.echecs++;
      AlerteSolde.erreur('xai', e2);   /* credit epuise : alerte privee (09/10) */
      return { ok: false, code: 502, raison: 'the video provider failed — you were not charged', detail: String(e2 && e2.message || e2).slice(0, 200) };
    }
  }
  if (r.jeton) deps.solde.attache(r.jeton, { rid, reserveWei: String(r.wei) });
  AlerteSolde.succes('xai');
  const job = { id, rid, addr, canal, modele: m.id, duree, resolution, t0: t, status: 'pending', progress: 0,
                reserveWei: r.wei, cours: r.cours, listeUsd, url: null, factureSwoge: null, solde: null, raison: null,
                jeton: r.jeton || null, payeur: r.jeton ? 'credit' : null };
  JOBS.set(id, job);
  if (!deps.sansBoucle) suit(job, deps);
  return { ok: true, genre: 'video', id, status: 'pending', duree, resolution, modele: m.id, suite: !!debut, suiteSeule: seule };
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
    Object.assign(job, regle(deps, job.addr, job.reserveWei, job.cours, coutDe(v.usage), job.listeUsd * secondes / job.duree, job.jeton));
    MESURE.videos++;
    if (deps.note) {
      try { deps.note('video_facturee', { outil: 'generate_video', canal: job.canal || 'studio', qui: job.addr, sorte: job.modele, usd: job.factureUsd, coutUsd: coutDe(v.usage) }); }
      catch (e) { /* jamais bloquant */ }
    }
  } else if (v && (v.status === 'failed' || v.status === 'expired')) {
    job.status = 'failed'; job.raison = 'the video could not be generated' + (v.erreur ? ' (' + v.erreur + ')' : '') + ' — you were not charged';
    job.solde = regleSolde(deps, job.addr, job.reserveWei, 0n, job.jeton); MESURE.echecs++;
  } else if (t - job.t0 > VIDEO_MAX_MS()) {
    /* Trop long : on rend tout. Si xAI la livre plus tard, c'est la maison qui paie. */
    job.status = 'failed'; job.raison = 'the video took too long — you were not charged';
    job.solde = regleSolde(deps, job.addr, job.reserveWei, 0n, job.jeton); MESURE.echecs++;
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
  const o = { ok: true, genre: 'video', id: j.id, status: j.status, progress: j.progress, url: j.url,
           duree: j.duree, resolution: j.resolution, modele: j.modele, factureSwoge: j.factureSwoge, factureUsd: j.factureUsd || null,
           solde: j.solde, raison: j.raison };
  /* Au credit : des dollars, jamais sous les noms $SWOGE (la page les lirait comme tels, cf. enCredit
     du serveur). Le montant facture est celui retenu sur le credit (cours 1 : 10^18 unites = 1 $). */
  if (j.payeur === 'credit') {
    o.payeur = 'credit';
    if (j.factureSwoge != null) o.factureUsd = Number(j.factureSwoge);
    if (j.solde != null) o.creditUsd = Number(j.solde);
    delete o.factureSwoge; delete o.solde;
  }
  return o;
}

/**
 * Au démarrage : les vidéos payées au crédit restées en cours (réserves durables, credits.js).
 * `durables` : credits.durables() ; `deps` : celles du crédit (deps.solde = credits.soldeDurable).
 * Avec son identifiant xAI, la vidéo revient dans JOBS sous le même identifiant et son suivi
 * reprend ; sans (arrêt entre la réserve et la réponse d'xAI), la réserve est rendue entière.
 */
function reprendVideos(deps, durables) {
  const bilan = { reprises: 0, rendues: 0 };
  for (const d of durables || []) {
    const i = d.info || {};
    if (i.genre !== 'video') continue;
    if (i.id && JOBS.has(i.id)) continue;
    let w = null;
    try { w = BigInt(String(i.reserveWei)); } catch (e) { w = null; }
    if (!i.rid || !i.id || !(w > 0n)) {
      deps.solde.regleJeton(d.id, 0n);
      MESURE.reprisesRendues++; bilan.rendues++;
      continue;
    }
    /* i.addr : l'adresse de session telle quelle (le credit range ses cles en minuscules) — c'est
       elle qu'etatVideo compare, comme pour une video lancee sans redemarrage. */
    const job = { id: i.id, rid: i.rid, addr: i.addr || d.addr, canal: i.canal || 'studio', modele: i.modele, duree: Number(i.duree) || DUREES[0],
                  resolution: i.resolution, t0: Number(i.t0) || Number(d.t) || Date.now(), status: 'pending', progress: 0,
                  reserveWei: w, cours: 1, listeUsd: Number(i.listeUsd) || 0, url: null, factureSwoge: null, solde: null, raison: null,
                  jeton: d.id, payeur: 'credit', reprise: true };
    JOBS.set(job.id, job);
    MESURE.reprises++; bilan.reprises++;
    if (!deps.sansBoucle) suit(job, deps);
  }
  return bilan;
}

module.exports = { GRATUIT_IMAGES_JOUR, QUOTA_GRATUIT, imagesGratuitesRestantes, VOIX, voixPermises, REFERENCES_MAX, pireCasImageUsd, prixFixeImageUsd, coutsImage, FOURNISSEURS_IMAGE, PRIX_OPENAI, coutOpenai, modeleOpenai, IMAGE, VIDEO, FORMATS_IMAGE, FORMATS_VIDEO, NOMBRES, DUREES, RESOLUTIONS, RESERVE_X,
                   MESURE, JOBS, EN_VOL, RYTHME, catalogue, images, lanceVideo, avance, etatVideo, reprendVideos, imageJointe, coutDe };
