'use strict';
/* ==================================================================
 * L'INSCRIPTION AUTOMATIQUE AU CATALOGUE PAYAI (27 septembre 2026)
 * ==================================================================
 *
 * Demande du proprietaire : « si je mets une cle privee dans Railway, tu peux
 * faire les paiements automatiquement pour les valider ». PayAI n'inscrit un
 * outil qu'a son premier reglement par son facilitateur (mesure du 27/09 : 0
 * outil inscrit avant le premier paiement, chacun inscrit dans la minute du
 * sien). Six outils ajoutes ce soir-la n'y etaient pas.
 *
 * X402_AUTO_CLE : la cle d'un portefeuille DEDIE (jamais le principal), avec
 * quelques dizaines de cents d'USDC. Deux formes (le 27/09, le proprietaire a
 * mis une cle SOLANA et ses USDC sur Solana — la premiere version, Base seule,
 * l'a refusee sans rien signer) :
 *   - une cle EVM (64 hexadecimaux) : USDC sur Base, autorisation EIP-3009 ;
 *   - une cle Solana (base58 de 64 octets, l'export de Phantom, ou le tableau
 *     JSON de 64 nombres du CLI) : USDC sur Solana, la transaction du client de
 *     reference x402 (x402_solana.js, le meme fichier que la page de test),
 *     signee ed25519 ; PayAI regle toujours Solana.
 * Au demarrage, le serveur paie UNE fois chaque outil payable absent du
 * catalogue PayAI, comme un agent : demande → 402 → signature → rejoue avec
 * PAYMENT-SIGNATURE.
 * Son adresse compte comme la maison : ses paiements passent par PayAI
 * (x402.facilitateurDe) et ne sont pas comptes comme des clients.
 *
 * Garde-fous, tous verifies AVANT de signer :
 *   - il ne paie que NOTRE serveur (MOI_URL), et seulement vers NOTRE
 *     adresse de reception (tresorerie Base, ou X402_SOLANA_PAYTO), en USDC ;
 *   - AUTO_MAX_APPEL_USD (0,03 $) par appel, AUTO_MAX_TOTAL_USD (0,20 $) en tout ;
 *   - un outil paye (ou deux fois rate) ne se repaie jamais : l'etat est ecrit
 *     sur disque AVANT chaque paiement ;
 *   - la cle ne sort jamais : ni journal, ni reponse — l'adresse seule.
 * L'argent va a la tresorerie : il revient au proprietaire.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
/* x402_solana.js vise le navigateur (crypto.subtle, btoa) : Node 18 (le Dockerfile) n'a pas `crypto` en global. */
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
const Sol = require('./x402_solana');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RESEAU_SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const DOMAINE = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE };
const TYPES_3009 = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
const ESSAIS_MAX = 2;

/** Le portefeuille de X402_AUTO_CLE : { type, address, … } ou null (jamais la cle dans un message). */
function portefeuille(cle) {
  const c = String(cle || '').trim();
  if (!c) return null;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(c)) {
    try { const w = new ethers.Wallet(/^0x/.test(c) ? c : '0x' + c); return { type: 'evm', address: w.address, w }; } catch (e) { return null; }
  }
  /* Solana : 64 octets (graine ‖ cle publique) en base58 ou en tableau JSON, ou la graine seule (32). */
  let o = null;
  try {
    if (/^\[[\d,\s]+\]$/.test(c)) o = Buffer.from(JSON.parse(c));
    else if (/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(c)) o = Buffer.from(ethers.utils.base58.decode(c));
  } catch (e) { o = null; }
  if (!o || (o.length !== 64 && o.length !== 32)) return null;
  try {
    const cle = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, o.slice(0, 32)]), format: 'der', type: 'pkcs8' });
    const pub = crypto.createPublicKey(cle).export({ format: 'der', type: 'spki' }).slice(-32);
    if (o.length === 64 && !pub.equals(o.slice(32))) return null;           /* la moitie publique doit etre la bonne */
    return { type: 'solana', address: ethers.utils.base58.encode(pub), signe: (msg) => crypto.sign(null, Buffer.from(msg), cle) };
  } catch (e) { return null; }
}

