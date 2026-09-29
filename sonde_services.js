'use strict';
/* ==================================================================
 * LE CATALOGUE NOTE PAR NOS MESURES (29 septembre 2026)
 * ==================================================================
 *
 * Analyse « SWOGE Agent Network » (28/09), §11 et §14 : ce qui est difficile a
 * copier, ce sont les MESURES de fiabilite des services x402, pas le code. Le
 * 28/09, 13 % des services sondes du catalogue PayAI ne repondaient pas.
 *
 * Ce module sonde le catalogue public par petits lots, SANS PAYER : une requete
 * (la methode du catalogue), sur une adresse publique verifiee, sans redirection,
 * 8 s au plus. Un service « repond » s'il rend un 402 lisible (x402 v1 ou v2,
 * en-tete PAYMENT-REQUIRED ou corps avec `accepts`). On garde, par service : le
 * nombre de sondes, combien ont repondu, les 20 dernieres latences, le dernier
 * echec et sa raison. Les paiements reels (embauche, passerelle) s'y ajoutent :
 * combien, et combien ont abouti.
 *
 * Convention du projet : un chiffre dit sur combien d'observations il porte, et
 * rien n'est juge sous SONDES_ASSEZ sondes (« not enough probes yet »).
 * Une sonde par service et par jour au plus : c'est ce que fait un annuaire.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const E = require('./embauche');

const SONDES_ASSEZ = 3;
const LATENCES = 20;
const DELAI_MS = 8000;
const ECART_MS = 20 * 3600e3;            /* une sonde par service toutes les 20 h au plus */
const PAR_TOUR = 50;
const EN_PARALLELE = 4;
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'epjfwdd5aufqssqem2qn1xzybapc8g4wegkzwytdt1v', '0x036cbd53842c5426634e7929541ec2318f3dcf7e']);

