'use strict';
/* ==========================================================================
 * L'AGENT QUI EMBAUCHE D'AUTRES AGENTS — x402, SUR LE SOLDE DU JOUEUR
 * ==========================================================================
 *
 * Demande du proprietaire, 28 septembre 2026 (« etape 1 ») : SwogeAgentic paie
 * lui-meme d'autres services x402. Choix du proprietaire : le budget est sur le
 * serveur. Il l'est deja : c'est le SOLDE DE JEU du joueur, celui qui paie ses
 * taches. Un portefeuille DEDIE de l'agent (AGENT_BUDGET_CLE, jamais le
 * principal, finance par le proprietaire) regle le service en USDC ; le joueur
 * est debite en $SWOGE au cours du moment, marge comprise. Aucun argent de
 * joueur ne dort dans un portefeuille chaud.
 *
 * Ce qu'on peut embaucher (releve du 28/09 : 7 444 services au catalogue PayAI,
 * 6 077 en x402 v2 — 82 % — surtout en USDC sur Base et Solana) : un service
 * du CATALOGUE PayAI seulement, payable par notre portefeuille (son reseau,
 * USDC, « exact »). La v1 (1 367 services) aussi depuis le 28/09 au soir, son
 * format verifie dans la specification (x402_client.js, offreV1).
 *
 * Garde-fous, TOUS verifies avant de signer :
 *   - l'URL est une ressource du catalogue (l'agent ne peut pas inventer une
 *     adresse), en https, dont l'hote ne se resout que vers des adresses
 *     publiques, sans suivre de redirection (pas de SSRF vers le reseau de
 *     Railway) ; notre propre serveur exclu. L'appel part vers l'adresse IP
 *     VERIFIEE (requeteEpinglee), pas vers une seconde resolution DNS qui
 *     pourrait, entre-temps, pointer ailleurs ;
 *   - le prix du 402 ≤ EMBAUCHE_MAX_APPEL_USD (0,10 $) ;
 *   - par joueur et par jour UTC ≤ EMBAUCHE_JOUR_JOUEUR_USD (1,00 $) ;
 *   - pour toute la maison et par jour ≤ EMBAUCHE_JOUR_USD (5,00 $) ;
 *   - le solde du joueur est RESERVE avant de payer ; il n'est facture que si
 *     le service rend 200, rendu sinon. Paye mais en echec : perte de la
 *     maison, notee au registre (bornee par le plafond du jour).
 * Le registre (DATA_DIR/embauches.jsonl) garde chaque embauche : qui, quoi,
 * combien, quelle transaction. Valeurs de DEPART, pas des mesures.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const https = require('https');
const X = require('./x402_client');

const CATALOGUE_TTL_MS = 6 * 3600e3;
const CATALOGUE_MAX = 8000;
const RESULTAT_MAX_CAR = 12000;
const DELAI_MS = 25000;
const JOUR_MS = 24 * 3600e3;
const env = (k, d) => { const v = Number(process.env[k]); return v > 0 ? v : d; };
const maxAppel = () => env('EMBAUCHE_MAX_APPEL_USD', 0.1);
const maxJoueur = () => env('EMBAUCHE_JOUR_JOUEUR_USD', 1);
const maxJour = () => env('EMBAUCHE_JOUR_USD', 5);
const marge = () => { const v = Number(process.env.EMBAUCHE_MARGE); return v >= 1 ? v : 1.1; };

/** Une adresse IP privee, locale ou reservee : jamais contactee. */
function privee(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const x = String(ip).toLowerCase();
  if (x.startsWith('::ffff:')) return privee(x.slice(7));
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
}

/**
 * Une requete HTTPS vers l'adresse IP deja verifiee (`ips[0]`) : le nom d'hote sert au
 * certificat (SNI) et a l'en-tete Host, jamais a une seconde resolution DNS. Rend un
 * objet qui se lit comme une Response (status, headers.get, text, json). Corps borne a 1 Mo,
 * aucune redirection suivie (https.request n'en suit pas).
 */
