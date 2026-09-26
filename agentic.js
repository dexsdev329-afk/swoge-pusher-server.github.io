'use strict';
/* ==================================================================
 * SWOGEAGENTIC — LES OUTILS DE SWOGE, VENDUS À L'APPEL AUX AUTRES AGENTS
 * ==================================================================
 *
 * Le modèle de HYRE (relu le 26 septembre 2026 sur hyreagent.fun) : des
 * outils payés à l'appel, un devis avant d'exécuter, un reçu par appel. Ici,
 * la monnaie est le solde $SWOGE du joueur, débité par sa clé d'API
 * (agentic_cles.js) — chaque appel payé donne un usage au jeton.
 *
 * Les outils sont LES MÊMES fonctions que l'agent de la page
 * (`studio_agent.outils`) : un seul code pour lire un jeton, la colonie,
 * l'économie, le web. Plus `ask_agent` : la tâche entière confiée à
 * SwogeAgentic, facturée au réel comme dans la page.
 *
 * ---- LES PRIX ----
 * Ce ne sont PAS des mesures : ce sont des prix de départ fixés le 26
 * septembre 2026, dans la fourchette publiée par HYRE (0,001 à 0,60 $ par
 * appel), modifiables sans toucher au code (`AGENTIC_PRIX`, JSON
 * {outil: usd}). Les lectures de DexScreener, GoPlus et de la colonie ne nous
 * coûtent rien ; la recherche web coûte 0,005 $ chez Perplexity et se vend à
 * ce coût × STUDIO_MARGE, comme dans le chat. Un appel refusé (entrée
 * invalide, outil en panne) n'est JAMAIS facturé.
 * ================================================================== */

const crypto = require('crypto');
const studio = require('./studio');
const config = require('./config');
const Chat = require('./studio_chat');
const Agent = require('./studio_agent');
const Rech = require('./studio_recherche');

const Media = require('./studio_media');

/* Ajoutes le 26 septembre 2026 (etape 3) : les lancements du moment, le
   renseignement sur un lanceur, l'OSINT d'infrastructure — memes reperes de
   prix (lire nos propres donnees ne nous coute rien ; l'OSINT interroge des
   services tiers, d'ou un prix plus haut). Prix de depart, pas des mesures. */
const PRIX_DEFAUT = { scan_token: 0.01, colony_activity: 0.005, swoge_economy: 0.001,
  new_launches: 0.005, wallet_intel: 0.02, osint_lookup: 0.02,
  /* 26 septembre 2026 : les appels Telegram suivis. Nos propres donnees, lues sans
     appel payant : le prix de depart des lectures, pas une mesure. */
  telegram_calls: 0.01 };
const VARIABLES = ['ask_agent', 'generate_image', 'generate_video'];
/* `video_status` : gratuit (relire SA vidéo), jamais facturé. */
const GRATUITS = ['video_status'];
const APPELS_PAR_MINUTE = 60;
const TACHE_MAX_CAR = 4000;

function prixUsd(outil) {
  let o = {};
  try { o = JSON.parse(process.env.AGENTIC_PRIX || '{}') || {}; } catch (e) { o = {}; }
  if (Number(o[outil]) > 0) return Number(o[outil]);
  if (outil === 'web_search') return Chat.factureUsd(Rech.PRIX_USD);
  return PRIX_DEFAUT[outil] || null;
}

/**
 * Le prix d'un appel payé D'AVANCE (x402, montant exact) : le prix fixe d'un
 * outil, ou pour une image le pire cas de CETTE demande (fournisseur, qualité,
 * nombre) — voir Media.prixFixeImageUsd. null : pas payable d'avance.
 */
function prixX402Usd(outil, args) {
  if (outil === 'generate_image') {
    const a = args || {};
    return Media.prixFixeImageUsd({ fournisseur: a.provider === 'openai' ? 'openai' : 'grok', modele: a.quality === 'speed' ? 'rapide' : 'qualite',
      n: Number(a.count || 1), prompt: a.prompt });
  }
  if (VARIABLES.includes(outil) || GRATUITS.includes(outil)) return null;
  return prixUsd(outil);
}

