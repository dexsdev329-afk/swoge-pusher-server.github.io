'use strict';
/* ==================================================================
 * L'AGENT ACHETE UNE eSIM POUR LE JOUEUR (etape 2, 28 septembre 2026)
 * ==================================================================
 *
 * Choix du proprietaire : « le plus simple pour les utilisateurs ». Le joueur
 * paie avec son solde de jeu ($SWOGE), en un clic ; le portefeuille dedie de
 * l'agent (AGENT_BUDGET_CLE, le meme qu'embauche.js) paie le vendeur en USDC.
 *
 * Pourquoi CHIPS et une eSIM (releve du 28/09) : dans les 7 529 services du
 * catalogue PayAI, ni Bitrefill ni Laso ; les seuls achats reels sont une eSIM
 * de donnees (CHIPS, vamoschips.com), du dropshipping UE (adresse postale
 * requise), et des numeros de verification SMS (exclus : outil de fraude, et
 * sur un reseau de test). CHIPS est paye en USDC sur Solana — le reseau de
 * notre portefeuille — regle en secondes, sans compte ni KYC, et livre un code
 * d'activation (LPA). Une eSIM de donnees, sans numero de telephone, se revend
 * mal : c'est le produit le moins expose a la sortie de $SWOGE en valeur.
 * Prix sondes le 28/09 : Europe 1 Go 7 jours 5,80 $, Europe 10 Go 30 jours 38,00 $.
 *
 * Contrat lu dans https://vamoschips.com/openapi.json (28/09) :
 *   POST /api/v1/x402/orders, en-tete Idempotency-Key (32-128), corps
 *   { quote: { planSlug }, acceptTerms: true } → 402 (PAYMENT-REQUIRED, v2),
 *   puis la MEME requete avec PAYMENT-SIGNATURE → 200 { order, delivery:
 *   { grantToken, installUrl } } ; POST …/orders/{publicId}/install avec
 *   Authorization: Bearer <grantToken> → { activationUri, activationCode,
 *   smdpAddress, iccidLast4 }.
 *
 * Garde-fous :
 *   - l'agent ne fait que PROPOSER ; seul le joueur confirme, par la page, avec
 *     sa session — le serveur ne paie jamais sur la seule parole de l'agent ;
 *   - le prix est revérifié a la confirmation : plus cher de plus de 1 % que
 *     l'offre montree, on refuse ; le joueur paie le prix qu'il a vu ;
 *   - plafonds : ACHAT_MAX_USD (15 $) par achat, ACHAT_JOUR_JOUEUR_USD (30 $)
 *     par joueur et par jour UTC, ACHAT_JOUR_USD (60 $) pour la maison ;
 *   - reserve sur le solde AVANT de payer ; facture seulement sur un 200 du
 *     vendeur, rendu sinon ; une offre ne se paie qu'une fois (Idempotency-Key) ;
 *   - un seul hote, en https, sur une adresse publique verifiee et epinglee ;
 *   - le code d'activation n'est montre qu'a la session du joueur qui a paye.
 * ACHAT_MARGE (1,05) : un choix commercial du proprietaire, pas une mesure.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const X = require('./x402_client');
const E = require('./embauche');

const BASE_CHIPS = 'https://vamoschips.com';
const CONDITIONS = BASE_CHIPS + '/legal/terms';
const REMBOURSEMENTS = BASE_CHIPS + '/legal/refunds';
const COMPATIBLES = BASE_CHIPS + '/compatibility';
const OFFRE_MS = 15 * 60e3;
const PRIX_TTL_MS = 30 * 60e3;
const DEST_TTL_MS = 6 * 3600e3;
const SOLDE_TTL_MS = 60e3;
const DELAI_MS = 25000;
const GO = 1073741824;
const TOLERANCE_PRIX = 1.01;
const env = (k, d) => { const v = Number(process.env[k]); return v > 0 ? v : d; };
const maxAchat = () => env('ACHAT_MAX_USD', 15);
const maxJoueur = () => env('ACHAT_JOUR_JOUEUR_USD', 30);
const maxJour = () => env('ACHAT_JOUR_USD', 60);
const marge = () => { const v = Number(process.env.ACHAT_MARGE); return v >= 1 ? v : 1.05; };
const arrondi = (x) => Math.round(x * 1e6) / 1e6;

/**
 * deps : { cle, fetch? (essais), resout?, blockhash(), rpcSolana?(m, p), dossier, maintenant?, base? }
 */