function cree(deps) {
  const w = portefeuille(deps.cle);
  const maintenant = deps.maintenant || Date.now;
  const maxAppel = () => { const v = Number(process.env.AUTO_MAX_APPEL_USD); return v > 0 ? v : 0.03; };
  const maxTotal = () => { const v = Number(process.env.AUTO_MAX_TOTAL_USD); return v > 0 ? v : 0.2; };
  const fichier = path.join(deps.dossier, 'auto_inscription.json');
  let etat = { faits: {}, depenseUsd: 0 };
  try { etat = Object.assign(etat, JSON.parse(fs.readFileSync(fichier, 'utf8'))); } catch (e) { /* premier demarrage */ }
  const ecrit = () => { try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(fichier, JSON.stringify(etat, null, 2)); } catch (e) { /* le prochain passage reessaie */ } };
  const journal = (o) => { try { (deps.journal || (() => {}))(o); } catch (e) { /* jamais bloquant */ } };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  const de64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
  let enCours = false;

  async function paieUn(outil, args) {
    const url = deps.api.replace(/\/$/, '') + '/agentic/call/' + outil;
    const appel = (entetes) => deps.fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, entetes || {}),
      body: JSON.stringify({ arguments: args || {} }), signal: AbortSignal.timeout(180000) });
    const r1 = await appel();
    if (r1.status !== 402) return { ok: false, raison: 'no 402 (HTTP ' + r1.status + ')' };
    const h = r1.headers.get('payment-required');
    if (!h) return { ok: false, raison: 'no PAYMENT-REQUIRED header' };
    const req = de64(h);
    const sol = w.type === 'solana';
    const acc = (req.accepts || []).find((a) => a.network === (sol ? RESEAU_SOLANA : 'eip155:8453'));
    /* Les garde-fous, AVANT toute signature. */
    if (!acc) return { ok: false, raison: 'no ' + (sol ? 'Solana' : 'Base') + ' offer in the 402' };
    if (sol ? acc.asset !== USDC_SOLANA : String(acc.asset).toLowerCase() !== USDC_BASE.toLowerCase()) return { ok: false, raison: 'the ' + (sol ? 'Solana' : 'Base') + ' offer is not USDC' };
    const notre = sol ? deps.payToSolana : deps.payTo;
    if (!notre || (sol ? acc.payTo !== notre : String(acc.payTo).toLowerCase() !== String(notre).toLowerCase())) return { ok: false, raison: 'the 402 pays someone else than our treasury - refused' };
    if (!req.resource || String(req.resource.url || '').indexOf(deps.api.replace(/\/$/, '') + '/') !== 0) return { ok: false, raison: 'the resource is not ours - refused' };
    const usd = Number(acc.amount) / 1e6;
    if (!(usd > 0) || usd > maxAppel()) return { ok: false, raison: 'price ' + usd + ' $ above AUTO_MAX_APPEL_USD ' + maxAppel() + ' $' };
    if (etat.depenseUsd + usd > maxTotal()) return { ok: false, raison: 'AUTO_MAX_TOTAL_USD ' + maxTotal() + ' $ reached', stop: true };
    if (sol) {
      if (!acc.extra || !acc.extra.feePayer) return { ok: false, raison: 'no feePayer in the Solana offer' };
      const bh = deps.blockhash ? await deps.blockhash() : null;
      if (!bh || !bh.ok) return { ok: false, raison: 'no recent Solana blockhash' + (bh && bh.raison ? ' (' + bh.raison + ')' : '') };
      const t = await Sol.construit(acc, { payeur: w.address, blockhash: bh.blockhash });
      const octets = Buffer.from(t.octets);
      w.signe(octets.slice(1 + 128)).copy(octets, 1 + 64);            /* le payeur est le 2e signataire, apres le feePayer */
      etat.depenseUsd = Math.round((etat.depenseUsd + usd) * 1e6) / 1e6; ecrit();
      return envoie({ transaction: octets.toString('base64') });
    }
    const s = Math.floor(maintenant() / 1000);
    const auth = { from: w.address, to: acc.payTo, value: String(acc.amount), validAfter: String(s - 600),
      validBefore: String(s + Math.max(30, (Number(acc.maxTimeoutSeconds) || 120) - 20)), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
    const signature = await w.w._signTypedData(Object.assign({}, DOMAINE, acc.extra && acc.extra.name ? { name: acc.extra.name, version: acc.extra.version } : {}), TYPES_3009, auth);
    /* Compte AVANT d'envoyer : un redemarrage pendant l'appel ne repaie pas. */
    etat.depenseUsd = Math.round((etat.depenseUsd + usd) * 1e6) / 1e6; ecrit();
    return envoie({ signature, authorization: auth });

    /* Le paiement signe, rejoue sur la meme demande. */
    async function envoie(pl) {
      const r2 = await appel({ 'payment-signature': b64({ x402Version: 2, resource: req.resource, accepted: acc, payload: pl, extensions: req.extensions }) });
      let tx = null;
      try { const rep = r2.headers.get('payment-response'); tx = rep ? de64(rep).transaction || null : null; } catch (e) { tx = null; }
      if (r2.status !== 200) {
        let raison = 'HTTP ' + r2.status;
        try { const c = await r2.json(); raison += (c && (c.raison || c.error)) ? ' - ' + String(c.raison || c.error).slice(0, 160) + (c.detail ? ' (' + String(c.detail).slice(0, 160) + ')' : '') : ''; } catch (e) { /* corps illisible */ }
        /* Un refus au verify n'a rien debite : on rend ce qu'on avait compte. */
        if (!tx) { etat.depenseUsd = Math.max(0, Math.round((etat.depenseUsd - usd) * 1e6) / 1e6); ecrit(); }
        return { ok: false, raison, usd, tx };
      }
      return { ok: true, usd, tx };
    }
  }

  /** Un passage : chaque outil payable absent du catalogue PayAI, une fois. */
  async function passe() {
    if (!w) return { ok: false, raison: deps.cle ? 'X402_AUTO_CLE is not a valid private key' : 'X402_AUTO_CLE is not set' };
    if (enCours) return { ok: false, raison: 'already running' };
    enCours = true;
    try {
      let inscrits;
      try { inscrits = await deps.inscrits(); } catch (e) { return { ok: false, raison: 'the PayAI catalogue did not answer' }; }
      const faits = [];
      for (const outil of deps.outils()) {
        const f = etat.faits[outil] || {};
        if (inscrits.has(outil) || f.etat === 'paye' || (f.essais || 0) >= ESSAIS_MAX) continue;
        etat.faits[outil] = Object.assign({}, f, { etat: 'lance', t: maintenant(), essais: (f.essais || 0) + 1 }); ecrit();
        let r;
        try { r = await paieUn(outil, (deps.exemples || {})[outil]); } catch (e) { r = { ok: false, raison: String(e && e.message || e).slice(0, 160) }; }
        etat.faits[outil] = Object.assign(etat.faits[outil], r.ok ? { etat: 'paye', tx: r.tx, usd: r.usd } : { etat: 'echec', raison: r.raison, tx: r.tx || null }); ecrit();
        journal({ outil, ok: r.ok, usd: r.usd || 0, tx: r.tx || null, raison: r.ok ? null : r.raison });
        faits.push({ outil, ok: r.ok, raison: r.ok ? null : r.raison });
        if (r.stop) break;
      }
      return { ok: true, faits, depenseUsd: etat.depenseUsd };
    } finally { enCours = false; }
  }

  return { passe, etat: () => ({ actif: !!w, reseau: w ? (w.type === 'solana' ? 'solana' : 'base') : null, adresse: w ? w.address : null, depenseUsd: etat.depenseUsd, maxTotalUsd: maxTotal(), faits: etat.faits }), adresse: w ? w.address : null };
}

/** Les outils deja au catalogue public de PayAI, pour une API donnee. */
async function inscritsPayai(api, fetch, base) {
  const pref = api.replace(/\/$/, '') + '/agentic/call/';
  const noms = new Set();
  for (let off = 0; off < 50000; off += 500) {
    const r = await fetch((base || 'https://facilitator.payai.network') + '/discovery/resources?limit=500&offset=' + off, { signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    const l = d.items || [];
    for (const x of l) if (String(x.resource || '').indexOf(pref) === 0) noms.add(String(x.resource).slice(pref.length));
    if (l.length < 500) break;
  }
  return noms;
}

module.exports = { cree, portefeuille, inscritsPayai, USDC_BASE, USDC_SOLANA, RESEAU_SOLANA, DOMAINE, TYPES_3009, ESSAIS_MAX };
