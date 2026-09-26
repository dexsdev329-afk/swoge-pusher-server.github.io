'use strict';
/* ==================================================================
 * SWOGEAGENTIC — PAYER À L'APPEL SANS COMPTE : x402 v2, EN USDG OU EN $SWOGE
 * ==================================================================
 *
 * Étape 5, décidée par le propriétaire le 26 septembre 2026 : un agent paie
 * un outil sans clé ni compte, en signant un paiement. Spécification relue le
 * même jour (github.com/coinbase/x402, specs v2 : transport HTTP, schéma
 * `exact` sur EVM, extension `eip2612GasSponsoring`) :
 *   - le serveur répond 402 avec l'en-tête `PAYMENT-REQUIRED` (JSON en
 *     base64 : x402Version 2, resource, accepts[]) ;
 *   - l'agent rejoue avec `PAYMENT-SIGNATURE` (base64 d'un PaymentPayload) ;
 *   - le serveur vérifie, sert, règle sur la chaîne et répond avec
 *     `PAYMENT-RESPONSE` (success, transaction, network, payer).
 *
 * ---- L'USDG D'ABORD (ajouté le 26 septembre 2026, demande du propriétaire) ----
 * Relevé du marché x402 ce jour-là (78 267 routes) : presque tout se paie en
 * dollars numériques ; HYRE et quatre concurrents acceptent déjà l'USDG sans
 * gaz sur Robinhood Chain. Un agent n'a pas de $SWOGE : sans USDG, il ne
 * pouvait pas payer. L'USDG a EIP-3009 (voir USDG plus bas) : le 402 le
 * propose EN PREMIER, le $SWOGE (Permit2) reste proposé en second.
 *
 * ---- POURQUOI PERMIT2 POUR LE $SWOGE, ET POURQUOI C'EST SANS GAZ POUR LE PAYEUR ----
 * Le $SWOGE n'a pas `transferWithAuthorization` (EIP-3009) mais il a `permit`
 * (EIP-2612) — vérifié sur la chaîne le 26 septembre (domaine « Swole Doge »,
 * version « 1 », DOMAIN_SEPARATOR recalculé = lu). Permit2 canonique et le
 * `x402ExactPermit2Proxy` canonique sont DÉJÀ déployés sur Robinhood Chain
 * (4663), version post-audit (WITNESS_TYPE_STRING lu sur la chaîne = spec).
 * Le payeur signe (1) l'autorisation Permit2 avec témoin, et, la première
 * fois, (2) un `permit` EIP-2612 vers Permit2 ; nous envoyons la transaction
 * et payons le gaz. Ni nous ni personne ne peut changer le montant ou le
 * destinataire : le proxy impose `witness.to`.
 *
 * VÉRIFIÉ SUR LA CHAÎNE le 26 septembre 2026, en lecture seule (callStatic) :
 * les sélecteurs de settle (0x13cd3b53) et settleWithPermit (0xfa340378)
 * sont dans le code du proxy ; une signature Permit2 VALIDE d'un portefeuille
 * vide revert TRANSFER_FROM_FAILED (la signature est acceptée, seul le solde
 * manque), celle d'un autre revert InvalidSigner() (0x815e1d64). Et le proxy
 * exige un permit EIP-2612 de valeur ÉGALE au montant (voir plus bas).
 *
 * ---- LE PRIX (choix du propriétaire) ----
 * prix de l'outil + gaz du règlement, avec un MINIMUM de 0,02 $. Gaz relevé
 * le 26 septembre : ~0,028 gwei, soit ~0,008 à 0,012 $ par règlement ; la
 * quantité GAZ_UNITES est une borne haute ESTIMÉE — chaque règlement réel
 * note son `gasUsed` (MESURE) pour la remplacer par une mesure.
 *
 * ---- L'ORDRE, QUI PROTÈGE LES DEUX CÔTÉS ----
 * vérifier tout (signatures, montant EXACT d'un devis émis, destinataire,
 * délais, nonce, solde, allowance ou permit, simulation) → servir l'outil →
 * s'il a échoué, NE PAS régler (rien payé) → régler → si le règlement échoue,
 * le résultat n'est PAS rendu (402 + PAYMENT-RESPONSE en échec).
 * Les montants payés vont à `X402_PAYTO` (trésorerie du propriétaire) ; le
 * gaz est payé par le portefeuille `X402_CLE`, dédié, jamais celui du miroir.
 * Sans les deux, x402 est ÉTEINT.
 * ================================================================== */

