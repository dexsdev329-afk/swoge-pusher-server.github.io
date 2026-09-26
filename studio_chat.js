'use strict';
/* ==================================================================
 * SWOGE AI CHAT — un chat façon ChatGPT / Claude / Perplexity, payé à la
 * requête sur le solde de jeu
 * ==================================================================
 *
 * « Une interface comme ChatGPT, comme Claude, un Perplexity avec tous les
 * modèles d'IA dispo, payable à la requête. » Ce fichier est la partie qui
 * peut PERDRE de l'argent — le reste (la page, le fournisseur) ne fait que
 * montrer et transporter. Trois règles, dans l'ordre :
 *
 *   1. ON NE FACTURE JAMAIS SOUS LE COÛT. Le prix d'un modèle est ancré sur
 *      ce que le fournisseur nous facture, par jeton, en USD (grille publique
 *      Anthropic, relevée le 24 septembre 2026). Avant l'appel, on RÉSERVE sur
 *      le solde le pire cas (entrée plafonnée + max_tokens + recherches) ;
 *      après, on facture le coût RÉEL lu dans `usage`, fois la marge, et on
 *      rend le reste. Une requête ne peut donc pas coûter plus que ce qu'on a
 *      bloqué, et le joueur ne paie que ce qu'il a consommé.
 *
 *   2. LE COURS DU $SWOGE EST LU DU CÔTÉ DE LA MAISON. La piscine est mince
 *      (~14 k$ le 24 sept.) : pomper le cours une minute ferait payer moins
 *      de jetons. On convertit donc au PLUS BAS du cours du moment et de la
 *      médiane des dernières lectures — le côté prudent pour la maison.
 *
 *   3. UN ÉCHEC DU FOURNISSEUR NE COÛTE RIEN AU JOUEUR. Réservé, puis rendu
 *      en entier si l'appel échoue avant d'avoir produit quoi que ce soit.
 *
 * Tout ce qui touche au solde passe par `deps.solde` (le jeu), et n'agit que
 * sur l'adresse de la session — jamais sur une adresse venue du message.
 * Le fournisseur est injecté aussi : l'essai le remplace par un faux, sans
 * réseau ni clé. Le jeton $SWOGEAI n'existe pas encore ; quand il sera créé,
 * c'est la monnaie de `deps.solde` qui changera, pas cette logique. */

const studio = require('./studio');
const config = require('./config');

/* ---- LES MODÈLES ----
 * Prix par million de jetons (entrée / sortie), grille Anthropic publique,
 * relevée le 24 septembre 2026. `recherche` : la version de l'outil web
 * search que le modèle accepte (la version à filtrage dynamique n'existe que
 * sur Opus 5.x et Sonnet 5 ; on garde la version de base ailleurs).
 * `maxTokens` borne la sortie, réflexion comprise : c'est ce qui rend le pire
 * cas calculable. Textes montrés aux joueurs : en anglais. */