/** Ce qu'on retient d'une entree du catalogue : url, description, methode, prix USDC le plus bas, reseaux. */
function fiche(x) {
  const url = String((x && x.resource) || '');
  if (!/^https:\/\//.test(url) || url.length > 500) return null;
  const acc = Array.isArray(x.accepts) ? x.accepts : [];
  const reseaux = [...new Set(acc.map((a) => String(a.network || '')).filter(Boolean))].slice(0, 6);
  const prix = acc.filter((a) => USDC.has(String(a.asset || '').toLowerCase())).map((a) => Number(a.amount != null ? a.amount : a.maxAmountRequired) / 1e6).filter((v) => v > 0);
  const inp = (x.extensions && x.extensions.bazaar && x.extensions.bazaar.info && x.extensions.bazaar.info.input) || {};
  return { url, description: String(x.description || (x.metadata && x.metadata.description) || '').replace(/[\x00-\x1f]/g, ' ').slice(0, 300),
    methode: String(inp.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET', prixUsd: prix.length ? Math.min.apply(null, prix) : null, reseaux };
}
const mediane = (l) => { if (!l.length) return null; const s = l.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * deps : { catalogue() → items bruts, fetch? (essais : (url, o) → reponse), resout? (host → [ip]), dossier, maintenant?, paiements?() → [{url, ok}] }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const fichier = deps.dossier ? path.join(deps.dossier, 'services_sondes.json') : null;
  let S = {};
  try { if (fichier) S = JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch (e) { S = {}; }
  const ecrit = () => { if (fichier) try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(fichier, JSON.stringify(S)); } catch (e) { /* jamais bloquant */ } };
  let CAT = { t: 0, l: [] };
  const MESURE = { tours: 0, sondes: 0, erreurs: 0 };

  async function catalogue() {
    if (CAT.l.length && maintenant() - CAT.t < 6 * 3600e3) return CAT.l;
    const items = await deps.catalogue();
    const vus = new Set(), l = [];
    for (const x of items || []) { const f = fiche(x); if (f && !vus.has(f.url)) { vus.add(f.url); l.push(f); } }
    CAT = { t: maintenant(), l };
    return l;
  }

  /** Une sonde : { vivant, ms, http, raison }. Rien n'est paye, rien n'est signe. */
  async function sonde(f) {
    const t0 = maintenant();
    const ips = deps.fetch ? ['1.1.1.1'] : await E.ipsPubliques(f.url, deps.resout);
    if (!ips) return { vivant: false, ms: null, http: null, raison: 'not a public https address' };
    const o = { method: f.methode, redirect: 'manual', signal: AbortSignal.timeout(DELAI_MS),
      headers: Object.assign({ accept: 'application/json' }, f.methode === 'POST' ? { 'content-type': 'application/json' } : {}), body: f.methode === 'POST' ? '{}' : undefined };
    let r;
    try { r = deps.fetch ? await deps.fetch(f.url, o) : await E.requeteEpinglee(f.url, o, ips); }
    catch (e) { return { vivant: false, ms: null, http: null, raison: /abort|timeout/i.test(String(e && (e.name || e.message))) ? 'no answer in 8 s' : 'connection failed' }; }
    const ms = maintenant() - t0;
    if (r.status !== 402) return { vivant: false, ms, http: r.status, raison: r.status >= 300 && r.status < 400 ? 'redirects elsewhere' : 'HTTP ' + r.status + ' instead of 402' };
    let lisible = !!(r.headers && r.headers.get && r.headers.get('payment-required'));
    if (!lisible) { try { const j = await r.json(); lisible = !!(j && Array.isArray(j.accepts) && j.accepts.length); } catch (e) { lisible = false; } }
    return lisible ? { vivant: true, ms, http: 402, raison: null } : { vivant: false, ms, http: 402, raison: '402 without a readable payment request' };
  }

  function note(url, r) {
    const s = S[url] || (S[url] = { n: 0, vivants: 0, ms: [], t: 0, echec: null });
    s.n++; if (r.vivant) s.vivants++;
    if (r.ms != null) { s.ms.push(r.ms); if (s.ms.length > LATENCES) s.ms.shift(); }
    s.t = maintenant();
    if (!r.vivant) s.echec = { t: s.t, raison: r.raison, http: r.http };
  }

  /** Un tour : les services jamais sondes d'abord, puis les plus anciens ; jamais deux fois en 20 h. */
  async function tour(n) {
    if (process.env.SONDES_SERVICES === '0') return null;
    MESURE.tours++;
    let l;
    try { l = await catalogue(); } catch (e) { MESURE.erreurs++; return { ok: false, raison: 'catalogue unavailable' }; }
    const t = maintenant();
    const dus = l.filter((f) => !S[f.url] || t - S[f.url].t >= ECART_MS).sort((a, b) => ((S[a.url] || {}).t || 0) - ((S[b.url] || {}).t || 0)).slice(0, n || PAR_TOUR);
    for (let i = 0; i < dus.length; i += EN_PARALLELE) {
      const lot = dus.slice(i, i + EN_PARALLELE);
      const rs = await Promise.all(lot.map((f) => sonde(f).catch(() => ({ vivant: false, ms: null, http: null, raison: 'probe failed' }))));
      lot.forEach((f, k) => note(f.url, rs[k]));
      MESURE.sondes += lot.length;
    }
    ecrit();
    return { ok: true, sondes: dus.length, catalogue: l.length };
  }

  /** Les paiements reels par service : { url → { n, ok } }. */
  function payes() {
    const m = new Map();
    for (const p of (deps.paiements ? deps.paiements() : [])) { const x = m.get(p.url) || { n: 0, ok: 0 }; x.n++; if (p.ok) x.ok++; m.set(p.url, x); }
    return m;
  }
  const vue = (f, pm) => {
    const s = S[f.url];
    const p = pm.get(f.url);
    const probes = s ? { n: s.n, answeredPct: Math.round(s.vivants / s.n * 1000) / 10, medianMs: mediane(s.ms), lastProbe: new Date(s.t).toISOString(),
      lastFailure: s.echec ? { at: new Date(s.echec.t).toISOString(), reason: s.echec.raison } : null } : { n: 0 };
    return { url: f.url, description: f.description, method: f.methode, priceUsd: f.prixUsd, networks: f.reseaux, probes,
      paidCalls: p ? { n: p.n, succeededPct: Math.round(p.ok / p.n * 1000) / 10 } : { n: 0 },
      verdict: !s || s.n < SONDES_ASSEZ ? 'not enough probes yet (' + (s ? s.n : 0) + '/' + SONDES_ASSEZ + ')'
        : s.vivants === s.n ? 'answered every probe' : s.vivants === 0 ? 'never answered' : 'answered ' + s.vivants + ' of ' + s.n + ' probes' };
  };

  /** Chercher : les mots du besoin ; ceux qui repondent d'abord (mesure suffisante), puis les moins chers. */
  async function recherche(q, n) {
    const l = await catalogue();
    const mots = String(q || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    const pm = payes();
    const rang = (f) => { const s = S[f.url]; return !s || s.n < SONDES_ASSEZ ? 1 : s.vivants / s.n >= 0.99 ? 0 : s.vivants === 0 ? 3 : 2; };
    const choisis = (mots.length ? l.map((f) => ({ f, k: mots.reduce((a, m) => a + ((f.description + ' ' + f.url).toLowerCase().includes(m) ? 1 : 0), 0) })).filter((x) => x.k > 0) : l.map((f) => ({ f, k: 0 })))
      .sort((a, b) => (b.k - a.k) || (rang(a.f) - rang(b.f)) || ((a.f.prixUsd == null ? 1e9 : a.f.prixUsd) - (b.f.prixUsd == null ? 1e9 : b.f.prixUsd)))
      .slice(0, Math.min(50, Math.max(1, Number(n) || 20)));
    return { ok: true, query: String(q || '').slice(0, 100), services: choisis.map((x) => vue(x.f, pm)), summary: resume(l),
      note: 'Measured by SWOGE without paying: one request per service at most every 20 hours, a service "answers" when it returns a readable x402 402. No verdict under ' + SONDES_ASSEZ + ' probes. Paid calls are real payments made through SWOGE.' };
  }

  function resume(l) {
    l = l || CAT.l;
    const sondes = l.filter((f) => S[f.url]);
    const juges = sondes.filter((f) => S[f.url].n >= SONDES_ASSEZ);
    const muets = juges.filter((f) => S[f.url].vivants === 0).length;
    return { catalogue: l.length, probed: sondes.length, judged: juges.length, neverAnsweredPct: juges.length ? Math.round(muets / juges.length * 1000) / 10 : null };
  }

  return { tour, recherche, resume: () => resume(), MESURE, etat: () => Object.assign({ mesure: Object.assign({}, MESURE) }, resume()) };
}

module.exports = { cree, fiche, SONDES_ASSEZ, ECART_MS };