function requeteEpinglee(url, o, ips) {
  return new Promise((ok, ko) => {
    const u = new URL(url);
    /* IPv4 d'abord : la sortie IPv6 de l'hebergeur n'est pas garantie. Toutes les adresses ont ete verifiees. */
    const ip = (ips || []).find((x) => net.isIPv4(x)) || (ips || [])[0];
    if (!ip) return ko(new Error('no verified address'));
    const fam = net.isIP(ip);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: o.method || 'GET',
      headers: o.headers || {}, servername: net.isIP(u.hostname) ? undefined : u.hostname, signal: o.signal, ca: o.ca,
      lookup: (h, opts, cb) => { if (opts && opts.all) cb(null, [{ address: ip, family: fam }]); else cb(null, ip, fam); } });
    req.on('response', (res) => {
      const morceaux = []; let n = 0;
      res.on('data', (d) => { n += d.length; if (n <= 1e6) morceaux.push(d); else res.destroy(); });
      res.on('error', ko);
      res.on('end', () => {
        const corps = Buffer.concat(morceaux);
        ok({ status: res.statusCode, headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v); } },
          text: async () => corps.toString('utf8'), json: async () => JSON.parse(corps.toString('utf8')) });
      });
    });
    req.on('error', ko);
    if (o.body) req.write(o.body);
    req.end();
  });
}
/** La fonction de resolution que `https.request` recoit : toujours l'adresse epinglee. */
const lookupEpingle = (ip) => (h, opts, cb) => { const fam = net.isIP(ip); if (opts && opts.all) cb(null, [{ address: ip, family: fam }]); else cb(null, ip, fam); };