const MODELES = [
  { id: 'opus-5-5', nom: 'Opus 5.5', api: 'claude-opus-5-5', fournisseur: 'anthropic',
    entree: 4, sortie: 20, maxTokens: 8000, recherche: 'web_search_20260209', effort: true,
    note: 'Most capable for ambitious work' },
  { id: 'fable-5-1', nom: 'Fable 5.1', api: 'claude-fable-5-1', fournisseur: 'anthropic',
    entree: 10, sortie: 50, maxTokens: 8000, recherche: 'web_search_20250305', effort: true,
    repli: 'claude-opus-4-8', note: 'For your hardest problems' },
  { id: 'sonnet-5', nom: 'Sonnet 5', api: 'claude-sonnet-5', fournisseur: 'anthropic',
    entree: 2, sortie: 10, maxTokens: 6000, recherche: 'web_search_20260209', effort: true,
    note: 'Best for everyday tasks' },
  { id: 'haiku-4-5', nom: 'Haiku 4.5', api: 'claude-haiku-4-5', fournisseur: 'anthropic',
    entree: 1, sortie: 5, maxTokens: 4000, recherche: 'web_search_20250305', effort: false,
    note: 'Fastest for quick answers' },
  /* ---- CHATGPT ET GROK, ajoutés le 26 septembre 2026 (studio_compat.js) ----
   * Prix par million de jetons relus le même jour : grille OpenAI (standard)
   * et table des modèles xAI (contexte < 200 k — l'historique est borné à
   * 24 000 caractères, on n'en approche pas). La réserve compte `maxTokens` de
   * sortie : chez OpenAI le raisonnement est compté DANS ces jetons, et
   * `max_completion_tokens` le borne. xAI rend son coût exact, qui fait foi.
   * `recherche: 'perplexity'` : la recherche web passe par la Search API de
   * Perplexity (studio_recherche.js), allumee si PERPLEXITY_API_KEY est posee. */
  { id: 'gpt-6-astra', nom: 'GPT-6 Astra', api: 'gpt-6-astra', fournisseur: 'openai',
    entree: 10, sortie: 50, maxTokens: 8000, recherche: 'perplexity', effort: true,
    note: 'OpenAI\'s most capable, for the hardest work' },
  { id: 'gpt-6-sol', nom: 'GPT-6 Sol', api: 'gpt-6-sol', fournisseur: 'openai',
    entree: 2, sortie: 10, maxTokens: 8000, recherche: 'perplexity', effort: true,
    note: 'Strong all-rounder for coding and complex tasks' },
  { id: 'gpt-6-luna', nom: 'GPT-6 Luna', api: 'gpt-6-luna', fournisseur: 'openai',
    entree: 0.1, sortie: 0.5, maxTokens: 6000, recherche: 'perplexity', effort: true,
    note: 'Fastest and cheapest from OpenAI' },
  { id: 'grok-4-7', nom: 'Grok 4.7', api: 'grok-4.7', fournisseur: 'xai',
    entree: 2, sortie: 6, maxTokens: 8000, recherche: 'perplexity', effort: false,
    note: 'xAI\'s latest flagship' },
  { id: 'grok-4-20-reasoning', nom: 'Grok 4.20 Reasoning', api: 'grok-4.20-0309-reasoning', fournisseur: 'xai',
    entree: 1.25, sortie: 2.5, maxTokens: 8000, recherche: 'perplexity', effort: false,
    note: 'Thinks step by step before answering' },
  { id: 'grok-4-3', nom: 'Grok 4.3', api: 'grok-4.3', fournisseur: 'xai',
    entree: 1.25, sortie: 2.5, maxTokens: 6000, recherche: 'perplexity', effort: false,
    note: 'Fast and cheap from xAI' },
];
const NOMS_FOURNISSEURS = { anthropic: 'Claude', openai: 'ChatGPT', xai: 'Grok' };
const DEFAUT = 'opus-5-5';
const EFFORTS = ['low', 'medium', 'high'];

/* ---- LES BORNES QUI RENDENT LE PIRE CAS CALCULABLE ----
 * Entrée : l'historique est coupé à ENTREE_MAX_CAR caractères (les plus
 * récents gardés). Pour la RÉSERVE on compte un jeton pour deux caractères
 * — bien plus que la réalité (~4 en anglais), donc la réserve couvre.
 * Recherche : au plus RECHERCHE_MAX appels, et RECHERCHE_JETONS de résultats
 * comptés en entrée dans le pire cas. Le coût réel, lui, vient de `usage`. */
const ENTREE_MAX_CAR = 24000;
const MESSAGE_MAX_CAR = 8000;
const SYSTEME_JETONS = 400;
const RECHERCHE_MAX = 3;
const RECHERCHE_JETONS = 30000;
const PRIX_RECHERCHE_USD = 0.01;          /* 10 $ les 1 000 recherches */
const MARGE = () => Math.max(1, Number(process.env.STUDIO_MARGE || 1.5));
const MIN_USD = 0.001;
const Rech = require('./studio_recherche');   /* la recherche web des modeles sans outil (Perplexity) */

function modele(id) { return MODELES.find((m) => m.id === id) || null; }

/** Le coût réel d'une réponse, en USD, lu dans `usage`. */
function coutUsd(m, usage) {
  const u = usage || {};
  /* La recherche Perplexity (0,005 $ la requete reussie) s'ajoute a tout. */
  const pplx = (Number(u.recherches_perplexity) || 0) * Rech.PRIX_USD;
  /* Le coût EXACT rendu par le fournisseur (xAI : cost_in_usd_ticks) fait foi. */
  if (Number.isFinite(u.coutExactUsd) && u.coutExactUsd > 0) return u.coutExactUsd + pplx;
  const entree = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25
    + (u.cache_read_input_tokens || 0) * 0.1;
  const sortie = u.output_tokens || 0;
  const rech = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return entree * m.entree / 1e6 + sortie * m.sortie / 1e6 + rech * PRIX_RECHERCHE_USD + pplx;
}