function cree(deps) {
  const w = X.portefeuille(deps.cle);
  const reseau = X.reseauDe(w);
  const maintenant = deps.maintenant || Date.now;
  const base = String(deps.base || BASE_CHIPS).replace(/\/+$/, '');
  const hote = new URL(base).hostname;
  const coupe = process.env.ACHATS === '0';
  const registre = deps.dossier ? path.join(deps.dossier, 'achats.jsonl') : null;
  const lignes = [];
  try { if (registre) for (const l of fs.readFileSync(registre, 'utf8').split('\n')) if (l.trim()) lignes.push(JSON.parse(l)); } catch (e) { /* premier demarrage */ }
  const note = (o) => { lignes.push(o); if (registre) try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.appendFileSync(registre, JSON.stringify(o) + '\n'); } catch (e) { /* jamais bloquant */ } };
  const MESURE = { recherches: 0, sondes: 0, offres: 0, confirmees: 0, payees: 0, livrees: 0, refusees: 0, echecs: 0, depenseUsd: 0, factureUsd: 0 };
  const OFFRES = new Map();
  const PLANS = new Map();
  const PRIX = new Map();
  let DEST = { t: 0, liste: [] };
  let SOLDE = { t: 0, v: null };

  /* Toute requete : l'hote du vendeur seul, en https, sur l'adresse verifiee. */
  async function http(url, o) {
    const u = new URL(url);
    if (u.hostname !== hote) throw new Error('only ' + hote + ' is contacted');
    const ips = await E.ipsPubliques(url, deps.resout);
    if (!ips) throw new Error(hote + ' does not resolve to a public https address');
    const opts = Object.assign({ redirect: 'manual', signal: AbortSignal.timeout(DELAI_MS) }, o);
    return deps.fetch ? deps.fetch(url, opts) : E.requeteEpinglee(url, opts, ips);
  }
  async function lisJson(url) {
    const r = await http(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const cleIdem = () => 'swoge-' + crypto.randomBytes(24).toString('hex');
  const commande = (planSlug, cle, h) => http(base + '/api/v1/x402/orders', { method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': cle }, h || {}),
    body: JSON.stringify({ quote: { planSlug }, acceptTerms: true }) });

  async function destinations() {
    if (DEST.liste.length && maintenant() - DEST.t < DEST_TTL_MS) return DEST.liste;
    const l = [];
    for (let off = 0; off < 2000; off += 100) {
      const d = await lisJson(base + '/api/v1/destinations?limit=100&offset=' + off);
      l.push(...(d.items || []));
      if (!d.items || d.items.length < 100 || l.length >= (d.total || 0)) break;
    }
    DEST = { t: maintenant(), liste: l };
    return l;
  }
  /* Les continents (28/09 au soir) : CHIPS ne nomme ses regions que par la liste de leurs pays
     (« Austria, Belgium, Bulgaria… », 43 regions relevees le 28/09) — « Europe » ne trouvait
     rien. Un continent = les regions qui couvrent TOUS ses pays reperes, les plus petites d'abord. */
  const CONTINENTS = { europe: ['fr', 'de', 'it', 'es'], asia: ['jp', 'th', 'sg'], 'middle east': ['ae', 'sa', 'qa'],
    'south america': ['br', 'ar', 'cl'], 'north america': ['us', 'ca'], global: ['us', 'fr', 'jp', 'br'], world: ['us', 'fr', 'jp', 'br'] };
  const NOMS_CONTINENT = { europe: 'Europe', asia: 'Asia', 'middle east': 'Middle East', 'south america': 'South America', 'north america': 'North America', global: 'Global', world: 'Global' };
  /** Les destinations qui correspondent a un pays (nom, code a deux lettres ou slug) : les pays d'abord. */
  async function chercheDestination(q) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return [];
    const l = await destinations();
    if (CONTINENTS[s]) {
      /* Les codes de CHIPS sont en majuscules (« FR », releve du 28/09). */
      return l.filter((d) => d.kind !== 'country' && CONTINENTS[s].every((c) => (d.countryCodes || []).map((x) => String(x).toLowerCase()).includes(c)))
        .sort((a, b) => (a.countryCodes || []).length - (b.countryCodes || []).length).slice(0, 5)
        .map((d) => Object.assign({}, d, { continent: NOMS_CONTINENT[s] }));
    }
    const score = (d) => {
      const nom = String(d.name || '').toLowerCase();
      const codes = (d.countryCodes || []).map((c) => String(c).toLowerCase());
      if (nom === s || d.slug === s || (s.length === 2 && d.kind === 'country' && codes.includes(s))) return 3;
      /* Deux lettres : un code pays, jamais un bout de nom (« us » n'est ni Austria ni Australia). */
      if (s.length === 2) return codes.includes(s) ? 1 : 0;
      if (nom.startsWith(s)) return 2;
      return nom.includes(s) ? 1 : 0;
    };
    const tries = l.map((d) => ({ d, k: score(d) })).filter((x) => x.k > 0)
      .sort((a, b) => (b.k - a.k) || ((a.d.kind === 'country' ? 0 : 1) - (b.d.kind === 'country' ? 0 : 1)) || ((a.d.countryCodes || []).length - (b.d.countryCodes || []).length))
      .map((x) => x.d);
    /* Un pays : les regions qui le couvrent sont aussi des reponses (souvent moins cheres par Go). */
    const pays = tries[0] && tries[0].kind === 'country' && (tries[0].countryCodes || [])[0];
    const regions = pays ? l.filter((d) => d.kind !== 'country' && (d.countryCodes || []).includes(pays) && !tries.includes(d))
      .sort((a, b) => (a.countryCodes || []).length - (b.countryCodes || []).length) : [];
    return tries.concat(regions).slice(0, 5);
  }

  /** Le prix d'un forfait : un 402 NON paye (rien n'est debite), garde 30 min. */
  async function prix(planSlug, frais) {
    const c = PRIX.get(planSlug);
    if (!frais && c && maintenant() - c.t < PRIX_TTL_MS) return c.usd;
    MESURE.sondes++;
    const r = await commande(planSlug, cleIdem());
    if (r.status !== 402) return null;
    const req = await X.lit402(r);
    const acc = req && X.offrePour(w, req.accepts);
    const usd = acc ? Number(acc.amount) / 1e6 : null;
    if (usd > 0) PRIX.set(planSlug, { t: maintenant(), usd });
    return usd > 0 ? usd : null;
  }

  /** L'USDC du portefeuille de l'agent sur Solana (null si on ne sait pas le lire). */
  async function soldeUsdc() {
    if (!deps.rpcSolana || !w || w.type !== 'solana') return null;
    if (SOLDE.v !== null && maintenant() - SOLDE.t < SOLDE_TTL_MS) return SOLDE.v;
    try {
      const r = await deps.rpcSolana('getTokenAccountsByOwner', [w.address, { mint: X.USDC_SOLANA }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const v = ((r && r.value) || []).reduce((s, a) => s + (Number(a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info
        && a.account.data.parsed.info.tokenAmount && a.account.data.parsed.info.tokenAmount.amount) || 0), 0) / 1e6;
      SOLDE = { t: maintenant(), v };
      return v;
    } catch (e) { return null; }
  }

  /* Le nom d'une region CHIPS est la liste de ses pays : illisible au-dela de quelques-uns. */
  const nomDe = (d) => { const nom = String(d.name || ''); const k = (d.countryCodes || []).length;
    return d.kind === 'country' || nom.length <= 40 ? nom : 'Region of ' + k + ' countries (' + nom.split(',').slice(0, 3).map((x) => x.trim()).join(', ') + '…)'; };
  const vuePlan = (p, usd) => ({ plan: p.slug, nom: p.name, couvre: (PLANS.get(p.slug) || {}).destination || null, go: p.dataBytes ? Math.round(p.dataBytes / GO * 100) / 100 : null, jours: p.durationDays,
    usd, factureUsd: arrondi(usd * marge()), vitesse: p.speed || null, activation: p.activationRule || null });

  /**
   * Les forfaits d'un pays, du plus petit au plus grand, avec leur prix. Seulement les forfaits a
   * duree fixe (les forfaits « par jour » demandent des dates : pas encore). n ≤ 6 prix sondes.
   */
  async function forfaits(a) {
    a = a || {};
    MESURE.recherches++;
    if (!actif()) return { ok: false, raison: 'eSIM purchases are not switched on' };
    let dests;
    try { dests = await chercheDestination(a.pays); } catch (e) { return { ok: false, raison: 'the eSIM shop did not answer - try again' }; }
    if (!dests.length) return { ok: false, raison: 'no eSIM destination matches "' + String(a.pays || '').slice(0, 40) + '"' };
    const d = dests[0];
    /* Le pays ET les deux plus petites regions qui le couvrent (28/09 au soir : « France » ne
       montrait que 3 Go a 7,40 $, quand la region de 33 pays vendait 3 Go a 3,38 $). Chaque
       forfait garde SA destination. */
    const lues = dests.slice(0, 3);
    let plans = [];
    const origine = new Map();
    try {
      /* La premiere destination doit repondre ; une region en plus qui ne repond pas est sautee. */
      const listes = await Promise.all(lues.map((x, i) => lisJson(base + '/api/v1/destinations/' + encodeURIComponent(x.slug) + '/plans?limit=100')
        .then((r) => ({ x, l: r.items || [] }), (e) => { if (i === 0) throw e; return { x, l: [] }; })));
      for (const { x, l } of listes) for (const p of l) if (!origine.has(p.slug)) { origine.set(p.slug, x); plans.push(p); }
    } catch (e) { return { ok: false, raison: 'the eSIM shop did not answer - try again' }; }
    const minJ = Number(a.jours) > 0 ? Number(a.jours) : 0;
    const minGo = Number(a.go) > 0 ? Number(a.go) : 0;
    const tous = plans.filter((p) => !p.isDaily && p.dataBytes > 0 && p.durationDays > 0 && p.durationDays >= minJ && p.dataBytes >= minGo * GO * 0.999
      && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(p.slug || '')))
      .sort((x, y) => (x.dataBytes - y.dataBytes) || (x.durationDays - y.durationDays));
    /* Sans quantite demandee : 1 Go au moins d'abord (releve du 28/09 : 100 Mo a 0,60 $ passaient
       devant tout), les plus petits seulement s'il n'y a rien d'autre. */
    const fixes = minGo ? tous : tous.filter((p) => p.dataBytes >= GO * 0.999).concat(tous.filter((p) => p.dataBytes < GO * 0.999));
    const parTaille = new Map();
    const choisis = [];
    for (const p of fixes) {
      const k = Math.round(p.dataBytes / GO * 10);
      /* Trois par taille, douze en tout (28/09 au soir : a deux et huit, les forfaits de la France,
         lus les premiers, prenaient toutes les places et le 3 Go regional a 3,38 $ n'etait jamais
         sonde). La liste de CHIPS ne porte aucun prix : seule une sonde le dit (gardee 30 min). */
      if ((parTaille.get(k) || 0) >= 3) continue;
      parTaille.set(k, (parTaille.get(k) || 0) + 1);
      choisis.push(p);
      if (choisis.length >= Math.min(12, Number(a.n) || 12)) break;
    }
    /* Ce que couvre le forfait : SA destination (la liste d'un pays porte aussi les forfaits regionaux). */
    for (const p of choisis) PLANS.set(p.slug, { p, destination: nomDe(p.destination && p.destination.name ? p.destination : (origine.get(p.slug) || d)) });
    const prixs = await Promise.all(choisis.map((p) => prix(p.slug).catch(() => null)));
    const liste = choisis.map((p, i) => (prixs[i] ? vuePlan(p, prixs[i]) : null)).filter((x) => x && x.usd <= maxAchat())
      .sort((x, y) => (x.usd / (x.go || 1)) - (y.usd / (y.go || 1)) || x.usd - y.usd);
    /* Ce que la boutique peut payer MAINTENANT (28/09 au soir, essai du proprietaire) : le
       portefeuille de l'agent tenait 1,60 USDC ; l'agent a propose un forfait a 3,38 $, refuse
       a l'offre, puis un a 2 $ qui l'aurait ete aussi. Un forfait que la boutique ne peut pas
       payer n'est plus montre : il est compte (horsFonds), jamais propose. Solde illisible : on
       montre tout, et l'offre revérifie. */
    const solde = await soldeUsdc();
    const payables = solde === null ? liste : liste.filter((x) => x.usd <= solde);
    return { ok: true, destination: { nom: d.continent || nomDe(d), genre: d.continent ? 'continent' : d.kind, autres: [...new Set(dests.slice(lues.length).map(nomDe))] }, forfaits: payables,
      horsFonds: liste.length - payables.length, total: fixes.length, plafondUsd: maxAchat(), conditions: CONDITIONS, compatibles: COMPATIBLES };
  }

  /* Les plafonds se lisent au registre : le DERNIER etat de chaque achat compte. */
  function depuis(t0, qui) {
    const der = new Map();
    for (const l of lignes) if (l.t >= t0 && (!qui || l.qui === qui)) der.set(l.id, l);
    let s = 0;
    for (const l of der.values()) if (['en cours', 'paye', 'livre', 'perte'].includes(l.etat)) s += l.usd || 0;
    return s;
  }
  const jour0 = () => { const d = new Date(maintenant()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  function dernier(id) { let x = null; for (const l of lignes) if (l.id === id) x = Object.assign({}, x || {}, l); return x; }
  function actif() { return !!w && w.type === 'solana' && !coupe; }

  /**
   * qui : l'adresse de la session (page SwogeAgentic) ou 'wallet:<payeur>' (la boutique, 28/09).
   * opts.marge : la marge de la boutique sans compte (paye en USDC, ESIM_MARGE) au lieu d'ACHAT_MARGE.
   * opts.lien : un secret de 128 bits, garde au registre, qui seul rend le code d'activation (parLien).
   */
  function pour(qui, factu, opts) {
    opts = opts || {};
    const q = String(qui || '').toLowerCase();

    /** L'agent propose : une offre de 15 min que SEUL le joueur peut confirmer. */
    async function propose(a) {
      a = a || {};
      if (!actif()) return { ok: false, raison: 'eSIM purchases are not switched on' };
      const slug = String(a.plan || '').trim();
      const info = PLANS.get(slug);
      if (!info) return { ok: false, raison: 'only a plan returned by find_esim_plans can be offered - search the country first' };
      let usd;
      try { usd = await prix(slug, true); } catch (e) { usd = null; }
      if (!usd) return { ok: false, raison: 'this plan has no price right now - it may be sold out' };
      if (usd > maxAchat()) { MESURE.refusees++; return { ok: false, raison: 'this plan costs ' + usd + ' $, above the ' + maxAchat() + ' $ limit per purchase' }; }
      const t0 = jour0();
      if (depuis(t0, q) + usd > maxJoueur()) { MESURE.refusees++; return { ok: false, raison: 'your daily purchase limit (' + maxJoueur() + ' $) would be passed' }; }
      if (depuis(t0, null) + usd > maxJour()) { MESURE.refusees++; return { ok: false, raison: 'the shop\'s daily limit is reached - try again tomorrow' }; }
      const solde = await soldeUsdc();
      if (solde !== null && solde < usd) { MESURE.refusees++; return { ok: false, raison: 'the shop wallet is short on funds for this plan right now - nothing was charged' }; }
      const v = vuePlan(info.p, usd);
      if (opts.marge >= 1) v.factureUsd = arrondi(usd * opts.marge);
      const o = Object.assign({ id: crypto.randomBytes(8).toString('hex'), qui: q, destination: info.destination, t: maintenant(), expire: maintenant() + OFFRE_MS,
        cle: cleIdem(), etat: 'propose' }, v);
      OFFRES.set(o.id, o);
      MESURE.offres++;
      for (const [k, x] of OFFRES) if (maintenant() > x.expire + OFFRE_MS) OFFRES.delete(k);
      return { ok: true, offre: publique(o) };
    }
    const publique = (o) => ({ id: o.id, plan: o.plan, nom: o.nom, destination: o.destination, go: o.go, jours: o.jours, usd: o.usd, factureUsd: o.factureUsd,
      expire: o.expire, conditions: CONDITIONS, remboursements: REMBOURSEMENTS, compatibles: COMPATIBLES });

    /** Le joueur confirme (route de la page, avec SA session) : on paie, on facture, on livre. */
    async function confirme(id) {
      const o = OFFRES.get(String(id || ''));
      if (!o || o.qui !== q) return { ok: false, raison: 'this offer does not exist or is not yours' };
      if (o.etat !== 'propose') return { ok: false, raison: o.etat === 'en cours' ? 'this purchase is already running' : 'this offer was already used - ask the agent again' };
      if (maintenant() > o.expire) return { ok: false, raison: 'this offer expired - ask the agent again' };
      o.etat = 'en cours';                                               /* un double clic ne paie pas deux fois */
      const rend = (r) => { o.etat = r.garde ? 'propose' : 'fini'; return r.r; };
      const t0 = jour0();
      if (depuis(t0, q) + o.usd > maxJoueur()) { MESURE.refusees++; return rend({ r: { ok: false, raison: 'your daily purchase limit (' + maxJoueur() + ' $) would be passed' } }); }
      if (depuis(t0, null) + o.usd > maxJour()) { MESURE.refusees++; return rend({ r: { ok: false, raison: 'the shop\'s daily limit is reached - try again tomorrow' } }); }
      let r1;
      try { r1 = await commande(o.plan, o.cle); } catch (e) { MESURE.echecs++; return rend({ garde: true, r: { ok: false, raison: 'the eSIM shop did not answer - nothing was charged, you can try again' } }); }
      if (r1.status !== 402) { MESURE.echecs++; return rend({ r: { ok: false, raison: 'the eSIM shop answered HTTP ' + r1.status + ' - nothing was charged' } }); }
      const req = await X.lit402(r1);
      const acc = req && X.offrePour(w, req.accepts);
      if (!acc) { MESURE.refusees++; return rend({ r: { ok: false, raison: 'the eSIM shop no longer takes USDC on Solana - nothing was charged' } }); }
      const usd = Number(acc.amount) / 1e6;
      if (!(usd > 0) || usd > o.usd * TOLERANCE_PRIX + 1e-9) { MESURE.refusees++; return rend({ r: { ok: false, raison: 'the price changed (' + usd + ' $ instead of ' + o.usd + ' $) - nothing was charged, ask the agent again' } }); }
      MESURE.confirmees++;
      const res = await factu.reserve(o.factureUsd);
      if (!res || !res.ok) { MESURE.refusees++; return rend({ garde: true, r: { ok: false, raison: (res && res.raison) || 'your balance is too low for this eSIM' } }); }
      const sg = await X.signe(w, acc, { blockhash: deps.blockhash, maintenant });
      if (sg.erreur) { await factu.regle(res.jeton, 0); MESURE.echecs++; return rend({ garde: true, r: { ok: false, raison: sg.erreur + ' - nothing was charged' } }); }
      /* Au registre AVANT d'envoyer : un redemarrage pendant l'appel compte la depense. */
      const base0 = Object.assign({ id: o.id, qui: q, plan: o.plan, nom: o.nom, destination: o.destination, usd, factureUsd: o.factureUsd, reseau: acc.network, sig: sg.signature || null },
        opts.lien ? { lien: opts.lien, go: o.go, jours: o.jours } : {});
      note(Object.assign({ t: maintenant(), etat: 'en cours' }, base0));
      let r2;
      try { r2 = await commande(o.plan, o.cle, X.enteteDe(req, acc, sg.payload)); } catch (e) { r2 = null; }
      const tx = r2 ? X.txDe(r2) : null;
      if (!r2 || r2.status !== 200) {
        await factu.regle(res.jeton, 0);
        note(Object.assign({ t: maintenant(), etat: tx ? 'perte' : 'rendu', tx, http: r2 ? r2.status : null }, base0, tx ? {} : { usd: 0 }));
        MESURE.echecs++;
        if (tx) MESURE.depenseUsd += usd;
        return rend({ r: { ok: false, raison: 'the eSIM shop ' + (r2 ? 'answered HTTP ' + r2.status : 'did not answer') + ' - you were not charged' } });
      }
      let corps = {};
      try { corps = await r2.json(); } catch (e) { corps = {}; }
      const cmd = (corps && corps.order) || {};
      const liv = (corps && corps.delivery) || {};
      await factu.regle(res.jeton, o.factureUsd);
      note(Object.assign({ t: maintenant(), etat: 'paye', tx, commande: String(cmd.publicId || ''), grant: String(liv.grantToken || ''),
        installUrl: String(liv.installUrl || '') }, base0));
      MESURE.payees++; MESURE.depenseUsd += usd; MESURE.factureUsd += o.factureUsd;
      o.etat = 'fini';
      const l = await livre(o.id);
      return { ok: true, achat: l.achat || vue(dernier(o.id)), livree: !!l.ok };
    }

    /** Le code d'activation : demande au vendeur avec le jeton de livraison (retentable). */
    async function livre(id) {
      const a = dernier(String(id || ''));
      if (!a || a.qui !== q) return { ok: false, raison: 'this purchase does not exist or is not yours' };
      if (a.etat === 'livre') return { ok: true, achat: vue(a) };
      if (a.etat !== 'paye') return { ok: false, raison: 'this purchase was not paid' };
      if (!/^[0-9a-f-]{8,64}$/i.test(a.commande) || !a.grant) return { ok: false, raison: 'the shop did not send a delivery token - contact support with your transaction', achat: vue(a) };
      const url = base + '/api/v1/x402/orders/' + encodeURIComponent(a.commande) + '/install';
      let r;
      try { r = await http(url, { method: 'POST', headers: { authorization: 'Bearer ' + a.grant, accept: 'application/json', 'content-type': 'application/json' }, body: '{}' }); }
      catch (e) { return { ok: false, raison: 'the eSIM shop did not answer - try again in a minute', achat: vue(a) }; }
      if (r.status !== 200) return { ok: false, raison: 'your eSIM is being prepared (HTTP ' + r.status + ') - try again in a minute', achat: vue(a) };
      let d = {};
      try { d = await r.json(); } catch (e) { d = {}; }
      const uri = String(d.activationUri || '');
      if (!/^LPA:1\$/.test(uri)) return { ok: false, raison: 'your eSIM is being prepared - try again in a minute', achat: vue(a) };
      /* L'enregistrement complet (montant compris) : le dernier etat seul compte dans les plafonds. */
      note(Object.assign({}, a, { etat: 'livre', activation: { uri: uri.slice(0, 300), code: String(d.activationCode || '').slice(0, 200),
        smdp: String(d.smdpAddress || '').slice(0, 200), iccid4: String(d.iccidLast4 || '').slice(0, 8) } }));
      MESURE.livrees++;
      return { ok: true, achat: vue(dernier(a.id)) };
    }

    /** Ce que le joueur voit : jamais le jeton de livraison ni la signature. */
    function vue(a) {
      return { id: a.id, t: a.t, nom: a.nom, destination: a.destination || null, go: a.go || null, jours: a.jours || null, usd: a.usd || 0, factureUsd: a.factureUsd || 0,
        etat: a.etat, tx: a.tx || null, reseau: a.reseau || null, activation: a.etat === 'livre' ? a.activation : null };
    }
    function liste(n) {
      const der = new Map();
      for (const l of lignes) if (l.qui === q) der.set(l.id, Object.assign({}, der.get(l.id) || {}, l));
      return [...der.values()].filter((a) => a.etat !== 'rendu').sort((x, y) => y.t - x.t).slice(0, n || 20).map(vue);
    }
    const budget = () => ({ jourUsd: maxJoueur(), depenseUsd: arrondi(depuis(jour0(), q)), maxAchatUsd: maxAchat(), marge: marge() });
    return { forfaits, propose, confirme, livre, liste, budget };
  }

  /** Le prix CHIPS d'un forfait deja sonde (30 min), sans reseau : le devis x402 est synchrone. */
  function prixConnu(slug) {
    const c = PRIX.get(String(slug || ''));
    return PLANS.has(String(slug || '')) && c && maintenant() - c.t < PRIX_TTL_MS ? c.usd : null;
  }
  /** Le lien secret de la boutique : le dernier etat de l'achat qui le porte, puis sa livraison. */
  async function parLien(lien) {
    const k = String(lien || '');
    if (!/^[0-9a-f]{32}$/.test(k)) return { ok: false, raison: 'unknown order link' };
    let id = null, qui = null;
    for (const l of lignes) if (l.lien === k) { id = l.id; qui = l.qui; }
    if (!id) return { ok: false, raison: 'unknown order link' };
    return pour(qui, { reserve: async () => ({ ok: true, jeton: 0 }), regle: async () => {} }).livre(id);
  }

  /** Les PAYS vendus (la liste de CHIPS, en cache comme les destinations) : [{ code, nom }] par nom — pour choisir sans taper. */
  async function pays() {
    const vus = new Set(), l = [];
    for (const d of await destinations()) {
      const c = d && d.kind === 'country' && String((d.countryCodes || [])[0] || '').toUpperCase();
      if (!c || !/^[A-Z]{2}$/.test(c) || vus.has(c)) continue;
      vus.add(c); l.push({ code: c, nom: String(d.name || c).replace(/[\x00-\x1f<>]/g, '').slice(0, 60) });
    }
    return l.sort((a, b) => a.nom.localeCompare(b.nom, 'en'));
  }
  return { pour, forfaits, prixConnu, parLien, actif, MESURE, pays, adresse: w ? w.address : null,
    etat: () => ({ actif: actif(), vendeur: hote, reseau: w ? reseau.network : null, maxAchatUsd: maxAchat(), maxJoueurUsd: maxJoueur(), maxJourUsd: maxJour(), marge: marge(),
      aujourdhuiUsd: arrondi(depuis(jour0(), null)), mesure: Object.assign({}, MESURE) }) };
}

module.exports = { cree, BASE_CHIPS, CONDITIONS, REMBOURSEMENTS, OFFRE_MS, TOLERANCE_PRIX };
