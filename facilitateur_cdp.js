'use strict';
/* ==================================================================
 * LE FACILITATEUR DE COINBASE (CDP) : VÉRIFIER ET RÉGLER UN PAIEMENT x402 EN USDC SUR BASE
 * ==================================================================
 *
 * Lot « Base » (tâche #29, contrat base_design/CONTRAT.md du 27 septembre 2026,
 * §A.6). Coinbase vérifie la signature EIP-3009 du payeur, envoie la
 * transaction et paie le gaz ; nous ne touchons jamais une clé de portefeuille
 * sur Base. Seuls `crypto` et `fetch` de Node : AUCUNE dépendance npm.
 *
 * ---- LES ADRESSES ----
 * Base : https://api.cdp.coinbase.com/platform/v2/x402 (cdp-sdk
 * typescript/packages/cdp-sdk/src/x402/facilitator.ts:10, commit bf134ab0 du
 * 25 septembre 2026) ; chemins /verify, /settle, /supported (même fichier,
 * :60-68). Une barre finale est retirée comme le fait le SDK : sans cela,
 * « …/x402//verify » ne correspond plus au `uris` du jeton → 401.
 *
 * ---- LE JETON (un par requête, lié à UNE méthode et UN chemin) ----
 * En-tête { alg, kid, typ:'JWT', nonce (16 octets hex) } ; revendications
 * { sub, iss:'cdp', uris:['POST api.cdp.coinbase.com/platform/v2/x402/verify'],
 * iat, nbf, exp = iat + 120 }. Sources : SDK auth/utils/jwt.ts :135 (120 s),
 * :140 (iss), :146 (uris), :339 (en-tête), :354-357 (nonce) ; DOCS
 * get-started/authentication/jwt-authentication (« Your JWT expires after 2
 * minutes »). Comparé octet pour octet (hors nonce et horodatage) au SDK
 * 1.57.0 le 27 septembre 2026 : base_design/sdk_check/compare.out.
 *
 * ---- LA CLÉ SECRÈTE ----
 * Ed25519 (défaut de Coinbase) : base64 de 64 octets, graine puis clé
 * publique ; la moitié publique est VÉRIFIÉE contre la graine (Node accepte un
 * JWK incohérent et signe avec la graine seule, là où le SDK le refuse —
 * mesuré dans sdk_check/compare.out). ECDSA P-256 : PEM « EC PRIVATE KEY » ou
 * « PRIVATE KEY ». Un « \n » écrit est changé en saut de ligne (SDK Python,
 * cdp/auth/utils/jwt.py:277-280). Aucun message d'erreur ne contient le secret.
 *
 * ---- LIRE LES RÉPONSES : LE STATUT D'ABORD, LE CORPS ENSUITE ----
 * Le vrai 401 est `text/plain`, corps « Unauthorized\n » (relevé en direct le
 * 26 et le 27 septembre 2026, base_design/live/sup.h, sdk_check/sonde_401.out) :
 * lire le JSON d'abord aurait changé une mauvaise clé en « erreur inattendue »
 * et Base n'aurait jamais été suspendue.
 *
 * Journal : statut HTTP, raison, durée, réseau. JAMAIS le secret, le jeton ni
 * l'en-tête Authorization.
 * ================================================================== */

const crypto = require('crypto');

const URL_DEFAUT = 'https://api.cdp.coinbase.com/platform/v2/x402';
/* 90 s : le défaut du client de référence (x402-foundation
   core/src/http/httpFacilitatorClient.ts:16, DEFAULT_TIMEOUT_MS = 90_000,
   commit 4fcf836c du 25 septembre 2026). */
const DELAI_SETTLE_MS = 90000;
/* 20 s : valeur de DÉPART, non mesurée (contrat §A.6) — à régler sur le p99
   mesuré (MESURE.parReseau[…].msVerify) quand il y aura des paiements. */
const DELAI_VERIFY_MS = 20000;
/* La marge de validité que le facilitateur de référence exige au règlement
   (x402-foundation mechanisms/evm/src/exact/facilitator/eip3009.ts:219 : 6 s).
   Celle de Coinbase n'est pas documentée. */
const MARGE_VALIDITE_S = 6;
/* Erreurs de règlement AMBIGUËS : la transaction « may or may not have landed »
   (DOCS x402/support/troubleshooting, tableau « Settlement only » et la phrase
   qui le suit, copie du 27 septembre 2026) : on relit la chaîne avant de conclure. */
const AMBIGUES = ['invalid_exact_evm_verification_failed', 'settle_exact_node_failure', 'settle_exact_evm_transaction_confirmation_timed_out'];