const crypto = require('crypto');
const { ethers } = require('ethers');

const X402_VERSION = 2;
const CHAIN_ID = 4663;
const RESEAU = 'eip155:' + CHAIN_ID;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';
const DOMAINE_JETON = { name: 'Swole Doge', version: '1' };
const MIN_USD = 0.02;
const GAZ_UNITES = 200000;
const DELAI_S = 120;
const DEADLINE_MAX_S = 3600;

/* L'USDG (« Global Dollar », Paxos) sur Robinhood Chain : les agents
   détiennent des dollars, pas notre jeton. VÉRIFIÉ SUR LA CHAÎNE le 26
   septembre 2026 : nom « Global Dollar », symbole USDG, 6 décimales,
   693 651 206 d'offre ; DOMAIN_SEPARATOR recalculé (nom « Global Dollar »,
   version « 1 ») = lu ; c'est le jeton de la piscine WETH la plus profonde de
   la chaîne (19 M $) — le clone ne l'est pas. EIP-3009 (transferWithAuthorization
   v,r,s) simulé : signature valide d'un portefeuille vide → InsufficientFunds()
   (0x356680b7), signée par un autre → InvalidSignature() (0x8baa579f),
   expirée → AuthorizationExpired() (0x0f05f5bf). Pas de Permit2 ni de proxy :
   le jeton impose lui-même `to` et `value` signés. */
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const DOMAINE_USDG = { name: 'Global Dollar', version: '1' };
const DECIMALES_USDG = 6;
const TYPES_3009 = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };

