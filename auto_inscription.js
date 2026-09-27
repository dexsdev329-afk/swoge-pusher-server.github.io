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
 * quelques dizaines de cents d'USDC sur Base. Au demarrage, le serveur paie
 * UNE fois chaque outil payable absent du catalogue PayAI, comme un agent :
 * demande → 402 → autorisation EIP-3009 signee → rejoue avec PAYMENT-SIGNATURE.
 * Son adresse compte comme la maison : ses paiements passent par PayAI
 * (x402.facilitateurDe) et ne sont pas comptes comme des clients.
 *
 * Garde-fous, tous verifies AVANT de signer :
 *   - il ne paie que NOTRE serveur (MOI_URL), et seulement vers NOTRE
 *     tresorerie Base, en USDC de Base ;
 *   - AUTO_MAX_APPEL_USD (0,03 $) par appel, AUTO_MAX_TOTAL_USD (0,20 $) en tout ;
 *   - un outil paye (ou deux fois rate) ne se repaie jamais : l'etat est ecrit
 *     sur disque AVANT chaque paiement ;
 *   - la cle ne sort jamais : ni journal, ni reponse — l'adresse seule.
 * L'argent va a la tresorerie : il revient au proprietaire.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DOMAINE = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE };
const TYPES_3009 = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
const ESSAIS_MAX = 2;

/** Le portefeuille de X402_AUTO_CLE, ou null (jamais la cle dans un message). */
function portefeuille(cle) {
  const c = String(cle || '').trim();
  if (!c) return null;
  try { return new ethers.Wallet(/^0x/.test(c) ? c : '0x' + c); } catch (e) { return null; }
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
    const acc = (req.accepts || []).find((a) => a.network === 'eip155:8453');
    /* Les garde-fous, AVANT toute signature. */
    if (!acc) return { ok: false, raison: 'no Base offer in the 402' };
    if (String(acc.asset).toLowerCase() !== USDC_BASE.toLowerCase()) return { ok: false, raison: 'the Base offer is not USDC' };
    if (!deps.payTo || String(acc.payTo).toLowerCase() !== String(deps.payTo).toLowerCase()) return { ok: false, raison: 'the 402 pays someone else than our treasury - refused' };
    if (!req.resource || String(req.resource.url || '').indexOf(deps.api.replace(/\/$/, '') + '/') !== 0) return { ok: false, raison: 'the resource is not ours - refused' };
    const usd = Number(acc.amount) / 1e6;
    if (!(usd > 0) || usd > maxAppel()) return { ok: false, raison: 'price ' + usd + ' $ above AUTO_MAX_APPEL_USD ' + maxAppel() + ' $' };
    if (etat.depenseUsd + usd > maxTotal()) return { ok: false, raison: 'AUTO_MAX_TOTAL_USD ' + maxTotal() + ' $ reached', stop: true };
    const s = Math.floor(maintenant() / 1000);
    const auth = { from: w.address, to: acc.payTo, value: String(acc.amount), validAfter: String(s - 600),
      validBefore: String(s + Math.max(30, (Number(acc.maxTimeoutSeconds) || 120) - 20)), nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
    const signature = await w._signTypedData(Object.assign({}, DOMAINE, acc.extra && acc.extra.name ? { name: acc.extra.name, version: acc.extra.version } : {}), TYPES_3009, auth);
    /* Compte AVANT d'envoyer : un redemarrage pendant l'appel ne repaie pas. */
    etat.depenseUsd = Math.round((etat.depenseUsd + usd) * 1e6) / 1e6; ecrit();
    const r2 = await appel({ 'payment-signature': b64({ x402Version: 2, resource: req.resource, accepted: acc, payload: { signature, authorization: auth }, extensions: req.extensions }) });
    let tx = null;
    try { const rep = r2.headers.get('payment-response'); tx = rep ? de64(rep).transaction || null : null; } catch (e) { tx = null; }
    if (r2.status !== 200) {
      let raison = 'HTTP ' + r2.status;
      try { const c = await r2.json(); raison += (c && (c.raison || c.error)) ? ' - ' + String(c.raison || c.error).slice(0, 160) : ''; } catch (e) { /* corps illisible */ }
      /* Un refus au verify n'a rien debite : on rend ce qu'on avait compte. */
      if (!tx) { etat.depenseUsd = Math.max(0, Math.round((etat.depenseUsd - usd) * 1e6) / 1e6); ecrit(); }
      return { ok: false, raison, usd, tx };
    }
    return { ok: true, usd, tx };
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

  return { passe, etat: () => ({ actif: !!w, adresse: w ? w.address : null, depenseUsd: etat.depenseUsd, maxTotalUsd: maxTotal(), faits: etat.faits }), adresse: w ? w.address : null };
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

module.exports = { cree, portefeuille, inscritsPayai, USDC_BASE, DOMAINE, TYPES_3009, ESSAIS_MAX };