const b64u = (b) => Buffer.from(b).toString('base64url');

/** Lit le secret CDP. Rend { alg, key }. Jette une erreur SANS le secret. */
function lisSecret(secret) {
  const echec = (m) => new Error('CDP_API_KEY_SECRET is not an Ed25519 or P-256 key' + (m ? ' (' + m + ')' : ''));
  let s = String(secret || '');
  if (!s.trim()) throw echec('empty');
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  if (s.includes('-----BEGIN')) {
    let key;
    try { key = crypto.createPrivateKey({ key: s, format: 'pem' }); } catch (e) { throw echec('unreadable PEM'); }
    const det = key.asymmetricKeyDetails || {};
    if (key.asymmetricKeyType !== 'ec' || det.namedCurve !== 'prime256v1') throw echec('EC key must be P-256');
    return { alg: 'ES256', key };
  }
  const raw = Buffer.from(s.trim(), 'base64');
  if (raw.length !== 64) throw echec('Ed25519 key must be 64 bytes');
  let key;
  try { key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', d: b64u(raw.subarray(0, 32)), x: b64u(raw.subarray(32)) } }); }
  catch (e) { throw echec('unreadable Ed25519 key'); }
  const x = crypto.createPublicKey(key).export({ format: 'jwk' }).x;
  if (x !== b64u(raw.subarray(32))) throw echec('Ed25519 public half does not match seed');
  return { alg: 'EdDSA', key };
}

/** L'adresse d'une opération : origine + chemin sans barre finale + '/' + op. */
function adresse(url, op) {
  const u = new URL(url);
  const base = u.pathname.replace(/\/+$/, '');
  return { fetch: u.origin + base + '/' + op, uri: u.host + base + '/' + op };
}

/** Un jeton neuf pour UNE requête (méthode + chemin). */
function jeton({ cleId, lu, methode, uri, maintenant }) {
  const t = Math.floor((maintenant || Date.now()) / 1000);
  const entete = { alg: lu.alg, kid: cleId, typ: 'JWT', nonce: crypto.randomBytes(16).toString('hex') };
  const corps = { sub: cleId, iss: 'cdp', uris: [methode + ' ' + uri], iat: t, nbf: t, exp: t + 120 };
  const entree = b64u(JSON.stringify(entete)) + '.' + b64u(JSON.stringify(corps));
  const sig = lu.alg === 'EdDSA' ? crypto.sign(null, Buffer.from(entree), lu.key)
    : crypto.sign('sha256', Buffer.from(entree), { key: lu.key, dsaEncoding: 'ieee-p1363' });
  return entree + '.' + b64u(sig);
}

/** L'en-tête EXTENSION-RESPONSES (base64 JSON), décodé ; null s'il manque ou est illisible. */
function extensionDe(h) {
  const v = h && typeof h.get === 'function' ? h.get('extension-responses') : null;
  if (!v) return null;
  try { const o = JSON.parse(Buffer.from(String(v), 'base64').toString('utf8')); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
}

/**
 * cree({ url, cleId, cleSecrete, delaiVerifyMs, delaiSettleMs, journal, fetch, maintenant })
 *   → { supported(), verify(paiement, exigence), regle(paiement, exigence), algo }
 * Jette (sans le secret) si la clé est illisible.
 */
function cree(o) {
  o = o || {};
  /* ---- SANS CLE : LE FACILITATEUR DE PAYAI (27 septembre 2026) ----
   * Meme protocole x402 v2 (/supported, /verify, /settle, meme corps), mais
   * « No API key required for ordinary exact payments » : 1 000 credits
   * gratuits a vie par portefeuille receveur, ~430 reglements sur Base a
   * 2,31 credits (docs.payai.network/x402/facilitators/pricing, relu le
   * 27/09). Aucun en-tete Authorization n'est alors envoye. */
  const sansCle = !!o.sansCle;
  const url = o.url || (sansCle ? null : process.env.CDP_FACILITATOR_URL) || URL_DEFAUT;
  const cleId = String(o.cleId || '').trim();
  if (!sansCle && !cleId) throw new Error('CDP_API_KEY_ID is missing');
  const lu = sansCle ? { alg: 'none' } : lisSecret(o.cleSecrete);
  const f = o.fetch || fetch;
  const maintenant = () => (o.maintenant ? o.maintenant() : Date.now());
  const delaiVerifyMs = o.delaiVerifyMs || DELAI_VERIFY_MS;
  const delaiSettleMs = o.delaiSettleMs || DELAI_SETTLE_MS;
  const journal = (l) => { if (o.journal) { try { o.journal(l); } catch (e) { /* jamais bloquant */ } } };

  /* Une requête : { statut, texte, json, entetes, extension, ms } ou { erreur: 'delai'|'reseau', ms }. */
  async function appel(methode, op, octets, delaiMs) {
    const a = adresse(url, op);
    const t0 = Date.now();
    const ctl = new AbortController();
    const minuterie = setTimeout(() => ctl.abort(), Math.max(1, delaiMs));
    try {
      const entetes = { Accept: 'application/json' };
      if (!sansCle) entetes.Authorization = 'Bearer ' + jeton({ cleId, lu, methode, uri: a.uri, maintenant: maintenant() });
      if (octets) entetes['Content-Type'] = 'application/json';
      const r = await f(a.fetch, { method: methode, headers: entetes, body: octets || undefined, signal: ctl.signal });
      const texte = await r.text();
      let json = null;
      try { json = JSON.parse(texte); } catch (e) { json = null; }
      return { statut: r.status, texte, json: json && typeof json === 'object' ? json : null, extension: extensionDe(r.headers), ms: Date.now() - t0 };
    } catch (e) {
      return { erreur: ctl.signal.aborted ? 'delai' : 'reseau', ms: Date.now() - t0 };
    } finally { clearTimeout(minuterie); }
  }

  /* Le corps : { x402Version: 2, paymentPayload, paymentRequirements } (OAS 14449-14464,
     14487-14502 ; x402-foundation httpFacilitatorClient.ts:411-420). Figé en OCTETS :
     le renvoi d'un règlement en attente doit être le MÊME corps. */
  const corpsDe = (paiement, exigence) => Buffer.from(JSON.stringify({ x402Version: 2, paymentPayload: paiement, paymentRequirements: exigence }));

  /* Le 403 : la raison est dans le JSON, sous l'un de ces noms (DOCS troubleshooting:112-120, :194-195). */
  const raison403 = (j) => String((j && (j.invalidReason || j.errorReason || j.errorType)) || 'forbidden');
  const pauseDe = (r) => (r.statut === 401 ? 'cle' : r.statut === 402 ? 'carte' : null);

  async function supported() {
    const r = await appel('GET', 'supported', null, delaiVerifyMs);
    journal({ op: 'supported', statut: r.statut || r.erreur, ms: r.ms });
    if (r.erreur) return { ok: false, statut: null, erreur: r.erreur };
    if (r.statut !== 200 || !r.json) return { ok: false, statut: r.statut };
    return { ok: true, statut: 200, kinds: Array.isArray(r.json.kinds) ? r.json.kinds : [], extensions: r.json.extensions || [], signers: r.json.signers || {} };
  }

  /**
   * Vérifie. Rend { etat: 'valide'|'refuse'|'inconnu'|'cle'|'carte'|'kyt'|'lieu'|'interdit',
   *                 raison, message, payer, extension, ms, statut }.
   */
  async function verify(paiement, exigence) {
    const r = await appel('POST', 'verify', corpsDe(paiement, exigence), delaiVerifyMs);
    const out = (etat, x) => {
      const res = Object.assign({ etat, ms: r.ms, statut: r.statut || null, extension: r.extension || null }, x || {});
      journal({ op: 'verify', statut: r.statut || r.erreur, raison: res.raison || null, message: res.message || null, ms: r.ms, network: exigence && exigence.network });
      return res;
    };
    if (r.erreur) return out('inconnu', { raison: 'unexpected_verify_error' });
    if (r.statut === 401) return out('cle', { raison: 'unexpected_verify_error' });
    if (r.statut === 402) return out('carte', { raison: 'unexpected_verify_error' });
    const j = r.json;
    if (r.statut === 403) {
      const x = raison403(j);
      return out(x === 'kyt_risk_detected' ? 'kyt' : x === 'request_blocked_by_location' ? 'lieu' : 'interdit', { raison: x, message: j && (j.invalidMessage || j.errorMessage) });
    }
    if (j && j.isValid === true && r.statut >= 200 && r.statut < 300) return out('valide', { payer: j.payer || null });
    if (j && j.isValid === false) return out('refuse', { raison: j.invalidReason || 'invalid_payload', message: j.invalidMessage || null, payer: j.payer || null });
    return out('inconnu', { raison: 'unexpected_verify_error' });
  }

  /**
   * Règle. Rend { etat: 'paye'|'echec'|'attente'|'ambigu'|'inconnu', hash, erreur, message, extension, pause, statut, ms }.
   *   - 'attente' : settlement_pending avec une transaction, APRÈS un seul renvoi du même corps ;
   *   - 'ambigu'  : une erreur « may or may not have landed » — relire la chaîne ;
   *   - 'inconnu' : délai, réseau ou 5xx sans corps lisible — ne JAMAIS rejouer (un rejeu d'un
   *                 règlement passé rend 400 invalid_payload, ambigu : DOCS troubleshooting
   *                 « Settlement timed out. Should I retry? ») ;
   *   - `pause`   : 'cle' (401), 'carte' (402), 'lieu' (403 request_blocked_by_location).
   */
  async function regle(paiement, exigence) {
    const octets = corpsDe(paiement, exigence);
    /* Le délai : au plus ce qu'il reste de validité à l'autorisation, moins la marge du facilitateur. */
    const vb = Number(((paiement && paiement.payload && paiement.payload.authorization) || {}).validBefore);
    const reste = Number.isFinite(vb) ? (vb - Math.floor(maintenant() / 1000) - MARGE_VALIDITE_S) * 1000 : delaiSettleMs;
    const delai = Math.max(100, Math.min(delaiSettleMs, reste));
    const lire = (r) => {
      if (r.erreur) return { etat: 'inconnu', erreur: 'unexpected_settle_error' };
      if (r.statut === 401) return { etat: 'echec', erreur: 'unexpected_settle_error', pause: 'cle' };
      if (r.statut === 402) return { etat: 'echec', erreur: 'payment_method_required', message: r.json && r.json.errorMessage, pause: 'carte' };
      const j = r.json;
      if (r.statut === 403) {
        const x = raison403(j);
        return { etat: 'echec', erreur: x, message: j && (j.errorMessage || j.invalidMessage), pause: x === 'request_blocked_by_location' ? 'lieu' : null };
      }
      if (j && (j.success === true || j.success === false || j.errorReason)) {
        if (j.success === true && r.statut >= 200 && r.statut < 300) return { etat: 'paye', hash: j.transaction || '', payer: j.payer || null };
        if (j.errorReason === 'settlement_pending' && j.transaction) return { etat: 'attente', hash: j.transaction, erreur: 'settlement_pending' };
        if (AMBIGUES.includes(j.errorReason)) return { etat: 'ambigu', hash: j.transaction || '', erreur: j.errorReason, message: j.errorMessage };
        return { etat: 'echec', erreur: j.errorReason || 'unexpected_settle_error', message: j.errorMessage || null };
      }
      /* Pas de JSON reconnaissable : un 5xx peut avoir réglé (chemin sans hash), un 4xx non. */
      return r.statut >= 500 ? { etat: 'inconnu', erreur: 'unexpected_settle_error' } : { etat: 'echec', erreur: 'unexpected_settle_error' };
    };
    let r = await appel('POST', 'settle', octets, delai);
    let x = lire(r);
    const extensions = [r.extension].filter(Boolean);
    journal({ op: 'settle', statut: r.statut || r.erreur, raison: x.erreur || null, message: x.message || null, ms: r.ms, network: exigence && exigence.network });
    if (x.etat === 'attente') {
      /* DOCS x402/seller/settlement-pending, « Reconcile a direct API call » : le MÊME
         corps, UNE fois (jeton neuf). Encore en attente : on arrête d'appeler Coinbase. */
      const r2 = await appel('POST', 'settle', octets, delai);
      const x2 = lire(r2);
      if (r2.extension) extensions.push(r2.extension);
      journal({ op: 'settle', renvoi: true, statut: r2.statut || r2.erreur, raison: x2.erreur || null, ms: r2.ms, network: exigence && exigence.network });
      if (x2.etat === 'paye') x = x2;
      else if (x2.etat === 'attente') x = x2;
      else x = Object.assign({}, x, { renvoi: x2.etat });   /* le renvoi n'a rien dit de mieux : on garde le hash de l'attente */
      r = r2;
    }
    return Object.assign({ statut: r.statut || null, ms: r.ms, extension: extensions[extensions.length - 1] || null, extensions }, x);
  }

  return { supported, verify, regle, algo: lu.alg, AMBIGUES, nom: o.nom || (sansCle ? 'sans-cle' : 'cdp') };
}

module.exports = { cree, lisSecret, jeton, adresse, extensionDe, URL_DEFAUT, DELAI_SETTLE_MS, DELAI_VERIFY_MS, MARGE_VALIDITE_S, AMBIGUES };