const TYPES_PERMIT2 = {
  PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' }],
  TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  Witness: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }],
};
const TYPES_2612 = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const domainePermit2 = () => ({ name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const meme = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const adresseOk = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const entierOk = (x) => /^[0-9]{1,78}$/.test(String(x));

const SCHEMA_2612 = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: { from: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' }, asset: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
    spender: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' }, amount: { type: 'string', pattern: '^[0-9]+$' },
    nonce: { type: 'string', pattern: '^[0-9]+$' }, deadline: { type: 'string', pattern: '^[0-9]+$' },
    signature: { type: 'string', pattern: '^0x[a-fA-F0-9]+$' }, version: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)*$' } },
  required: ['from', 'asset', 'spender', 'amount', 'nonce', 'deadline', 'signature', 'version'] };

/**
 * deps = { asset ($SWOGE), usdg (adresse, ou null : pas d'USDG), payTo, chaine, cours() ($ par $SWOGE),
 *          ethUsd(), prixOutilUsd(outil), maintenant(), journal(ligne) }
 * chaine = { gazPrix() (wei), soldeGaz() (wei), porteGaz (adresse), solde(from), allowance(from),
 *            noncesJeton(from), nonceLibre(from, nonce), soldeUsdg(from), autorisationLibre(from, nonce),
 *            simule(methode, args), regle(methode, args) → { hash, ok, gasUsed } }
 */
function cree(deps) {
  const emis = new Map();          /* devis émis : outil|montant → expiration (ms) */
  const pris = new Map();          /* from|nonce déjà présentés → deadline (ms) : pas de rejeu ; oubliés une fois la deadline passée (la signature ne vaut plus rien) */
  const MESURE = { devis: 0, payes: 0, refuses: 0, echecsReglement: 0, gasUsed: [], gazParMethode: {} };
  let file = Promise.resolve();    /* un règlement à la fois : le portefeuille de gaz n'a qu'un nonce */
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());

  /**
   * Le prix x402 d'un outil : prix + gaz, au moins MIN_USD. En unités atomiques
   * de $SWOGE (`montant`, si le cours est connu) et d'USDG (`montantUsdg`, au
   * micro-dollar SUPÉRIEUR : jamais sous le prix). Sans ETH connu, pas de prix.
   */
  async function prix(outil) {
    const base = deps.prixOutilUsd(outil);
    if (!(base > 0)) return null;
    const [cours, eth, gp] = await Promise.all([Promise.resolve().then(() => deps.cours()).catch(() => null), deps.ethUsd(), deps.chaine.gazPrix()]);
    if (!(eth > 0)) return null;
    const gazUsd = Number(ethers.BigNumber.from(gp).mul(GAZ_UNITES)) / 1e18 * eth;
    const usd = Math.max(MIN_USD, base + gazUsd);
    const montant = cours > 0 ? ethers.utils.parseUnits((usd / cours).toFixed(18), 18).toString() : null;
    const montantUsdg = deps.usdg ? String(Math.ceil(Math.round(usd * 1e9) / 1e3)) : null;
    if (!montant && !montantUsdg) return null;
    return { usd: Number(montantUsdg ? (Number(montantUsdg) / 1e6).toFixed(6) : (Math.round(usd * 1e6) / 1e6)), gazUsd: Math.round(gazUsd * 1e6) / 1e6, montant, montantUsdg };
  }

  /** Le 402 : ce qu'il faut payer, et le devis retenu DELAI_S secondes. */
  async function exige(outil, url, raison) {
    const p = await prix(outil);
    if (!p) return null;
    for (const [k, v] of emis) if (v < maintenant()) emis.delete(k);
    const fin = maintenant() + DELAI_S * 1000;
    const accepts = [];
    /* L'USDG d'abord : la spec préfère eip3009, et c'est ce que les agents détiennent. */
    if (p.montantUsdg) {
      emis.set(outil + '|' + deps.usdg.toLowerCase() + '|' + p.montantUsdg, fin);
      accepts.push({ scheme: 'exact', network: RESEAU, amount: p.montantUsdg, asset: deps.usdg, payTo: deps.payTo, maxTimeoutSeconds: DELAI_S,
        extra: { assetTransferMethod: 'eip3009', name: DOMAINE_USDG.name, version: DOMAINE_USDG.version } });
    }
    if (p.montant) {
      emis.set(outil + '|' + deps.asset.toLowerCase() + '|' + p.montant, fin);
      accepts.push({ scheme: 'exact', network: RESEAU, amount: p.montant, asset: deps.asset, payTo: deps.payTo, maxTimeoutSeconds: DELAI_S,
        extra: { assetTransferMethod: 'permit2', name: DOMAINE_JETON.name, version: DOMAINE_JETON.version } });
    }
    MESURE.devis++;
    const en = [p.montantUsdg ? 'USDG' : null, p.montant ? '$SWOGE' : null].filter(Boolean).join(' or ');
    return { x402Version: X402_VERSION, error: raison || 'PAYMENT-SIGNATURE header is required',
      resource: { url, description: 'SwogeAgentic tool ' + outil + ' — $' + p.usd + ' in ' + en + ' (tool price + settlement gas, minimum $' + MIN_USD + ')', mimeType: 'application/json' },
      accepts,
      extensions: { eip2612GasSponsoring: { info: { description: 'The server accepts an EIP-2612 permit to the canonical Permit2 contract (value = the exact payment amount) and pays the gas.', version: '1' }, schema: SCHEMA_2612 } } };
  }

  /** Vérifie un PAYMENT-SIGNATURE pour cet outil. Rend { ok, methode, args, from, montant } ou { ok:false, raison }. */
  async function verifie(entete, outil) {
    const non = (raison, detail) => ({ ok: false, raison, detail });
    let p;
    try { p = JSON.parse(Buffer.from(String(entete || ''), 'base64').toString('utf8')); } catch (e) { return non('invalid_payload'); }
    if (!p || typeof p !== 'object') return non('invalid_payload');
    if (Number(p.x402Version) !== X402_VERSION) return non('invalid_x402_version');
    const acc = p.accepted || {}, pl = p.payload || {}, a = pl.permit2Authorization || {};
    if (acc.scheme !== 'exact') return non('unsupported_scheme');
    if (acc.network !== RESEAU) return non('invalid_network');
    const enUsdg = !!deps.usdg && meme(acc.asset, deps.usdg);
    if ((!enUsdg && !meme(acc.asset, deps.asset)) || !meme(acc.payTo, deps.payTo)) return non('invalid_payment_requirements');
    const echeance = emis.get(outil + '|' + String(acc.asset).toLowerCase() + '|' + String(acc.amount));
    if (!echeance || echeance < maintenant()) return non('invalid_payment_requirements', 'no current quote for this amount — request the resource again for a fresh 402');
    if (enUsdg) return verifie3009(acc, pl);
    if (!a.permitted || !meme(a.permitted.token, deps.asset)) return non('invalid_payload', 'permitted.token must be the $SWOGE asset');
    if (String(a.permitted.amount) !== String(acc.amount)) return non('invalid_exact_evm_payload_authorization_value_mismatch');
    if (!meme(a.spender, PROXY)) return non('invalid_payload', 'spender must be the canonical x402ExactPermit2Proxy');
    if (!a.witness || !meme(a.witness.to, deps.payTo)) return non('invalid_exact_evm_payload_recipient_mismatch');
    if (!adresseOk(a.from) || !entierOk(a.nonce) || !entierOk(a.deadline) || !entierOk(a.witness.validAfter)) return non('invalid_payload');
    const s = Math.floor(maintenant() / 1000);
    if (Number(a.deadline) <= s) return non('invalid_exact_evm_payload_authorization_valid_before');
    if (Number(a.deadline) > s + DEADLINE_MAX_S) return non('invalid_payload', 'deadline too far in the future');
    if (Number(a.witness.validAfter) > s) return non('invalid_exact_evm_payload_authorization_valid_after');
    let signataire = null;
    try {
      signataire = ethers.utils.verifyTypedData(domainePermit2(), TYPES_PERMIT2,
        { permitted: { token: a.permitted.token, amount: a.permitted.amount }, spender: a.spender, nonce: a.nonce, deadline: a.deadline,
          witness: { to: a.witness.to, validAfter: a.witness.validAfter } }, pl.signature);
    } catch (e) { signataire = null; }
    if (!meme(signataire, a.from)) return non('invalid_exact_evm_payload_signature');
    return prend('permit2|' + String(a.from).toLowerCase() + '|' + a.nonce, Number(a.deadline), () => suite(p, acc, pl, a, s));
  }

  /**
   * Le nonce est pris TOUT DE SUITE (avant la première lecture asynchrone) :
   * deux requêtes simultanées avec la même signature ne passent pas toutes les
   * deux. Rendu si la vérification échoue plus loin.
   */
  async function prend(cleNonce, finS, suiteFn) {
    if (pris.has(cleNonce)) return { ok: false, raison: 'invalid_payload', detail: 'this nonce was already presented' };
    for (const [k, v] of pris) if (v < maintenant()) pris.delete(k);
    pris.set(cleNonce, finS * 1000);
    const r = await suiteFn();
    if (!r.ok) pris.delete(cleNonce); else r.cleNonce = cleNonce;
    return r;
  }

  /** Le portefeuille de gaz peut-il payer ce règlement (deux fois la borne, par prudence) ? */
  async function gazOk() {
    const [gp, gaz] = await Promise.all([deps.chaine.gazPrix(), deps.chaine.soldeGaz()]);
    return !ethers.BigNumber.from(gaz).lt(ethers.BigNumber.from(gp).mul(GAZ_UNITES * 2));
  }

  /** La branche USDG : EIP-3009, le jeton impose lui-même `to` et `value` signés. */
  async function verifie3009(acc, pl) {
    const non = (raison, detail) => ({ ok: false, raison, detail });
    const a = pl.authorization || {};
    if (!meme(a.to, deps.payTo)) return non('invalid_exact_evm_payload_recipient_mismatch');
    if (String(a.value) !== String(acc.amount)) return non('invalid_exact_evm_payload_authorization_value_mismatch');
    if (!adresseOk(a.from) || !entierOk(a.validAfter) || !entierOk(a.validBefore) || !/^0x[0-9a-fA-F]{64}$/.test(String(a.nonce || ''))) return non('invalid_payload');
    const s = Math.floor(maintenant() / 1000);
    if (Number(a.validBefore) <= s) return non('invalid_exact_evm_payload_authorization_valid_before');
    if (Number(a.validBefore) > s + DEADLINE_MAX_S) return non('invalid_payload', 'validBefore too far in the future');
    if (Number(a.validAfter) > s) return non('invalid_exact_evm_payload_authorization_valid_after');
    const m = { from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce };
    let signataire = null;
    try { signataire = ethers.utils.verifyTypedData(Object.assign({ chainId: CHAIN_ID, verifyingContract: deps.usdg }, DOMAINE_USDG), TYPES_3009, m, pl.signature); }
    catch (e) { signataire = null; }
    if (!meme(signataire, a.from)) return non('invalid_exact_evm_payload_signature');
    return prend('usdg|' + String(a.from).toLowerCase() + '|' + String(a.nonce).toLowerCase(), Number(a.validBefore), async () => {
      const [solde, libre] = await Promise.all([deps.chaine.soldeUsdg(a.from), deps.chaine.autorisationLibre(a.from, a.nonce)]);
      if (ethers.BigNumber.from(solde).lt(ethers.BigNumber.from(acc.amount))) return non('insufficient_funds');
      if (!libre) return non('invalid_transaction_state', 'this EIP-3009 authorization was already used on-chain');
      if (!(await gazOk())) return non('unexpected_verify_error', 'the settlement gas wallet is empty — try again later');
      const sp = ethers.utils.splitSignature(pl.signature);
      const args = [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sp.v, sp.r, sp.s];
      try { await deps.chaine.simule('transferWithAuthorization', args); }
      catch (e) { return non('invalid_transaction_state', 'the settlement would revert: ' + String(e && (e.reason || e.errorName || e.message) || e).slice(0, 120)); }
      return { ok: true, methode: 'transferWithAuthorization', args, from: a.from, montant: String(acc.amount), asset: deps.usdg };
    });
  }

  async function suite(p, acc, pl, a, s) {
    const non = (raison, detail) => ({ ok: false, raison, detail });
    const montant = ethers.BigNumber.from(acc.amount);
    const [solde, allowance, libre] = await Promise.all([deps.chaine.solde(a.from), deps.chaine.allowance(a.from), deps.chaine.nonceLibre(a.from, a.nonce)]);
    if (ethers.BigNumber.from(solde).lt(montant)) return non('insufficient_funds');
    if (!libre) return non('invalid_transaction_state', 'Permit2 nonce already used on-chain');
    const permit = { permitted: { token: a.permitted.token, amount: a.permitted.amount }, nonce: a.nonce, deadline: a.deadline };
    const witness = { to: a.witness.to, validAfter: a.witness.validAfter };
    let methode = 'settle', args = [permit, a.from, witness, pl.signature];
    if (ethers.BigNumber.from(allowance).lt(montant)) {
      /* Pas encore d'allowance vers Permit2 : l'extension EIP-2612, signée par le payeur, la donne sans gaz. */
      const x = (((p.extensions || {}).eip2612GasSponsoring || {}).info) || null;
      if (!x || !x.signature) return non('permit2_allowance_required', 'approve Permit2 once, or include the eip2612GasSponsoring extension');
      if (!meme(x.from, a.from) || !meme(x.asset, deps.asset) || !meme(x.spender, PERMIT2) || !entierOk(x.amount) || !entierOk(x.nonce) || !entierOk(x.deadline)) return non('invalid_payload', 'eip2612GasSponsoring info does not match');
      /* Le proxy déployé EXIGE value == montant du paiement : relu sur la chaîne
         le 26 septembre 2026 (callStatic settleWithPermit, value = MaxUint256 →
         revert Permit2612AmountMismatch() 0x050cda49 ; value = montant →
         passe le permit, échoue au transfert faute de solde). */
      if (String(x.amount) !== String(acc.amount)) return non('invalid_payload', 'eip2612 permit value must equal the payment amount exactly');
      if (Number(x.deadline) <= s) return non('invalid_payload', 'eip2612 permit deadline has passed');
      if (String(await deps.chaine.noncesJeton(a.from)) !== String(x.nonce)) return non('invalid_payload', 'eip2612 nonce is not the current one');
      let s2612 = null;
      try {
        s2612 = ethers.utils.verifyTypedData(Object.assign({ chainId: CHAIN_ID, verifyingContract: deps.asset }, DOMAINE_JETON), TYPES_2612,
          { owner: x.from, spender: x.spender, value: x.amount, nonce: x.nonce, deadline: x.deadline }, x.signature);
      } catch (e) { s2612 = null; }
      if (!meme(s2612, a.from)) return non('invalid_payload', 'eip2612 signature does not recover to the payer');
      const sp = ethers.utils.splitSignature(x.signature);
      methode = 'settleWithPermit';
      args = [{ value: x.amount, deadline: x.deadline, r: sp.r, s: sp.s, v: sp.v }].concat(args);
    }
    if (!(await gazOk())) return non('unexpected_verify_error', 'the settlement gas wallet is empty — try again later');
    try { await deps.chaine.simule(methode, args); } catch (e) { return non('invalid_transaction_state', 'the settlement would revert: ' + String(e && (e.reason || e.errorName || e.message) || e).slice(0, 120)); }
    return { ok: true, methode, args, from: a.from, montant: String(acc.amount), asset: deps.asset };
  }

  /**
   * Un appel payé en x402 : vérifie, sert, règle. `sert()` rend le résultat de
   * l'outil ({ ok, ... }) ; rien n'est réglé s'il échoue.
   * Rend { status, entetes, corps }.
   */
  async function traite({ outil, url, entete, sert }) {
    const json = (status, corps, entetes) => ({ status, entetes: Object.assign({ 'content-type': 'application/json' }, entetes || {}), corps: JSON.stringify(corps) });
    if (!entete) {
      const e = await exige(outil, url);
      if (!e) return json(503, { ok: false, raison: 'x402 payment is unavailable right now (price or gas unknown)' });
      return json(402, Object.assign({ ok: false }, e), { 'payment-required': b64(e) });
    }
    const v = await verifie(entete, outil);
    if (!v.ok) {
      MESURE.refuses++;
      const e = await exige(outil, url, v.raison + (v.detail ? ': ' + v.detail : ''));
      return json(402, Object.assign({ ok: false }, e || {}, { raison: v.raison, detail: v.detail || null }), e ? { 'payment-required': b64(e) } : {});
    }
    let r;
    try { r = await sert(); } catch (e) { r = { ok: false, raison: 'the tool failed' }; }
    if (!r || !r.ok) {
      /* L'outil a échoué : on ne règle PAS — la signature n'est jamais soumise, le payeur ne paie rien. */
      pris.delete(v.cleNonce);
      return json(r && r.code === 400 ? 400 : 502, { ok: false, raison: (r && r.raison) || 'the tool failed — nothing was charged', paye: false });
    }
    const reglement = await (file = file.then(() => deps.chaine.regle(v.methode, v.args)).catch((e) => ({ ok: false, erreur: String(e && (e.reason || e.message) || e).slice(0, 160) })));
    const reponse = { success: !!reglement.ok, transaction: reglement.hash || '', network: RESEAU, payer: v.from };
    if (!reglement.ok) {
      MESURE.echecsReglement++;
      reponse.errorReason = 'unexpected_settle_error';
      return json(402, { ok: false, raison: 'the payment could not be settled — the result is withheld and nothing was charged', detail: reglement.erreur || null },
        { 'payment-response': b64(reponse) });
    }
    MESURE.payes++;
    if (reglement.gasUsed) {
      /* Le gaz réel, par méthode : settle, settleWithPermit et transferWithAuthorization ne coûtent pas pareil. */
      const g = Number(reglement.gasUsed), l = (MESURE.gazParMethode[v.methode] = MESURE.gazParMethode[v.methode] || []);
      MESURE.gasUsed.push(g); l.push(g);
      if (MESURE.gasUsed.length > 100) MESURE.gasUsed.shift();
      if (l.length > 100) l.shift();
    }
    if (deps.journal) deps.journal({ t: maintenant(), outil, payer: v.from, asset: v.asset, montant: v.montant, transaction: reglement.hash, methode: v.methode, gasUsed: reglement.gasUsed || null });
    return json(200, Object.assign({}, r, { x402: { transaction: reglement.hash, network: RESEAU, amount: v.montant, asset: v.asset } }), { 'payment-response': b64(reponse) });
  }

  return { prix, exige, verifie, traite, MESURE };
}