/** Les définitions publiques : celles de l'agent, plus `ask_agent`. */
function definitions(actifs) {
  const base = Agent.definitions({ recherche: !!(actifs && actifs.recherche) })
    .map((d) => ({ name: d.name, description: d.description, inputSchema: d.input_schema }));
  base.push({ name: 'ask_agent', description: 'Give a whole task to SwogeAgentic (a Claude agent that chains the tools above and answers with the numbers it read, with sources). Billed at its real cost, up to the quoted maximum. Takes 10 to 60 seconds.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'what you want researched, in any language' },
      model: { type: 'string', enum: Chat.MODELES.filter((m) => m.fournisseur === 'anthropic').map((m) => m.id), description: 'optional Claude model (default sonnet-5)' } }, required: ['task'] } });
  base.push({ name: 'generate_image', description: 'Create an image with Grok Imagine or ChatGPT Image. A prompt that names SWOGE is drawn from the official SWOGE character. With an API key: billed at its real cost, up to the quoted maximum. Without a key (x402): a fixed price per request, quoted in the 402. Returns image URLs.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'what to draw, in any language' },
      provider: { type: 'string', enum: ['grok', 'openai'], description: 'grok (Grok Imagine, default) or openai (ChatGPT Image)' },
      quality: { type: 'string', enum: ['speed', 'quality'], description: 'speed (cheaper) or quality (default)' },
      aspect_ratio: { type: 'string', enum: Media.FORMATS_IMAGE, description: 'image shape (default auto)' },
      count: { type: 'integer', enum: [1, 2, 4], description: 'how many images (default 1)' } }, required: ['prompt'] } });
  base.push({ name: 'generate_video', description: 'Create a short video with Grok Imagine (6 or 10 seconds). API key only: billed at its real cost when the video arrives, up to the quoted maximum, nothing if it fails. Returns a video id — poll it with video_status (free).',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'what happens in the video, in any language' },
      quality: { type: 'string', enum: ['speed', 'quality'], description: 'speed (default) or quality (Grok Imagine Video 1.5)' },
      duration: { type: 'integer', enum: Media.DUREES, description: 'seconds (default ' + Media.DUREES[0] + ')' },
      resolution: { type: 'string', enum: Media.RESOLUTIONS, description: 'default ' + Media.RESOLUTIONS[0] },
      aspect_ratio: { type: 'string', enum: Media.FORMATS_VIDEO, description: 'video shape (default auto)' } }, required: ['prompt'] } });
  base.push({ name: 'video_status', description: 'Read the status of a video you started (pending, done with its URL, or failed and not charged). Free.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'the id returned by generate_video' } }, required: ['id'] } });
  return base;
}

/** Une entrée invalide est refusée AVANT tout débit. Rend une phrase, ou null. */
function entreeInvalide(outil, a) {
  a = a || {};
  if (outil === 'scan_token' && !/^0x[0-9a-fA-F]{40}$/.test(String(a.address || ''))) return 'address must be 0x followed by 40 hex characters';
  if (outil === 'web_search' && !String(a.query || '').trim()) return 'query is required';
  if (outil === 'ask_agent' && !String(a.task || '').trim()) return 'task is required';
  if (outil === 'ask_agent' && String(a.task).length > TACHE_MAX_CAR) return 'task is too long (max ' + TACHE_MAX_CAR + ' characters)';
  if (outil === 'generate_image' && !String(a.prompt || '').trim()) return 'prompt is required';
  if (outil === 'generate_image' && String(a.prompt).length > TACHE_MAX_CAR) return 'prompt is too long (max ' + TACHE_MAX_CAR + ' characters)';
  if (outil === 'generate_image' && a.provider !== undefined && !['grok', 'openai'].includes(a.provider)) return 'provider must be grok or openai';
  if (outil === 'generate_image' && a.count !== undefined && ![1, 2, 4].includes(Number(a.count))) return 'count must be 1, 2 or 4';
  if ((outil === 'generate_image' || outil === 'generate_video') && a.quality !== undefined && !['speed', 'quality'].includes(a.quality)) return 'quality must be speed or quality';
  if (outil === 'generate_image' && a.aspect_ratio !== undefined && !Media.FORMATS_IMAGE.includes(a.aspect_ratio)) return 'aspect_ratio must be one of ' + Media.FORMATS_IMAGE.join(', ');
  if (outil === 'generate_video' && !String(a.prompt || '').trim()) return 'prompt is required';
  if (outil === 'generate_video' && String(a.prompt).length > TACHE_MAX_CAR) return 'prompt is too long (max ' + TACHE_MAX_CAR + ' characters)';
  if (outil === 'generate_video' && a.duration !== undefined && !Media.DUREES.includes(Number(a.duration))) return 'duration must be ' + Media.DUREES.join(' or ');
  if (outil === 'generate_video' && a.resolution !== undefined && !Media.RESOLUTIONS.includes(a.resolution)) return 'resolution must be ' + Media.RESOLUTIONS.join(' or ');
  if (outil === 'generate_video' && a.aspect_ratio !== undefined && !Media.FORMATS_VIDEO.includes(a.aspect_ratio)) return 'aspect_ratio must be one of ' + Media.FORMATS_VIDEO.join(', ');
  if (outil === 'video_status' && !/^[0-9a-f]{24}$/.test(String(a.id || ''))) return 'id must be the id returned by generate_video';
  if ((outil === 'wallet_intel') && !/^0x[0-9a-fA-F]{40}$/.test(String(a.address || ''))) return 'address must be 0x followed by 40 hex characters';
  if (outil === 'osint_lookup' && !String(a.target || '').trim()) return 'target is required';
  if (outil === 'telegram_calls' && a.hours !== undefined && !(Number(a.hours) >= 1 && Number(a.hours) <= 168)) return 'hours must be between 1 and 168';
  if (outil === 'telegram_calls' && a.limit !== undefined && !(Number(a.limit) >= 1 && Number(a.limit) <= 50)) return 'limit must be between 1 and 50';
  if (outil === 'telegram_calls' && a.channel !== undefined && !/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(String(a.channel))) return 'channel must be a public channel name';
  return null;
}

/** Le résultat d'un outil, en données (pour une API) ET en texte (pour un modèle). */
function resultatDe(outil, r) {
  if (outil === 'scan_token') return { donnees: { token: r.carte, sources: r.sources || [] }, texte: r.texte };
  if (outil === 'web_search') return { donnees: { results: r.sources || [] }, texte: r.texte };
  try { return { donnees: JSON.parse(r.texte), texte: r.texte }; } catch (e) { return { donnees: null, texte: r.texte }; }
}

function cree(deps) {
  /* deps : { cles (agentic_cles), cours(), solde{reserve,regle}, outils (studio_agent.outils(src)),
             actifs(){recherche}, agent({addr, tache, modele}) → résultat de studio_chat.repond } */
  const rythme = new Map();
  const dec = config.DECIMALS || 18;
  const rythmeOk = (h) => {
    const t = Date.now(), l = (rythme.get(h) || []).filter((x) => t - x < 60000);
    if (l.length >= APPELS_PAR_MINUTE) { rythme.set(h, l); return false; }
    l.push(t); rythme.set(h, l); return true;
  };

  async function catalogue() {
    const cours = await deps.cours();
    /* Les montants en $SWOGE sont des CHAINES exactes (au wei pres), comme
       `factureSwoge` du chat : un nombre JavaScript s'arrondit vers le 15e
       chiffre, et « annonce » doit egaler « debite ». */
    const enSwoge = (usd) => (cours > 0 && usd ? studio.formateBase(studio.montantBaseDe(usd, cours, dec), dec) : null);
    const act = deps.actifs ? deps.actifs() : {};
    return { ok: true, monnaie: '$SWOGE', coursUsd: cours || null,
      outils: definitions(act).map((d) => {
        if (d.name === 'generate_image') {
          const max = Media.pireCasImageUsd('openai', 'qualite', 1);
          return Object.assign({}, d, { prix: { variable: true, maxUsd: Number(max.toFixed(4)), maxSwoge: enSwoge(max), note: 'real cost, up to this maximum for one ChatGPT Image (Grok Imagine costs less)' } });
        }
        if (d.name === 'generate_video') {
          const mx = Chat.factureUsd(Media.VIDEO[Media.VIDEO.length - 1].usdSeconde * Media.DUREES[Media.DUREES.length - 1] * Media.RESERVE_X);
          return Object.assign({}, d, { prix: { variable: true, maxUsd: Number(mx.toFixed(4)), maxSwoge: enSwoge(mx), note: 'real cost when the video arrives, up to this maximum (Quality, ' + Media.DUREES[Media.DUREES.length - 1] + ' s); nothing if it fails' } });
        }
        if (d.name === 'video_status') return Object.assign({}, d, { prix: { usd: 0, swoge: '0', gratuit: true } });
        if (d.name === 'ask_agent') {
          const m = Chat.modele('sonnet-5');
          const max = Chat.factureUsd(Agent.pireCasUsd(m, [{ content: 'x'.repeat(2000) }], !!act.recherche));
          return Object.assign({}, d, { prix: { variable: true, maxUsd: Number(max.toFixed(4)), maxSwoge: enSwoge(max), note: 'real cost, up to this maximum (Sonnet 5, 2 000-character task)' } });
        }
        const u = prixUsd(d.name);
        return Object.assign({}, d, { prix: { usd: u, swoge: enSwoge(u) } });
      }) };
  }

  /**
   * Un appel d'outil par une clé. `cle` = résultat de cles.resout().
   * `devis: true` rend le prix sans rien débiter.
   */
  async function appelle({ cle, outil, args, devis }) {
    if (!cle) return { ok: false, code: 401, raison: 'missing or revoked API key — create one at swoleeswoge.dog/swogeagentic.html' };
    const defs = definitions(deps.actifs ? deps.actifs() : {});
    if (!defs.some((d) => d.name === outil)) return { ok: false, code: 404, raison: 'unknown tool: ' + outil };
    const inv = entreeInvalide(outil, args);
    if (inv) return { ok: false, code: 400, raison: inv, facture: null };
    const cours = await deps.cours();
    if (!(cours > 0)) return { ok: false, code: 503, raison: 'the $SWOGE price is unavailable — try again shortly' };

    if (outil === 'video_status') {
      if (!deps.etatVideo) return { ok: false, code: 503, raison: 'video is not switched on yet' };
      const v = deps.etatVideo(String(args.id), cle.addr);
      if (!v.ok) return { ok: false, code: v.code || 404, raison: v.raison || 'unknown video' };
      return { ok: true, outil, resultat: { id: v.id, status: v.status, progress: v.progress, url: v.url ? (deps.urlPublique ? deps.urlPublique(v.url) : v.url) : null,
        duration: v.duree, resolution: v.resolution, billedSwoge: v.factureSwoge, billedUsd: v.factureUsd, reason: v.raison },
        texte: 'Video ' + v.id + ': ' + v.status + (v.url ? ' — ' + v.url : '') + (v.raison ? ' — ' + v.raison : ''), facture: { swoge: '0', usd: 0 } };
    }

    if (outil === 'generate_video') {
      const m = args.quality === 'quality' ? Media.VIDEO[1] : Media.VIDEO[0];
      const duree = Media.DUREES.includes(Number(args.duration)) ? Number(args.duration) : Media.DUREES[0];
      const maxUsd = Chat.factureUsd(m.usdSeconde * duree * Media.RESERVE_X);
      const maxSwoge = studio.formateBase(studio.montantBaseDe(maxUsd, cours, dec), dec);
      if (devis) return { ok: true, outil, devis: { variable: true, maxSwoge, maxUsd: Number(maxUsd.toFixed(4)) } };
      if (!deps.cles.sousPlafond(cle.h, Number(maxSwoge))) return { ok: false, code: 402, raison: 'this key\'s daily cap does not leave room for this video (up to ' + maxSwoge + ' $SWOGE)' };
      if (!rythmeOk(cle.h)) return { ok: false, code: 429, raison: 'too many calls — max ' + APPELS_PAR_MINUTE + ' per minute per key' };
      if (!deps.video) return { ok: false, code: 503, raison: 'video generation is not switched on yet' };
      const r = await deps.video({ addr: cle.addr, prompt: String(args.prompt), modele: m.id, duree, resolution: args.resolution, format: args.aspect_ratio });
      if (!r || !r.ok) return { ok: false, code: (r && r.code) || 502, raison: (r && r.raison) || 'the video provider failed — you were not charged' };
      /* Le plafond du jour compte le MAXIMUM tout de suite (la facture arrive avec la vidéo). */
      const recu = crypto.randomBytes(8).toString('hex');
      deps.cles.depense(cle.h, Number(maxSwoge), { id: recu, outil, swoge: maxSwoge, usd: Number(maxUsd.toFixed(4)), maximum: true, video: r.id });
      return { ok: true, outil, resultat: { id: r.id, status: r.status, duration: r.duree, resolution: r.resolution, poll: 'video_status' },
               texte: 'Video started: ' + r.id + ' — poll it with video_status. Billed at its real cost when it arrives (up to ' + maxSwoge + ' $SWOGE), nothing if it fails.',
               facture: { swoge: '0', usd: 0, maxSwoge, maxUsd: Number(maxUsd.toFixed(4)), aLArrivee: true }, recu };
    }

    if (outil === 'generate_image') {
      const fournisseur = args.provider === 'openai' ? 'openai' : 'grok', nb = Number(args.count || 1);
      const modeleImg = args.quality === 'speed' ? 'rapide' : 'qualite';
      const maxUsd = Media.pireCasImageUsd(fournisseur, modeleImg, nb);
      const maxSwoge = studio.formateBase(studio.montantBaseDe(maxUsd, cours, dec), dec);
      if (devis) return { ok: true, outil, devis: { variable: true, maxSwoge, maxUsd: Number(maxUsd.toFixed(4)) } };
      if (!deps.cles.sousPlafond(cle.h, Number(maxSwoge))) return { ok: false, code: 402, raison: 'this key\'s daily cap does not leave room for this image (up to ' + maxSwoge + ' $SWOGE)' };
      if (!rythmeOk(cle.h)) return { ok: false, code: 429, raison: 'too many calls — max ' + APPELS_PAR_MINUTE + ' per minute per key' };
      if (!deps.image) return { ok: false, code: 503, raison: 'image generation is not switched on yet' };
      const r = await deps.image({ addr: cle.addr, prompt: String(args.prompt), fournisseur, n: nb, modele: modeleImg, format: args.aspect_ratio });
      if (!r || !r.ok) return { ok: false, code: (r && r.code) || 502, raison: (r && r.raison) || 'the image provider failed — you were not charged' };
      const swoge = String(r.factureSwoge);
      const recu = crypto.randomBytes(8).toString('hex');
      deps.cles.depense(cle.h, Number(swoge), { id: recu, outil, swoge, usd: r.factureUsd });
      const urls = (r.urls || []).map((u) => (deps.urlPublique ? deps.urlPublique(u) : u));
      return { ok: true, outil, resultat: { images: urls, provider: fournisseur, understoodAs: r.compris || null, reference: r.reference || null },
               texte: 'Images:\n' + urls.join('\n') + (r.compris ? '\nUnderstood as: ' + r.compris : ''), facture: { swoge, usd: r.factureUsd }, solde: r.solde, recu };
    }

    if (outil === 'ask_agent') {
      const m = Chat.modele(args.model || 'sonnet-5');
      if (!m || m.fournisseur !== 'anthropic') return { ok: false, code: 400, raison: 'model must be a Claude model' };
      const maxUsd = Chat.factureUsd(Agent.pireCasUsd(m, [{ content: String(args.task) }], !!(deps.actifs && deps.actifs().recherche)));
      const maxSwoge = studio.formateBase(studio.montantBaseDe(maxUsd, cours, dec), dec);
      if (devis) return { ok: true, outil, devis: { variable: true, maxSwoge, maxUsd: Number(maxUsd.toFixed(4)) } };
      if (!deps.cles.sousPlafond(cle.h, Number(maxSwoge))) return { ok: false, code: 402, raison: 'this key\'s daily cap does not leave room for this task (up to ' + maxSwoge + ' $SWOGE)' };
      if (!rythmeOk(cle.h)) return { ok: false, code: 429, raison: 'too many calls — max ' + APPELS_PAR_MINUTE + ' per minute per key' };
      const r = await deps.agent({ addr: cle.addr, tache: String(args.task), modele: m.id });
      if (!r.ok) return { ok: false, code: r.code || 502, raison: r.raison || 'the agent failed — you were not charged' };
      const swoge = String(r.factureSwoge);
      const recu = crypto.randomBytes(8).toString('hex');
      deps.cles.depense(cle.h, Number(swoge), { id: recu, outil, swoge, usd: r.factureUsd });
      return { ok: true, outil, resultat: { answer: r.texte, sources: r.sources || [], tokens: r.jetons || [], steps: r.etapes || 1 },
               texte: r.texte, facture: { swoge, usd: r.factureUsd }, solde: r.solde, recu };
    }

    const usd = prixUsd(outil);
    const wei = studio.montantBaseDe(usd, cours, dec);
    const swoge = studio.formateBase(wei, dec);
    if (devis) return { ok: true, outil, devis: { swoge, usd } };
    if (!deps.cles.sousPlafond(cle.h, Number(swoge))) return { ok: false, code: 402, raison: 'this key reached its daily spending cap' };
    if (!rythmeOk(cle.h)) return { ok: false, code: 429, raison: 'too many calls — max ' + APPELS_PAR_MINUTE + ' per minute per key' };
    if (!deps.solde.reserve(cle.addr, wei)) return { ok: false, code: 402, raison: 'balance too low — top up $SWOGE in the Wallet', requisSwoge: swoge };
    let r;
    try { r = await deps.outils[outil](args); }
    catch (e) { deps.solde.regle(cle.addr, wei, 0n); return { ok: false, code: 502, raison: 'the tool failed — you were not charged' }; }
    if (!r || r.erreur) { deps.solde.regle(cle.addr, wei, 0n); return { ok: false, code: 400, raison: (r && r.erreur) || 'the tool returned nothing — you were not charged' }; }
    const solde = deps.solde.regle(cle.addr, wei, wei);
    const recu = crypto.randomBytes(8).toString('hex');
    deps.cles.depense(cle.h, Number(swoge), { id: recu, outil, swoge, usd });
    const res = resultatDe(outil, r);
    return { ok: true, outil, resultat: res.donnees, texte: res.texte, facture: { swoge, usd }, solde, recu };
  }

  /**
   * Un outil à PRIX FIXE servi sans clé ni solde : le paiement est réglé
   * ailleurs (x402.js, sur la chaîne). Mêmes refus que `appelle` — outil
   * inconnu, entrée invalide, outil en panne — et le payeur n'y paie rien.
   * Les outils à coût variable (ask_agent, generate_image) n'y passent pas :
   * x402 `exact` exige un montant connu avant d'agir.
   */
  async function sertSansFacture({ outil, args, payeur }) {
    const defs = definitions(deps.actifs ? deps.actifs() : {});
    if (!defs.some((d) => d.name === outil)) return { ok: false, code: 404, raison: 'unknown tool: ' + outil };
    const inv = entreeInvalide(outil, args);
    if (inv) return { ok: false, code: 400, raison: inv };
    if (outil === 'generate_image') {
      /* Payée d'avance au prix fixe de CETTE demande : générée hors solde, au nom du payeur. */
      if (!deps.imageHorsSolde) return { ok: false, code: 503, raison: 'image generation is not switched on yet' };
      const fournisseur = args.provider === 'openai' ? 'openai' : 'grok';
      const r = await deps.imageHorsSolde({ addr: 'x402:' + String(payeur || '').toLowerCase(), prompt: String(args.prompt), fournisseur,
        modele: args.quality === 'speed' ? 'rapide' : 'qualite', n: Number(args.count || 1), format: args.aspect_ratio, prixUsd: prixX402Usd(outil, args) });
      if (!r || !r.ok) return { ok: false, code: (r && r.code) || 502, raison: ((r && r.raison) || 'the image provider failed').replace(/ — you were not charged$/, '') + ' — nothing was charged' };
      const urls = (r.urls || []).map((u) => (deps.urlPublique ? deps.urlPublique(u) : u));
      return { ok: true, outil, resultat: { images: urls, provider: fournisseur, understoodAs: r.compris || null, reference: r.reference || null },
               texte: 'Images:\n' + urls.join('\n') };
    }
    if (VARIABLES.includes(outil) || GRATUITS.includes(outil)) return { ok: false, code: 400, raison: outil + ' needs an API key (x402 pays fixed-price tools and images only)' };
    let r;
    try { r = await deps.outils[outil](args); } catch (e) { return { ok: false, code: 502, raison: 'the tool failed — nothing was charged' }; }
    if (!r || r.erreur) return { ok: false, code: 400, raison: (r && r.erreur) || 'the tool returned nothing — nothing was charged' };
    const res = resultatDe(outil, r);
    return { ok: true, outil, resultat: res.donnees, texte: res.texte };
  }

  /** Un outil payable en x402 : connu, actif, à prix fixe. */
  const x402Payable = (outil) => (outil === 'generate_image' || (!VARIABLES.includes(outil) && !GRATUITS.includes(outil) && !!prixUsd(outil)))
    && definitions(deps.actifs ? deps.actifs() : {}).some((d) => d.name === outil);

  return { catalogue, appelle, sertSansFacture, x402Payable };
}

/* ---- LLMS.TXT : l'API decrite aux agents (format llmstxt.org, relu le 26 septembre 2026) ----
 * Un H1 (le seul obligatoire), un resume en citation, du detail sans titre,
 * puis des listes de liens sous des H2, « Optional » en dernier. Le serveur le
 * sert en direct depuis le catalogue (prix et outils toujours exacts) ; le
 * site en publie une copie, faite par la MEME fonction, avec les prix en $. */
function llmsTxt(cat, u) {
  const outils = (cat && cat.outils) || [];
  const prix = (o) => (o.prix && o.prix.gratuit ? 'free' : o.prix && o.prix.variable ? 'real cost, up to $' + o.prix.maxUsd + (o.prix.maxSwoge && u.swoge ? ' (' + o.prix.maxSwoge + ' $SWOGE)' : '')
    : o.prix ? '$' + o.prix.usd + (o.prix.swoge && u.swoge ? ' (' + o.prix.swoge + ' $SWOGE)' : '') : '?');
  const args = (o) => Object.keys((o.inputSchema && o.inputSchema.properties) || {}).map((k) => k + ((o.inputSchema.required || []).includes(k) ? '' : '?')).join(', ');
  return [
    '# SwogeAgentic',
    '',
    '> Pay-per-call tools for AI agents from SWOGE WORLD: token scans (DexScreener, GoPlus, and what the SWOGE AI colony measured on Robinhood Chain, with sample sizes), the colony\'s newest launches and live activity, wallet and infrastructure OSINT (passive), the $SWOGE economy, web search, image generation and a full research agent. Read-only: nothing here buys, sells or signs. Each call is paid from the key owner\'s $SWOGE balance, within a daily cap they set.',
    '',
    'Get an API key at ' + u.page + ' (sign in with a wallet, set a daily cap; the key is shown once). Send it as `Authorization: Bearer swg_…`.',
    '',
    'REST: `GET ' + u.api + '/agentic/tools` lists tools, prices and input schemas. `POST ' + u.api + '/agentic/call/<tool>` with `{"arguments": {...}}` runs one; add `"quote": true` to get the price without paying. Every paid call returns `facture` (the exact amount billed, as a string), `recu` (a receipt id) and `solde` (the balance left). Refused calls (bad input, tool failure, cap reached) are never billed. Errors: 400 bad input, 401 no/revoked key, 402 balance or daily cap, 404 unknown tool, 429 over 60 calls/minute/key, 502 tool failed, 503 unavailable.',
    '',
  ].concat(cat && cat.x402 && cat.x402.actif ? [
    'No account? Pay per call with x402 (v2): call `POST ' + u.api + '/agentic/call/<tool>` without a key and read the `PAYMENT-REQUIRED` header (402) — scheme `exact`, network `' + cat.x402.network + '`, paid in ' + ((cat.x402.assets || []).map((a) => a.symbol + ' `' + a.asset + '` (' + a.assetTransferMethod + ')').join(' or ') || '$SWOGE `' + cat.x402.asset + '` (permit2)') + '. Sign and retry with `PAYMENT-SIGNATURE`; we pay the gas. Price: tool price + settlement gas, minimum $' + cat.x402.minimumUsd + '. Fixed-price tools, and `generate_image` at a fixed price per request (the 402 quotes that exact request: pay it with the same arguments). `ask_agent` and `generate_video` need an API key. With $SWOGE and no Permit2 allowance yet, add the `eip2612GasSponsoring` extension (permit value = the exact amount). Status: `GET ' + u.api + '/agentic/x402`.',
    '',
  ] : []).concat([
    'MCP: Streamable HTTP at `' + u.api + '/mcp` with the same bearer key (protocol 2026-07-28, and 2025-11-25 / 2025-06-18 / 2025-03-26 via initialize). Every tool also takes `quote: true`. Claude Code: `claude mcp add --transport http swogeagentic ' + u.api + '/mcp --header "Authorization: Bearer swg_…"`.',
    '',
    'Tools:',
    '',
  ]).concat(outils.map((o) => '- `' + o.name + '(' + args(o) + ')` — ' + prix(o) + '. ' + String(o.description || '').split('. ')[0].replace(/\.$/, '') + '.'))
   .concat(['',
    '## Docs',
    '',
    '- [API documentation](' + u.docs + '): authentication, endpoints, MCP setup, errors, examples',
    '- [Live tool catalogue (JSON)](' + u.api + '/agentic/tools): tools, prices in $ and $SWOGE, input schemas',
    '- [OpenAPI 3.1](' + u.api + '/openapi.json): every tool as an operation, with x-payment-info on those payable without a key',
    '- [Live llms.txt](' + u.api + '/llms.txt): this file, generated from the live catalogue',
  ])
   .concat(cat && cat.x402 && cat.x402.actif ? ['- [x402 discovery manifest](' + u.api + '/.well-known/x402): the resources payable per call'] : [])
   .concat(['',
    '## Optional',
    '',
    '- [SwogeAgentic in the browser](' + u.page + '): the same agent for humans, and where API keys are created',
    '- [SWOGE AI colony](' + u.site + '/swoge_ai.html): the autonomous colony whose measurements these tools return',
    '']).join('\n');
}

module.exports = { cree, definitions, prixUsd, prixX402Usd, entreeInvalide, llmsTxt, PRIX_DEFAUT, VARIABLES, GRATUITS, APPELS_PAR_MINUTE };