/** Une entree du catalogue PayAI, reduite a ce qu'on sait payer (null sinon). v1 et v2. */
function entree(x, reseau) {
  const v = Number(x && x.x402Version);
  if (!x || (v !== 1 && v !== 2) || (x.type && x.type !== 'http')) return null;
  const url = String(x.resource || '');
  if (!/^https:\/\//.test(url) || url.length > 500) return null;
  const offres = (x.accepts || []).map((a) => (v === 1 ? X.offreV1(a) : a)).filter((a) => a && (a.scheme || 'exact') === 'exact' && a.network === reseau.network
    && String(a.asset).toLowerCase() === reseau.asset.toLowerCase() && Number(a.amount) > 0);
  if (!offres.length) return null;
  const usd = Math.min.apply(null, offres.map((a) => Number(a.amount) / 1e6));
  const info = (x.extensions && x.extensions.bazaar && x.extensions.bazaar.info) || {};
  const inp = info.input || {};
  return { url, usd, description: String(x.description || (x.metadata && x.metadata.description) || '').slice(0, 300),
    methode: String(inp.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    entree: { queryParams: inp.queryParams || null, body: inp.body || null, bodyType: inp.bodyType || null } };
}

/**
 * deps : { cle (AGENT_BUDGET_CLE), fetch, catalogue() → items PayAI, blockhash(), dossier,
 *          moi (notre origine, exclue), resout(host) → [ip] (defaut : dns), maintenant }
 */
function cree(deps) {
  const w = X.portefeuille(deps.cle);
  const reseau = X.reseauDe(w);
  const maintenant = deps.maintenant || Date.now;
  /* deps.fetch (les essais) ; sinon la requete epinglee sur l'adresse verifiee. */
  const appelHttp = deps.fetch ? (u, o) => deps.fetch(u, o) : (u, o, ips) => requeteEpinglee(u, o, ips);
  const resout = deps.resout || (async (h) => (await dns.promises.lookup(h, { all: true })).map((a) => a.address));
  const registre = deps.dossier ? path.join(deps.dossier, 'embauches.jsonl') : null;
  let CAT = { t: 0, liste: [], parUrl: new Map() };
  let charge = null;
  const lignes = [];
  try { if (registre) for (const l of fs.readFileSync(registre, 'utf8').split('\n')) if (l.trim()) lignes.push(JSON.parse(l)); } catch (e) { /* premier demarrage */ }
  const note = (o) => { lignes.push(o); if (lignes.length > 20000) lignes.splice(0, lignes.length - 20000);
    if (registre) try { fs.appendFileSync(registre, JSON.stringify(o) + '\n'); } catch (e) { /* jamais bloquant */ } };
  /* Le plafond du jour que le JOUEUR choisit sur la page (28/09) : entre 0 (embauches
     coupees) et EMBAUCHE_JOUR_JOUEUR_USD, jamais au-dessus. Absent = le plafond serveur. */
  const fPlafonds = deps.dossier ? path.join(deps.dossier, 'embauche_plafonds.json') : null;
  let PLAFONDS = {};
  try { if (fPlafonds) PLAFONDS = JSON.parse(fs.readFileSync(fPlafonds, 'utf8')) || {}; } catch (e) { PLAFONDS = {}; }
  const plafondDe = (q) => { const v = PLAFONDS[q]; return typeof v === 'number' && v >= 0 ? Math.min(v, maxJoueur()) : maxJoueur(); };
  const MESURE = { recherches: 0, embauches: 0, payees: 0, refusees: 0, echecs: 0, depenseUsd: 0, factureUsd: 0 };

  /* Chaque embauche ecrit « en cours » puis son issue : seul son DERNIER etat compte,
     sinon une embauche payee pesait deux fois dans les plafonds. « en cours » compte
     (un redemarrage pendant l'appel ne rend pas le budget) ; « rendu » ne compte pas. */
  function depuis(t0, qui) {
    const der = new Map();
    for (const l of lignes) if (l.t >= t0 && (!qui || l.qui === qui)) der.set(l.id, l);
    let s = 0;
    for (const l of der.values()) if (l.etat === 'paye' || l.etat === 'perte' || l.etat === 'en cours') s += l.usd || 0;
    return s;
  }
  const jour0 = () => { const d = new Date(maintenant()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

  async function catalogue() {
    if (CAT.liste.length && maintenant() - CAT.t < CATALOGUE_TTL_MS) return CAT;
    if (!charge) charge = (async () => {
      try {
        const items = await deps.catalogue();
        const moi = String(deps.moi || '').replace(/\/+$/, '');
        const l = [];
        for (const x of items || []) {
          const e = entree(x, reseau);
          if (!e || (moi && e.url.indexOf(moi) === 0) || e.usd > maxAppel()) continue;
          l.push(e);
          if (l.length >= CATALOGUE_MAX) break;
        }
        CAT = { t: maintenant(), liste: l, parUrl: new Map(l.map((e) => [e.url, e])) };
      } catch (e) { /* on garde l'ancien */ }
      finally { charge = null; }
    })();
    await charge;
    return CAT;
  }

  /** Les services du catalogue qui repondent a un besoin, les moins chers a pertinence egale. */
  async function cherche(besoin, n) {
    MESURE.recherches++;
    const C = await catalogue();
    const mots = String(besoin || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    if (!mots.length) return [];
    return C.liste.map((e) => {
      const t = (e.description + ' ' + e.url).toLowerCase();
      return { e, s: mots.reduce((k, m) => k + (t.indexOf(m) >= 0 ? 1 : 0), 0) };
    }).filter((x) => x.s > 0).sort((a, b) => (b.s - a.s) || (a.e.usd - b.e.usd)).slice(0, Math.min(10, n || 6)).map((x) => x.e);
  }

  /** Les adresses d'un hote, si elles sont TOUTES publiques ; null sinon. */
  async function hotePublic(url) {
    let u; try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (h === 'localhost' || /\.(local|internal|localhost)$/i.test(h)) return null;
    try { const ips = net.isIP(h) ? [h] : await resout(h); return ips.length > 0 && ips.every((ip) => !privee(ip)) ? ips : null; } catch (e) { return null; }
  }

  /**
   * Pour un joueur : { cherche, embauche }. `factu` : { reserve(usd) → { ok, jeton? , raison? }, regle(jeton, usdFacture) }.
   */
  function pour(qui, factu) {
    const q = String(qui || '').toLowerCase();
    async function embauche(a) {
      a = a || {};
      if (!w) return { ok: false, raison: 'hiring is not switched on (no agent budget wallet)' };
      if (!(plafondDe(q) > 0)) return { ok: false, raison: 'you switched paid hires off on the SwogeAgentic page - nothing was charged' };
      const url = String(a.url || '').trim();
      const C = await catalogue();
      const e = C.parUrl.get(url);
      if (!e) return { ok: false, raison: 'only a service returned by find_paid_services can be hired (this URL is not in the catalogue)' };
      const ips = await hotePublic(url);
      if (!ips) return { ok: false, raison: 'this service does not resolve to a public https address - refused' };
      const methode = a.method ? (String(a.method).toUpperCase() === 'POST' ? 'POST' : 'GET') : e.methode;
      const u = new URL(url);
      if (a.query && typeof a.query === 'object') for (const [k, v] of Object.entries(a.query).slice(0, 20)) u.searchParams.set(String(k).slice(0, 60), String(v).slice(0, 500));
      const corps = methode === 'POST' ? JSON.stringify(a.body && typeof a.body === 'object' ? a.body : {}) : undefined;
      /* Un JSON coupe ne serait plus du JSON : trop long, on refuse plutot que d'envoyer du faux. */
      if (corps && corps.length > 8000) return { ok: false, raison: 'the request body is too long (8,000 characters at most) - nothing was charged' };
      const appel = (h) => appelHttp(u.toString(), { method: methode, redirect: 'manual', signal: AbortSignal.timeout(DELAI_MS),
        headers: Object.assign({ accept: 'application/json, text/plain;q=0.9, */*;q=0.5' }, corps ? { 'content-type': 'application/json' } : {}, h || {}), body: corps }, ips);
      MESURE.embauches++;
      let r1;
      try { r1 = await appel(); } catch (x) { MESURE.echecs++; return { ok: false, raison: 'the service did not answer - nothing was charged' }; }
      if (r1.status >= 300 && r1.status < 400) { MESURE.refusees++; return { ok: false, raison: 'the service redirected elsewhere - refused, nothing was charged' }; }
      if (r1.status === 200) return Object.assign({ ok: true, gratuit: true }, await lit(r1), { recu: { url, usd: 0, factureUsd: 0, reseau: null, tx: null } });
      if (r1.status !== 402) { MESURE.echecs++; return { ok: false, raison: 'the service answered HTTP ' + r1.status + ' before any payment - nothing was charged' }; }
      const req = await X.lit402(r1);
      if (!req) { MESURE.refusees++; return { ok: false, raison: 'the service did not send an x402 payment request - nothing was charged' }; }
      const acc = X.offrePour(w, req.accepts);
      if (!acc) { MESURE.refusees++; return { ok: false, raison: 'the service does not take USDC on ' + (w.type === 'solana' ? 'Solana' : 'Base') + ' - nothing was charged' }; }
      const usd = Number(acc.amount) / 1e6;
      if (!(usd > 0) || usd > maxAppel()) { MESURE.refusees++; return { ok: false, raison: 'price ' + usd + ' $ above the ' + maxAppel() + ' $ per-call cap - nothing was charged' }; }
      const t0 = jour0();
      if (depuis(t0, q) + usd > plafondDe(q)) { MESURE.refusees++; return { ok: false, raison: 'your daily hiring budget (' + plafondDe(q) + ' $) is used up - nothing was charged' }; }
      if (depuis(t0, null) + usd > maxJour()) { MESURE.refusees++; return { ok: false, raison: 'the agent\'s daily hiring budget is used up - try again tomorrow, nothing was charged' }; }
      const factureUsd = Math.round(usd * marge() * 1e6) / 1e6;
      const res = await factu.reserve(factureUsd);
      if (!res || !res.ok) { MESURE.refusees++; return { ok: false, raison: (res && res.raison) || 'balance too low to hire this service' }; }
      const sg = await X.signe(w, acc, { blockhash: deps.blockhash, maintenant });
      if (sg.erreur) { await factu.regle(res.jeton, 0); MESURE.echecs++; return { ok: false, raison: sg.erreur + ' - nothing was charged' }; }
      /* Au registre AVANT d'envoyer : un redemarrage pendant l'appel compte la depense. */
      const id = maintenant().toString(36) + Math.random().toString(36).slice(2, 6);
      note({ id, t: maintenant(), qui: q, url, usd, etat: 'en cours', reseau: acc.network });
      let r2;
      try { r2 = await appel(X.enteteDe(req, acc, sg.payload)); } catch (x) { r2 = null; }
      const tx = r2 ? X.txDe(r2) : null;
      if (!r2 || r2.status !== 200) {
        await factu.regle(res.jeton, 0);
        note({ id, t: maintenant(), qui: q, url, usd: tx ? usd : 0, etat: tx ? 'perte' : 'rendu', tx, http: r2 ? r2.status : null });
        MESURE.echecs++;
        if (tx) MESURE.depenseUsd += usd;
        return { ok: false, raison: 'the service ' + (r2 ? 'answered HTTP ' + r2.status : 'did not answer') + ' after payment - you were not charged', tx };
      }
      const sortie = await lit(r2);
      await factu.regle(res.jeton, factureUsd);
      note({ id, t: maintenant(), qui: q, url, usd, factureUsd, etat: 'paye', tx, reseau: acc.network });
      MESURE.payees++; MESURE.depenseUsd += usd; MESURE.factureUsd += factureUsd;
      return Object.assign({ ok: true }, sortie, { recu: { url, usd, factureUsd, reseau: acc.network, tx } });
    }
    /** Les dernieres embauches de CE joueur (le dernier etat de chacune), les plus recentes d'abord. */
    function historique(n) {
      const der = new Map();
      for (const l of lignes) if (l.qui === q) der.set(l.id, Object.assign({}, der.get(l.id) || {}, l));
      return [...der.values()].sort((x, y) => y.t - x.t).slice(0, n || 20).map((l) => {
        let hote = ''; try { hote = new URL(l.url).hostname; } catch (e) { hote = ''; }
        return { t: l.t, hote, url: l.url, usd: l.usd || 0, factureUsd: l.factureUsd || 0, etat: l.etat, tx: l.tx || null, reseau: l.reseau || null };
      });
    }
    const budget = () => ({ jourUsd: plafondDe(q), maxJoueurUsd: maxJoueur(), depenseUsd: Math.round(depuis(jour0(), q) * 1e6) / 1e6, maxAppelUsd: maxAppel() });
    /** Le joueur fixe SON plafond du jour : 0 coupe les embauches, jamais au-dessus du plafond serveur. */
    function fixe(usd) {
      const v = Number(usd);
      if (!Number.isFinite(v) || v < 0) return { ok: false, raison: 'the daily budget must be a number of dollars, 0 or more' };
      if (v > maxJoueur()) return { ok: false, raison: 'the daily budget cannot be above ' + maxJoueur() + ' $' };
      PLAFONDS[q] = Math.round(v * 100) / 100;
      if (fPlafonds) try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(fPlafonds, JSON.stringify(PLAFONDS)); } catch (e) { /* garde en memoire */ }
      return { ok: true, budget: budget() };
    }
    return { cherche, embauche, historique, budget, fixe };
  }

  /** Le corps d'une reponse : du JSON si c'en est, sinon du texte, borne. */
  async function lit(r) {
    const type = String(r.headers.get('content-type') || '');
    let txt = '';
    try { txt = await r.text(); } catch (e) { txt = ''; }
    if (/^(image|video|audio)\//.test(type)) return { type, resultat: '[binary ' + type + ' content, ' + txt.length + ' bytes, not shown]' };
    return { type, resultat: txt.length > RESULTAT_MAX_CAR ? txt.slice(0, RESULTAT_MAX_CAR) + '\n[truncated]' : txt };
  }

  return { pour, cherche, catalogue, actif: () => !!w, adresse: w ? w.address : null, reseau: w ? reseau.network : null, MESURE,
    etat: () => ({ actif: !!w, adresse: w ? w.address : null, reseau: w ? reseau.network : null, services: CAT.liste.length,
      aujourdhuiUsd: Math.round(depuis(jour0(), null) * 1e6) / 1e6, maxJourUsd: maxJour(), maxJoueurUsd: maxJoueur(), maxAppelUsd: maxAppel(), mesure: Object.assign({}, MESURE) }) };
}

/** Tout le catalogue public de PayAI (/discovery/resources, par pages de 500). */
async function cataloguePayai(fetch, base) {
  const items = [];
  for (let off = 0; off < 50000; off += 500) {
    const r = await fetch((base || 'https://facilitator.payai.network') + '/discovery/resources?limit=500&offset=' + off, { signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    const l = (d && d.items) || [];
    items.push(...l);
    if (l.length < 500) break;
  }
  return items;
}

module.exports = { cree, entree, privee, cataloguePayai, requeteEpinglee, lookupEpingle, CATALOGUE_TTL_MS, RESULTAT_MAX_CAR };