/** Le lien réel avec Robinhood Chain (ethers v5). La clé ne sort jamais d'ici. */
function chaineEthers({ rpc, cle, asset, usdg }) {
  const p = new ethers.providers.JsonRpcProvider(rpc, CHAIN_ID);
  const w = new ethers.Wallet(cle, p);
  const jeton = new ethers.Contract(asset, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function nonces(address) view returns (uint256)'], p);
  const p2 = new ethers.Contract(PERMIT2, ['function nonceBitmap(address,uint256) view returns (uint256)'], p);
  const proxy = new ethers.Contract(PROXY, [
    'function settle(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,address owner,(address to,uint256 validAfter) witness,bytes signature)',
    'function settleWithPermit((uint256 value,uint256 deadline,bytes32 r,bytes32 s,uint8 v) permit2612,((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,address owner,(address to,uint256 validAfter) witness,bytes signature)',
  ], w);
  /* L'USDG : transferWithAuthorization en v,r,s (la forme simulée sur la chaîne le 26 septembre 2026). */
  const usdgC = new ethers.Contract(usdg || USDG, ['function balanceOf(address) view returns (uint256)',
    'function authorizationState(address,bytes32) view returns (bool)',
    'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)'], w);
  /* ATTENTION, relevé le 26 septembre 2026 : `provider.call` brut d'ethers v5 rend
     les données d'un revert COMME UN RÉSULTAT (l'USDG renvoyait 0x356680b7 sans
     erreur). On ne simule donc que par `Contract.callStatic`, qui décode et lève. */
  const contrat = (methode) => (methode === 'transferWithAuthorization' ? usdgC : proxy);
  return {
    porteGaz: w.address,
    soldeUsdg: (a) => usdgC.balanceOf(a),
    autorisationLibre: async (a, nonce) => !(await usdgC.authorizationState(a, nonce)),
    gazPrix: () => p.getGasPrice(),
    soldeGaz: () => p.getBalance(w.address),
    solde: (a) => jeton.balanceOf(a),
    allowance: (a) => jeton.allowance(a, PERMIT2),
    noncesJeton: async (a) => (await jeton.nonces(a)).toString(),
    nonceLibre: async (a, nonce) => {
      const n = ethers.BigNumber.from(nonce);
      const mot = await p2.nonceBitmap(a, n.shr(8));
      return mot.and(ethers.BigNumber.from(1).shl(n.and(255).toNumber())).isZero();
    },
    simule: (methode, args) => contrat(methode).callStatic[methode](...args),
    regle: async (methode, args) => {
      const tx = await contrat(methode)[methode](...args, { gasLimit: 300000 });
      /* Une transaction envoyée peut être passée même si l'attente échoue (RPC
         coupé) : on relit son reçu avant de conclure — sinon le payeur
         paierait sans recevoir le résultat. Un revert, lui, n'a rien pris. */
      let rc = null;
      try { rc = await tx.wait(1); }
      catch (e) { rc = e && e.receipt ? e.receipt : await p.waitForTransaction(tx.hash, 1, 90000).catch(() => null); }
      if (!rc) return { ok: false, hash: tx.hash, erreur: 'settlement receipt not found in time' };
      return { ok: rc.status === 1, hash: tx.hash, gasUsed: rc.gasUsed && rc.gasUsed.toString() };
    },
  };
}

module.exports = { cree, chaineEthers, domainePermit2, TYPES_PERMIT2, TYPES_2612, DOMAINE_JETON, USDG, DOMAINE_USDG, DECIMALES_USDG, TYPES_3009,
  X402_VERSION, CHAIN_ID, RESEAU, PERMIT2, PROXY, MIN_USD, GAZ_UNITES, DELAI_S, b64 };