/** Le pire cas d'une requête, en USD, AVANT marge. */
function pireCasUsd(m, messages, recherche) {
  const car = (messages || []).reduce((s, x) => s + String(x.content || '').length, 0);
  /* Perplexity : une seule requete, et au plus JETONS_CONTEXTE de resultats
     ajoutes a la question. Claude : jusqu'a RECHERCHE_MAX recherches. */
  const pplx = recherche && m.recherche === 'perplexity';
  const entree = Math.ceil(car / 2) + SYSTEME_JETONS + (recherche ? (pplx ? Rech.JETONS_CONTEXTE : RECHERCHE_JETONS) : 0);
  return entree * m.entree / 1e6 + m.maxTokens * m.sortie / 1e6
    + (recherche ? (pplx ? Rech.PRIX_USD : RECHERCHE_MAX * PRIX_RECHERCHE_USD) : 0);
}

/** Ce que le joueur paie pour un coût donné : marge, et un plancher. */
function factureUsd(cout) { return Math.max(MIN_USD, cout * MARGE()); }

/** Nettoie l'historique reçu : rôles connus, textes bornés, le plus récent
 *  gardé, commence et finit par l'utilisateur. Rend null s'il n'y a rien. */
function nettoie(messages) {
  const l = (Array.isArray(messages) ? messages : [])
    .filter((x) => x && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string')
    .map((x) => ({ role: x.role, content: x.content.trim().slice(0, MESSAGE_MAX_CAR) }))
    .filter((x) => x.content);
  const garde = [];
  let total = 0;
  for (let i = l.length - 1; i >= 0; i--) {
    if (total + l[i].content.length > ENTREE_MAX_CAR) break;
    total += l[i].content.length;
    garde.unshift(l[i]);
  }
  while (garde.length && garde[0].role !== 'user') garde.shift();
  if (!garde.length || garde[garde.length - 1].role !== 'user') return null;
  return garde;
}

/* ---- LE COURS DU $SWOGE, CÔTÉ MAISON ----
 * Lu sur DexScreener (la même source que la colonie), piscine Robinhood la
 * plus profonde, gardé une minute. On retient le PLUS BAS du cours du moment
 * et de la médiane des 20 dernières lectures : un cours pompé une minute ne
 * fait pas payer moins. À défaut de lecture, le réglage `SWOGE_PRIX_USD`. */
const COURS = { t: 0, v: null, hist: [] };
const COURS_TTL_MS = 60000;
function mediane(a) { const s = a.slice().sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }
function coursPrudent(dernier, hist) {
  const h = (hist || []).filter((x) => x > 0);
  if (!(dernier > 0)) return h.length ? mediane(h) : null;
  return h.length ? Math.min(dernier, mediane(h)) : dernier;
}
async function coursSwoge(prendre, maintenant) {
  const t = maintenant || Date.now();
  if (COURS.v !== null && t - COURS.t < COURS_TTL_MS) return COURS.v;
  let lu = null;
  /* `STUDIO_DEX=0` coupe la lecture (essais, mode hors ligne) : on retombe
     sur le réglage `SWOGE_PRIX_USD`. */
  if (process.env.STUDIO_DEX !== '0') try {
    const f = prendre || fetch;
    const r = await f('https://api.dexscreener.com/latest/dex/tokens/' + config.SWOGE_TOKEN,
      { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const p = (j.pairs || []).filter((x) => String(x.chainId || '').toLowerCase() === 'robinhood')
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const v = p[0] ? Number(p[0].priceUsd) : NaN;
    if (v > 0) lu = v;
  } catch (e) { /* la lecture ratée retombe sur l'historique ou le réglage */ }
  if (lu !== null) { COURS.hist.push(lu); if (COURS.hist.length > 20) COURS.hist.shift(); }
  const v = coursPrudent(lu, COURS.hist) || studio.prixSwogeUsd();
  COURS.t = t; COURS.v = v || null;
  return COURS.v;
}

/* ---- JUSQU'A TROIS REPONSES EN VOL PAR JOUEUR ----
 * C'etait une : « une question a la fois ». Le 26 septembre 2026, SwoleMind
 * compare 2 ou 3 modeles sur la MEME question (demande du proprietaire) — trois
 * reponses partent ensemble, chacune reservee, facturee et rendue a part. La
 * borne passe donc a STUDIO_CHAT_EN_VOL (3) ; le rythme par minute, lui, compte
 * chaque reponse. */
const EN_VOL_MAX = () => Math.max(1, Number(process.env.STUDIO_CHAT_EN_VOL || 3));
const EN_VOL = {
  n: new Map(),
  has(a) { return (this.n.get(a) || 0) >= EN_VOL_MAX(); },
  add(a) { this.n.set(a, (this.n.get(a) || 0) + 1); },
  delete(a) { const k = (this.n.get(a) || 0) - 1; if (k > 0) this.n.set(a, k); else this.n.delete(a); },
  clear() { this.n.clear(); },
};
const RYTHME = new Map();
const PAR_MINUTE = () => Math.max(1, Number(process.env.STUDIO_PAR_MINUTE || 8));
function rythmeOk(addr, maintenant) {
  const t = maintenant || Date.now();
  const l = (RYTHME.get(addr) || []).filter((x) => t - x < 60000);
  if (l.length >= PAR_MINUTE()) { RYTHME.set(addr, l); return false; }
  l.push(t); RYTHME.set(addr, l);
  return true;
}

/* ---- CE QU'ON MESURE (doctrine du dépôt : mesurer avant de changer) ----
 * Coût réel payé au fournisseur contre ce qu'on a facturé : la marge vécue,
 * et combien de fois la réserve a été dépassée (devrait rester à zéro). */
const MESURE = { requetes: 0, echecs: 0, coutUsd: 0, factureUsd: 0, depassements: 0, parModele: {} };
function mesure(id, cout, facture, depasse) {
  MESURE.requetes++; MESURE.coutUsd += cout; MESURE.factureUsd += facture;
  if (depasse) MESURE.depassements++;
  const p = MESURE.parModele[id] || (MESURE.parModele[id] = { n: 0, coutUsd: 0, factureUsd: 0 });
  p.n++; p.coutUsd += cout; p.factureUsd += facture;
}

/** Le catalogue montré à la page : prix indicatif « typique » et « max ». */
function catalogue(cours, cle) {
  /* `cle` : { anthropic, openai, xai } — ou un booleen (l'ancien appel : Claude seul). */
  const a = (cle && typeof cle === 'object') ? cle : { anthropic: !!cle, openai: false, xai: false };
  const actif = !!(a.anthropic || a.openai || a.xai);
  const typique = (m) => 1500 * m.entree / 1e6 + 800 * m.sortie / 1e6;   /* une question courte */
  const enSwoge = (usd) => (cours > 0 ? Math.ceil(usd / cours) : null);
  return {
    ouvert: actif && cours > 0,
    note: !actif ? 'The AI provider key is not set on the server yet.'
      : !(cours > 0) ? 'The $SWOGE price is unavailable right now — requests are paused so nobody is overcharged.' : null,
    monnaie: '$SWOGE', coursUsd: cours || null, marge: MARGE(), defaut: DEFAUT, efforts: EFFORTS,
    fournisseurs: Object.keys(NOMS_FOURNISSEURS).map((f) => ({ id: f, nom: NOMS_FOURNISSEURS[f], actif: !!a[f] })),
    modeles: MODELES.map((m) => ({
      id: m.id, nom: m.nom, note: m.note, fournisseur: m.fournisseur, nomFournisseur: NOMS_FOURNISSEURS[m.fournisseur],
      actif: !!a[m.fournisseur], effort: m.effort,
      recherche: !!m.recherche && (m.recherche !== 'perplexity' || !!a.perplexity),
      typiqueSwoge: enSwoge(factureUsd(typique(m))),
      maxSwoge: enSwoge(factureUsd(pireCasUsd(m, [{ content: 'x'.repeat(4000) }], !!m.recherche))),
    })),
  };
}

/**
 * Une requête complète : réserve, appel, facture, rend.
 *   q    = { addr, modele, messages, recherche, effort }
 *   deps = { solde: { reserve(addr, wei) -> bool, regle(addr, reserveWei, factureWei) -> string },
 *            fournisseur: async ({ m, messages, recherche, effort, surTexte, surReflexion, surRecherche }) ->
 *                         { texte, sources, usage, stop, servi },
 *            cours: async () -> number|null,
 *            surTexte, surReflexion }
 * Rend { ok, ... } — jamais d'exception pour un refus attendu.
 */
async function repond(q, deps) {
  const addr = q && q.addr;
  if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
  const m = modele(q.modele || DEFAUT);
  if (!m) return { ok: false, code: 400, raison: 'unknown model' };
  if (deps.actif && !deps.actif(m.fournisseur)) return { ok: false, code: 503, raison: m.nom + ' is not switched on yet — pick another model.' };
  const messages = nettoie(q.messages);
  if (!messages) return { ok: false, code: 400, raison: 'empty question' };
  const recherche = !!q.recherche && !!m.recherche
    && (m.recherche !== 'perplexity' || !deps.actif || !!deps.actif('perplexity'));
  const effort = m.effort && EFFORTS.includes(q.effort) ? q.effort : null;
  if (EN_VOL.has(addr)) return { ok: false, code: 429, raison: 'too many answers at once — wait for one to finish' };
  if (!rythmeOk(addr, q.maintenant)) return { ok: false, code: 429, raison: 'too many questions — wait a minute' };

  const cours = await deps.cours();
  if (!(cours > 0)) return { ok: false, code: 503, raison: 'the $SWOGE price is unavailable — try again shortly' };
  const dec = config.DECIMALS || 18;
  const reserveUsd = factureUsd(pireCasUsd(m, messages, recherche));
  const reserveWei = studio.montantBaseDe(reserveUsd, cours, dec);
  if (!deps.solde.reserve(addr, reserveWei)) {
    return { ok: false, code: 402, raison: 'balance too low for this model',
      requisSwoge: studio.formateBase(reserveWei, dec) };
  }

  EN_VOL.add(addr);
  let r;
  try {
    r = await deps.fournisseur({ m, messages, recherche, effort,
      surTexte: deps.surTexte || (() => {}), surReflexion: deps.surReflexion || (() => {}),
      surRecherche: deps.surRecherche || (() => {}) });
  } catch (e) {
    /* Échec avant toute réponse facturable : on rend TOUT. */
    deps.solde.regle(addr, reserveWei, 0n);
    MESURE.echecs++;
    EN_VOL.delete(addr);
    return { ok: false, code: 502, raison: 'the AI provider failed — you were not charged', detail: String(e && e.message || e).slice(0, 160) };
  }
  EN_VOL.delete(addr);

  /* Le repli (Fable 5.1 → Opus 4.8) facture aux tarifs du modèle demandé,
     qui sont les plus hauts : la maison ne perd pas, le joueur le sait. */
  const cout = coutUsd(m, r.usage);
  const facture = factureUsd(cout);
  let factureWei = studio.montantBaseDe(facture, cours, dec);
  const depasse = factureWei > reserveWei;
  if (depasse) {
    console.error('[chat] DÉPASSEMENT de réserve ' + m.id + ' : ' + facture.toFixed(4) + ' $ > réserve ' + reserveUsd.toFixed(4) + ' $');
    factureWei = reserveWei;
  }
  const solde = deps.solde.regle(addr, reserveWei, factureWei);
  mesure(m.id, cout, facture, depasse);
  return {
    ok: true, texte: r.texte || '', sources: r.sources || [], stop: r.stop || null,
    modele: m.id, servi: r.servi || m.api, recherche,
    factureSwoge: studio.formateBase(factureWei, dec), factureUsd: Number(facture.toFixed(5)),
    usage: { entree: (r.usage && r.usage.input_tokens) || 0, sortie: (r.usage && r.usage.output_tokens) || 0,
      recherches: ((r.usage && r.usage.server_tool_use && r.usage.server_tool_use.web_search_requests) || 0)
        + ((r.usage && r.usage.recherches_perplexity) || 0) },
    solde,
  };
}

module.exports = {
  MODELES, DEFAUT, EFFORTS, modele, coutUsd, pireCasUsd, factureUsd, nettoie,
  coursPrudent, coursSwoge, catalogue, repond, MESURE, EN_VOL, RYTHME, COURS,
  ENTREE_MAX_CAR, RECHERCHE_MAX, PRIX_RECHERCHE_USD,
};
