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

/* ==================================================================
 * ---- UNE DEUXIÈME FAÇON DE PAYER : L'USDC SUR BASE, VÉRIFIÉ ET RÉGLÉ PAR COINBASE ----
 * Lot « Base » (tâche #29), contrat base_design/CONTRAT.md du 27 septembre 2026.
 * Allumé SEULEMENT avec une clé CDP valide (server.js : CDP_API_KEY_ID +
 * CDP_API_KEY_SECRET, et une sonde /supported qui liste Base) : sans elle,
 * tout est comme avant — les options Robinhood Chain, leurs clés de devis,
 * leur description, la file du portefeuille de gaz.
 *   - PRIX : max(0,02 $ ; prix de l'outil + 0,001 $), sans gaz ni cours
 *     (Coinbase paie le gaz ; 0,001 $ = son prix par règlement au-delà des
 *     1 000 gratuits du mois, DOCS x402/seller/facilitator, relu le 26
 *     septembre 2026 — on compte toujours le pire cas) ;
 *   - ORDRE : Base EN PREMIER quand il est allumé (Cloudflare juge son plafond
 *     sur accepts[0], mcpc prend la première entrée exacte et ne connaît que
 *     Base, le validateur de Coinbase ne met valid:true que d'après accepts[0]
 *     — contrat §A.3). Robinhood suit, inchangé ;
 *   - VÉRIFIER : d'abord ici (devis émis, destinataire, montant, délais,
 *     signature — décidée par le CODE du signataire, pas par sa longueur),
 *     puis Coinbase (verify est gratuit) avec NOS conditions, NOTRE ressource,
 *     NOTRE bloc bazaar — jamais ceux du client ;
 *   - RÉGLER : Coinbase, jamais dans la file du portefeuille de gaz Robinhood.
 *     « En attente » ou ambigu : on relit la CHAÎNE (reçu + journaux
 *     AuthorizationUsed et Transfer), jamais `authorizationState`, qui devient
 *     vrai aussi quand le payeur ANNULE son autorisation.
 * ================================================================== */

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

/* ---- BASE (contrat §A.1, toutes vérifiées le 26-27 septembre 2026) ----
   USDC sur Base : x402-foundation mechanisms/evm/src/defaultAssets.ts:43-48
   (commit 4fcf836c) ; lu sur la chaîne par https://mainnet.base.org (bloc
   51 834 757) : name() « USD Coin », version() « 2 », decimals() 6,
   DOMAIN_SEPARATOR 0x02fa7265… = celui qu'ethers calcule pour (« USD Coin »,
   « 2 », 8453, USDC). Avec le nom « USDC », 0xe824be45… : faux — extra.name
   DOIT être « USD Coin ». Base Sepolia (essais seulement) : name() « USDC »,
   version() « 2 » (lu par https://sepolia.base.org). */
const RESEAU_BASE = 'eip155:8453';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DOMAINE_USDC_BASE = { name: 'USD Coin', version: '2' };
const DECIMALES_USDC = 6;
const RESEAU_BASE_SEPOLIA = 'eip155:84532';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DOMAINE_USDC_BASE_SEPOLIA = { name: 'USDC', version: '2' };
/* 0,001 $ par règlement au-delà des 1 000 gratuits du mois ; la vérification
   est toujours gratuite ; un règlement en 4xx/5xx n'est pas facturé (DOCS
   x402/seller/facilitator et x402/support/faq, relus le 26 septembre 2026). On
   compte toujours le pire cas, comme GAZ_UNITES sur Robinhood. */
const FRAIS_CDP_USD = 0.001;
/* Les journaux de l'USDC (EIP-3009, circlefin/stablecoin-evm fc85788b,
   contracts/v2/EIP3009.sol : AuthorizationUsed émis :335-336,
   AuthorizationCanceled :266-267) — keccak256 des signatures, calculés avec
   ethers utils.id le 27 septembre 2026. */
const TOPIC_AUTH_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
const TOPIC_AUTH_CANCELED = '0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81';
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/* Le suffixe « magique » d'une signature emballée ERC-6492 (portefeuille
   intelligent PAS ENCORE déployé : aucun code à `from`, la signature porte
   l'usine et son appel). 32 octets 0x6492… — valeur de l'ERC-6492, la même
   dans x402-foundation mechanisms/evm/test/unit/exact/facilitator.test.ts:1050
   (ERC6492_MAGIC) ; le facilitateur de référence la lit par viem
   parseErc6492Signature (mechanisms/evm/src/shared/verifySignature.ts:37-50,
   exact/facilitator/eip3009.ts:42-51). Contrat §A.4 étape 2 : un emballage
   ERC-6492 → aucun refus ici, Coinbase décide (verify est gratuit). */
const MAGIE_6492 = '6492649264926492649264926492649264926492649264926492649264926492';
/* ask_agent (contrat §D.5) : 300 s d'échéance annoncée — le travail dure au
   plus AGENT_DUREE_MAX_S (150 s, studio_agent.LIMITES_X402) et il faut encore
   pouvoir régler après ; à la vérification, au moins 150 + 30 s de validité
   restante. Le facilitateur de référence exige 6 s au règlement
   (x402-foundation mechanisms/evm/src/exact/facilitator/eip3009.ts:219). */
const DELAI_AGENT_S = 300;
const MARGE_AGENT_S = 30;
/* resource.description : au plus 500 caractères (OAS `Description`
   maxLength 500 ; DOCS x402/seller/get-discovered : « the CDP Facilitator
   rejects verify and settle requests whose description exceeds that limit »). */
const DESCRIPTION_MAX = 500;
/* Trois refus « request_blocked_by_location » de suite : Base suspendue une
   heure (contrat §A.5 ; il vise probablement la région du serveur — NON VÉRIFIÉ).
   Une heure aussi après un 402 payment_method_required. Choix de départ, pas des mesures. */
const LIEUX_DE_SUITE_MAX = 3;
const PAUSE_BASE_MS = 3600 * 1000;
/* « En attente » (settlement_pending) : relire la chaîne jusqu'à 60 s (DOCS
   x402/seller/settlement-pending, étape 2), puis garder le résultat 10 minutes
   pour le même paiement représenté (contrat §A.5). La cadence de 3 s est un
   choix (≈ 1,5 bloc à 2 s, durée de bloc de Base NON VÉRIFIÉE ici). */
const ATTENTE_CHAINE_MS = 60000;
const CADENCE_CHAINE_MS = 3000;
const GARDE_ATTENTE_MS = 10 * 60 * 1000;
/* La recherche d'un règlement sans hash : ~100 blocs en arrière (≈ 200 s à 2 s
   le bloc, NON VÉRIFIÉ) — plus que le délai d'un règlement (90 s). */
const BLOCS_EN_ARRIERE = 100;

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
/* Réutilisé TEL QUEL pour l'USDC de Base : son TRANSFER_WITH_AUTHORIZATION_TYPEHASH
   lu sur la chaîne (0x7c7c6cdb…, bloc 51 839 944) = keccak de cette forme (recalculé le 27 septembre 2026). */
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
/* L'empreinte des arguments d'un appel : un devis vaut pour CES arguments. Sans
   elle, le devis d'une petite image (1, Speed) aurait payé une grosse (4, Quality). */
const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object'
  ? Object.keys(x).sort().reduce((o, k) => { o[k] = canon(x[k]); return o; }, {}) : x);
const empreinte = (a) => crypto.createHash('sha256').update(JSON.stringify(canon(a || {}))).digest('hex').slice(0, 20);
const meme = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const adresseOk = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const entierOk = (x) => /^[0-9]{1,78}$/.test(String(x));
/* ASCII imprimable seulement (0x20-0x7E) dans tout ce qu'un client recopie dans
   son paiement : le client MCP de Cloudflare encode par btoa(JSON.stringify(…))
   (cloudflare/agents packages/agents/src/mcp/client/x402.ts:454-488, commit
   dbf170cf), qui jette au-delà de U+00FF. Le « — » de l'ancienne description
   de scan_token (relevé en direct le 27 septembre 2026) l'aurait fait jeter. */
const REMPLACE = { '—': '-', '–': '-', '…': '...', '·': '-', '×': 'x', '’': "'", '‘': "'", '“': '"', '”': '"', '→': '->', '≤': '<=', '≥': '>=', ' ': ' ' };
const ascii = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, (c) => (REMPLACE[c] !== undefined ? REMPLACE[c] : c === '\n' || c === '\t' ? ' ' : ''));
/* Toutes les chaînes d'un objet, en ASCII (clés comprises). */
const asciiProfond = (x) => (Array.isArray(x) ? x.map(asciiProfond) : x && typeof x === 'object'
  ? Object.keys(x).reduce((o, k) => { o[ascii(k)] = asciiProfond(x[k]); return o; }, {}) : typeof x === 'string' ? ascii(x) : x);
/* Couper à une frontière de mot, SANS ajouter « … » (contrat §A.3). */
function coupeMots(s, max) {
  s = String(s);
  if (s.length <= max) return s;
  const c = s.slice(0, max);
  const i = c.lastIndexOf(' ');
  return (i > max * 0.5 ? c.slice(0, i) : c).replace(/[\s,;:]+$/, '');
}
const premierePhrase = (d) => { const t = String(d || '').trim(); const i = t.indexOf('. '); return i >= 0 ? t.slice(0, i + 1) : t; };
const usdTexte = (x) => String(Number(Number(x).toFixed(6)));
const pad32 = (a) => '0x' + '0'.repeat(24) + String(a).slice(2).toLowerCase();

const SCHEMA_2612 = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: { from: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' }, asset: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
    spender: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' }, amount: { type: 'string', pattern: '^[0-9]+$' },
    nonce: { type: 'string', pattern: '^[0-9]+$' }, deadline: { type: 'string', pattern: '^[0-9]+$' },
    signature: { type: 'string', pattern: '^0x[a-fA-F0-9]+$' }, version: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)*$' } },
  required: ['from', 'asset', 'spender', 'amount', 'nonce', 'deadline', 'signature', 'version'] };

/* Les codes des portefeuilles intelligents (DOCS x402/support/troubleshooting) : dits en clair. */
const MESSAGES_CDP = {
  invalid_exact_evm_payload_undeployed_smart_wallet: 'your smart wallet is not deployed on Base yet - deploy it, or pay from a regular wallet',
  smart_wallet_deployment_failed: 'your smart wallet could not be deployed - pay from a regular wallet',
  kyt_risk_detected: 'this payment was refused by screening',
  request_blocked_by_location: 'Base payments are blocked from here right now - pay on Robinhood Chain',
};

/**
 * deps = { asset ($SWOGE), usdg (adresse, ou null : pas d'USDG), payTo, chaine, cours() ($ par $SWOGE),
 *          ethUsd(), prixOutilUsd(outil), maintenant(), journal(ligne),
 *          note(evenement, info) — les compteurs durables (compteurs.js), optionnels,
 *          bazaar(outil) — l'extension `bazaar` du 402 (decouverte.bazaar), optionnelle,
 *          description(outil) — la description publique de l'outil (sa première phrase ouvre resource.description, Base allumé),
 *          service: { nom, etiquettes(outil), icone } — resource.serviceName/tags/iconUrl, Base allumé,
 *          base: { reseau, chainId, usdc, domaine, payTo, facilitateur (facilitateur_cdp), rpc (rpcBase),
 *                  attenteMs, cadenceMs } — optionnel : sans lui, AUCUNE option Base,
 *          agent: { dureeMaxS, enVolMax, bloque(addr), nonRegle(addr, coutUsd, raison) } — ask_agent, optionnel }
 * chaine = { gazPrix() (wei), soldeGaz() (wei), porteGaz (adresse), solde(from), allowance(from),
 *            noncesJeton(from), nonceLibre(from, nonce), soldeUsdg(from), autorisationLibre(from, nonce),
 *            simule(methode, args), regle(methode, args) → { hash, ok, gasUsed, gazPrix } }
 */
function cree(deps) {
  const emis = new Map();          /* devis émis : outil|empreinte|[réseau|]actif|montant → expiration (ms) */
  const prixEmis = new Map();      /* même clé → le prix en $ de ce devis (pour compter ce qui a été payé) */
  const ressourcesEmises = new Map();   /* clé d'un devis Base → la ressource annoncée (renvoyée à Coinbase, à l'adresse du canal) */
  const pris = new Map();          /* from|nonce déjà présentés → deadline (ms) : pas de rejeu ; oubliés une fois la deadline passée (la signature ne vaut plus rien) */
  const enAttente = new Map();     /* base|from|nonce → un résultat retenu pendant qu'un règlement est « en attente » (10 min) */
  const MESURE = { devis: 0, payes: 0, refuses: 0, echecsReglement: 0, gasUsed: [], gazParMethode: {}, parReseau: {},
    base: { etat: 'off', raison: deps.base ? 'not probed yet' : 'no CDP key', derniereSonde: null, jusqua: 0, lieuxDeSuite: 0,
      bazaar: { success: 0, processing: 0, rejected: 0, dernierRejet: null } } };
  let file = Promise.resolve();    /* un règlement à la fois : le portefeuille de gaz n'a qu'un nonce */
  let agentEnVol = 0;
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());
  /* Une transaction du portefeuille de gaz à la fois — règlements ET caisse
     (caisse.js) : un seul nonce. Une erreur ne bloque pas la suite de la file. */
  function enFile(fn) { const p = file.then(() => fn()); file = p.catch(() => {}); return p; }
  const par = (net) => (MESURE.parReseau[net] = MESURE.parReseau[net] || { devis: 0, payes: 0, refuses: 0, echecsReglement: 0, enAttente: 0, msVerify: [], msSettle: [] });
  const garde100 = (l, v) => { if (Number.isFinite(v)) { l.push(v); if (l.length > 100) l.shift(); } };
  const delaiDe = (outil) => (outil === 'ask_agent' ? DELAI_AGENT_S : DELAI_S);

  /* ---- L'ÉTAT DE BASE : 'on' seulement après une sonde /supported qui liste Base ---- */
  const B = deps.base || null;
  const baseActif = () => !!B && MESURE.base.etat === 'on';
  async function sondeBase() {
    if (!B) return false;
    if (MESURE.base.jusqua > maintenant()) return false;           /* en pause (carte, lieu) : on attend la fin */
    let r;
    try { r = await B.facilitateur.supported(); } catch (e) { r = { ok: false, erreur: 'reseau' }; }
    MESURE.base.derniereSonde = maintenant();
    const liste = r.ok && (r.kinds || []).some((k) => Number(k.x402Version) === 2 && k.scheme === 'exact' && k.network === B.reseau);
    const avant = MESURE.base.etat;
    if (liste) {
      Object.assign(MESURE.base, { etat: 'on', raison: null, jusqua: 0, lieuxDeSuite: 0 });
      if (avant !== 'on') console.log('[x402] Base on - USDC on ' + B.reseau + ' to ' + B.payTo + ', settled by the CDP facilitator');
    } else {
      Object.assign(MESURE.base, { etat: 'off', raison: r.ok ? 'CDP /supported does not list ' + B.reseau : 'CDP /supported answered ' + (r.statut || r.erreur || 'nothing') });
      console.warn('[x402] Base stays off - CDP /supported: ' + (r.ok ? 'no exact ' + B.reseau : 'HTTP ' + (r.statut || r.erreur || '?')) + ' (retry in 10 min)');
    }
    return baseActif();
  }
  function pauseBase(raison, ms) {
    Object.assign(MESURE.base, { etat: 'suspendu', raison, jusqua: maintenant() + (ms || 0) });
    const duree = !ms ? null : ms % 3600000 === 0 ? (ms / 3600000) + ' h' : Math.round(ms / 60000) + ' min';
    console.warn('[x402] CDP: ' + raison + ' - Base off' + (duree ? ' for ' + duree : ', re-checking the key'));
  }
  /* Ce que Coinbase dit d'une réponse (401, 402, 403 lieu) : suspendre Base. */
  function pauseSelon(p) {
    if (p === 'cle') { pauseBase('key refused (401)', 0); sondeBase().catch(() => {}); }
    else if (p === 'carte') pauseBase('payment method required', PAUSE_BASE_MS);
    else if (p === 'lieu') {
      MESURE.base.lieuxDeSuite++;
      if (MESURE.base.lieuxDeSuite >= LIEUX_DE_SUITE_MAX) pauseBase('request_blocked_by_location ' + LIEUX_DE_SUITE_MAX + ' times in a row', PAUSE_BASE_MS);
    }
  }
  /* EXTENSION-RESPONSES (verify ET settle) : compté, la raison d'un refus journalisée, JAMAIS rendu à l'acheteur. */
  function compteBazaar(ext) {
    const z = ext && ext.bazaar;
    if (!z || !z.status) return;
    const s = MESURE.base.bazaar;
    if (s[z.status] !== undefined) s[z.status]++;
    if (z.status === 'rejected') { s.dernierRejet = String(z.rejectedReason || '').slice(0, 200); console.warn('[x402] CDP bazaar rejected our listing: ' + s.dernierRejet); }
  }

  /**
   * Le prix x402 d'un outil, par façon de payer — chacune à part : une panne du
   * RPC de Robinhood Chain ne coupe plus Base (avant : Promise.all jetait, la
   * route rendait 503). Robinhood : prix + gaz, au moins MIN_USD, en unités
   * atomiques de $SWOGE (`montant`, si le cours est connu) et d'USDG
   * (`montantUsdg`, au micro-dollar SUPÉRIEUR). Base : max(MIN_USD, prix +
   * FRAIS_CDP_USD), en unités d'USDC (`montantBase`), seulement Base allumée.
   * null : AUCUNE façon de payer n'a de prix.
   */
  async function prix(outil, args) {
    const base = deps.prixOutilUsd(outil, args);
    if (!(base > 0)) return null;
    const sur = (fn) => Promise.resolve().then(fn).catch(() => null);
    const [cours, eth, gp] = await Promise.all([sur(() => deps.cours()), sur(() => deps.ethUsd()), sur(() => deps.chaine.gazPrix())]);
    let usd = null, gazUsd = null, montant = null, montantUsdg = null;
    if (eth > 0 && gp !== null && gp !== undefined) {
      const g = Number(ethers.BigNumber.from(gp).mul(GAZ_UNITES)) / 1e18 * eth;
      const u = Math.max(MIN_USD, base + g);
      montant = cours > 0 ? ethers.utils.parseUnits((u / cours).toFixed(18), 18).toString() : null;
      montantUsdg = deps.usdg ? String(Math.ceil(Math.round(u * 1e9) / 1e3)) : null;
      if (montant || montantUsdg) {
        usd = Number(montantUsdg ? (Number(montantUsdg) / 1e6).toFixed(6) : (Math.round(u * 1e6) / 1e6));
        gazUsd = Math.round(g * 1e6) / 1e6;
      }
    }
    let usdBase = null, montantBase = null;
    if (baseActif()) {
      const ub = Math.max(MIN_USD, base + FRAIS_CDP_USD);
      montantBase = String(Math.ceil(Math.round(ub * 1e9) / 1e3));
      usdBase = Number((Number(montantBase) / 1e6).toFixed(6));
    }
    if (usd === null && montantBase === null) return null;
    return { usd, gazUsd, montant, montantUsdg, usdBase, montantBase };
  }

  /* La ressource annoncée. Base éteinte : la description d'AVANT, mot pour mot. Base
     allumée : la première phrase de l'outil puis le prix, ASCII, ≤ 500 caractères, et
     les détails de service (bazaar.md « Service Metadata on `resource` », 360-418). */
  function ressource(outil, url, p) {
    const reseaux = [p.montantUsdg ? 'USDG' : null, p.montant ? '$SWOGE' : null].filter(Boolean).join(' or ');
    if (!p.montantBase) {
      return { url, description: 'SwogeAgentic tool ' + outil + ' — $' + p.usd + ' in ' + reseaux + ' (tool price + settlement gas, minimum $' + MIN_USD + ')', mimeType: 'application/json' };
    }
    let desc = '';
    try { desc = deps.description ? deps.description(outil) : ''; } catch (e) { desc = ''; }
    const tete = ascii(premierePhrase(desc)) || 'SwogeAgentic tool ' + outil + '.';
    const prixTxt = ' Price: $' + usdTexte(p.usdBase) + ' in USDC on Base' + (p.usd !== null && reseaux ? ', or $' + usdTexte(p.usd) + ' in ' + reseaux + ' on Robinhood Chain' : '')
      + ' (tool price + settlement cost, minimum $' + MIN_USD + ').';
    const t = tete.length + prixTxt.length > DESCRIPTION_MAX ? coupeMots(tete, DESCRIPTION_MAX - prixTxt.length) + prixTxt : tete + prixTxt;
    const r = { url, description: coupeMots(ascii(t), DESCRIPTION_MAX), mimeType: 'application/json' };
    const S = deps.service || {};
    if (S.nom) r.serviceName = ascii(S.nom).slice(0, 64);
    const tags = S.etiquettes ? (S.etiquettes(outil) || []).map((x) => ascii(x)).filter((x) => x && x.length <= 32).slice(0, 5) : [];
    if (tags.length) r.tags = tags;
    if (S.icone) r.iconUrl = ascii(S.icone);
    return r;
  }

  /**
   * Le 402 : ce qu'il faut payer, et le devis retenu le temps de l'échéance de
   * CHAQUE option (120 s ; 300 s pour ask_agent — sinon un devis annoncé 300 s
   * disparaissait à 120 s). `opts.devis` : les mêmes exigences rendues par un
   * DEVIS gratuit (agentic.js) — payables telles quelles, mais pas comptées
   * comme un 402 émis. `opts.bazaar` : le bloc bazaar d'un autre canal (MCP).
   */
  async function exige(outil, url, raison, args, opts) {
    const p = await prix(outil, args);
    const cleDevis = outil + '|' + empreinte(args);
    if (!p) return null;
    for (const [k, v] of emis) if (v < maintenant()) { emis.delete(k); prixEmis.delete(k); ressourcesEmises.delete(k); }
    const delaiS = delaiDe(outil);
    const fin = maintenant() + delaiS * 1000;
    const accepts = [];
    const res = ressource(outil, url, p);
    /* Base d'abord, quand elle est allumée (contrat §A.3). Pas d'assetTransferMethod :
       le serveur de référence n'en met pas pour l'USDC de Base (base.md §1). */
    if (p.montantBase) {
      const k = cleDevis + '|' + B.reseau + '|' + B.usdc.toLowerCase() + '|' + p.montantBase;
      emis.set(k, fin); prixEmis.set(k, p.usdBase); ressourcesEmises.set(k, res);
      accepts.push({ scheme: 'exact', network: B.reseau, amount: p.montantBase, asset: B.usdc, payTo: B.payTo, maxTimeoutSeconds: delaiS,
        extra: { name: B.domaine.name, version: B.domaine.version } });
    }
    /* Robinhood : l'USDG d'abord (la spec préfère eip3009, et c'est ce que les agents détiennent). */
    if (p.montantUsdg) {
      emis.set(cleDevis + '|' + deps.usdg.toLowerCase() + '|' + p.montantUsdg, fin);
      prixEmis.set(cleDevis + '|' + deps.usdg.toLowerCase() + '|' + p.montantUsdg, p.usd);
      accepts.push({ scheme: 'exact', network: RESEAU, amount: p.montantUsdg, asset: deps.usdg, payTo: deps.payTo, maxTimeoutSeconds: delaiS,
        extra: { assetTransferMethod: 'eip3009', name: DOMAINE_USDG.name, version: DOMAINE_USDG.version } });
    }
    if (p.montant) {
      emis.set(cleDevis + '|' + deps.asset.toLowerCase() + '|' + p.montant, fin);
      prixEmis.set(cleDevis + '|' + deps.asset.toLowerCase() + '|' + p.montant, p.usd);
      accepts.push({ scheme: 'exact', network: RESEAU, amount: p.montant, asset: deps.asset, payTo: deps.payTo, maxTimeoutSeconds: delaiS,
        extra: { assetTransferMethod: 'permit2', name: DOMAINE_JETON.name, version: DOMAINE_JETON.version } });
    }
    if (!(opts && opts.devis)) {
      MESURE.devis++;
      for (const net of new Set(accepts.map((a) => a.network))) par(net).devis++;
    }
    /* L'extension `bazaar` (schémas d'entrée et de sortie, exemple fixe) : ce que
       lisent les annuaires x402 (@agentcash/discovery, x402scan, les
       facilitateurs). Audit AgentCash du 26 septembre 2026 : 16 erreurs
       « Input/Output schema is missing », 2 par outil payable, toutes à
       `extensions.bazaar` ; essai local avec l'extension : 0. Jamais bloquante :
       un 402 sans elle reste payable. */
    let bz = null;
    if (opts && opts.bazaar !== undefined) bz = opts.bazaar || null;
    else if (deps.bazaar) { try { bz = deps.bazaar(outil) || null; } catch (e) { bz = null; } }
    const e = { x402Version: X402_VERSION, error: raison || 'PAYMENT-SIGNATURE header is required',
      resource: res,
      accepts,
      extensions: Object.assign({ eip2612GasSponsoring: { info: { description: 'The server accepts an EIP-2612 permit to the canonical Permit2 contract (value = the exact payment amount) and pays the gas.', version: '1' }, schema: SCHEMA_2612 } },
        bz ? { bazaar: bz } : {}) };
    /* Base allumée : `error` aussi en ASCII (il voyage dans le paiement recopié). */
    if (p.montantBase) e.error = ascii(e.error);
    return e;
  }

  /** Décode un paiement : un objet (MCP _meta), ou le base64 d'un PAYMENT-SIGNATURE. */
  function lisPaiement(paiement) {
    if (paiement && typeof paiement === 'object') return paiement;
    try { return JSON.parse(Buffer.from(String(paiement || ''), 'base64').toString('utf8')); } catch (e) { return null; }
  }

  /* ask_agent : payeur bloqué 24 h, et assez de validité pour régler APRÈS le travail (contrat §D.5-D.6). */
  function agentRefus(outil, from, finS, s) {
    if (outil !== 'ask_agent' || !deps.agent) return null;
    if (deps.agent.bloque && deps.agent.bloque(from)) return { ok: false, raison: 'payer_blocked', detail: 'ask_agent over x402 is paused for this address for 24 h - use an API key' };
    const min = (deps.agent.dureeMaxS || 150) + MARGE_AGENT_S;
    if (Number(finS) - s < min) return { ok: false, raison: 'invalid_exact_evm_payload_authorization_valid_before', detail: 'sign with validBefore at least ' + min + ' s ahead' };
    return null;
  }

  /** Vérifie un paiement pour cet outil. Rend { ok, methode, args, from, montant, reseau } ou { ok:false, raison }. */
  async function verifie(paiement, outil, args, ctx) {
    const non = (raison, detail) => ({ ok: false, raison, detail });
    const p = lisPaiement(paiement);
    if (!p || typeof p !== 'object') return non('invalid_payload');
    if (Number(p.x402Version) !== X402_VERSION) return non('invalid_x402_version');
    const acc = p.accepted || {}, pl = p.payload || {}, a = pl.permit2Authorization || {};
    if (acc.scheme !== 'exact') return non('unsupported_scheme');
    if (B && acc.network === B.reseau) return verifieBase(p, acc, outil, args, ctx || {});
    if (acc.network !== RESEAU) return non('invalid_network');
    const enUsdg = !!deps.usdg && meme(acc.asset, deps.usdg);
    if ((!enUsdg && !meme(acc.asset, deps.asset)) || !meme(acc.payTo, deps.payTo)) return non('invalid_payment_requirements');
    const echeance = emis.get(outil + '|' + empreinte(args) + '|' + String(acc.asset).toLowerCase() + '|' + String(acc.amount));
    if (!echeance || echeance < maintenant()) return non('invalid_payment_requirements', 'no current quote for this amount and these arguments — request the resource again (same arguments) for a fresh 402');
    if (enUsdg) return verifie3009(acc, pl, outil);
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
    const ag = agentRefus(outil, a.from, a.deadline, s);
    if (ag) return ag;
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
  async function verifie3009(acc, pl, outil) {
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
    const ag = agentRefus(outil, a.from, a.validBefore, s);
    if (ag) return ag;
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
   * La branche Base (contrat §A.4). Dans l'ordre : un paiement déjà « en
   * attente » → la réconciliation (PAS de verify : Coinbase dirait
   * invalid_payload pour un nonce déjà servi) ; nos exigences et notre devis ;
   * l'autorisation signée, vérifiée ICI (la signature décidée par le code du
   * signataire) ; le nonce pris ; puis verify chez Coinbase avec NOS conditions.
   * Jamais gazOk(), deps.chaine ni simule : ils parlent à Robinhood Chain.
   */
  async function verifieBase(p, acc, outil, args, ctx) {
    const non = (raison, detail) => ({ ok: false, raison, detail, reseau: B.reseau });
    const pl = p.payload || {}, a = pl.authorization || {};
    const cleN = 'base|' + String(a.from || '').toLowerCase() + '|' + String(a.nonce || '').toLowerCase();
    /* Une attente de plus de 10 min sans issue : oubliée — et pour ask_agent, comptée comme
       servie sans être encaissée (le registre des pertes doit rester du bon côté). */
    for (const [k, v] of enAttente) if (v.fin < maintenant()) { enAttente.delete(k); nonRegle(v.outil, v.from, v.resultat, 'pending expired'); }
    if (adresseOk(a.from) && enAttente.has(cleN)) {
      /* « Retry with the SAME signature » (contrat §A.5 étape 5) : `from` et `nonce`
         sont publics dès que Coinbase diffuse la transaction (données d'appel, puis
         le journal AuthorizationUsed) — les seuls ne désignent donc PAS le payeur.
         La réconciliation n'est ouverte qu'au paiement IDENTIQUE (même signature,
         même autorisation champ par champ) pour le MÊME outil et les MÊMES
         arguments ; la signature elle-même est lisible sur la chaîne, ce sont
         l'outil et les arguments (jamais publiés) qui lient la reprise à la
         demande d'origine. Tout autre : refusé, l'attente intacte. */
      if (memeQueRetenu(enAttente.get(cleN), pl, outil, args)) return { ok: true, reconcilie: true, cleN, reseau: B.reseau };
      return non('invalid_payload', 'this nonce was already presented');
    }
    if (!baseActif()) return non('invalid_network', 'Base payments are paused right now - pay on Robinhood Chain or try again later');
    if (!meme(acc.asset, B.usdc) || !meme(acc.payTo, B.payTo)) return non('invalid_payment_requirements');
    const k = outil + '|' + empreinte(args) + '|' + B.reseau + '|' + B.usdc.toLowerCase() + '|' + String(acc.amount);
    const echeance = emis.get(k);
    if (!echeance || echeance < maintenant()) return non('invalid_payment_requirements', 'no current quote for this amount and these arguments - request the resource again (same arguments) for a fresh 402');
    if (!meme(a.to, B.payTo)) return non('invalid_exact_evm_payload_recipient_mismatch');
    if (String(a.value) !== String(acc.amount)) return non('invalid_exact_evm_payload_authorization_value_mismatch');
    if (!adresseOk(a.from) || !entierOk(a.validAfter) || !entierOk(a.validBefore) || !/^0x[0-9a-fA-F]{64}$/.test(String(a.nonce || ''))) return non('invalid_payload');
    const s = Math.floor(maintenant() / 1000);
    if (Number(a.validBefore) <= s) return non('invalid_exact_evm_payload_authorization_valid_before');
    if (Number(a.validBefore) > s + DEADLINE_MAX_S) return non('invalid_payload', 'validBefore too far in the future');
    if (Number(a.validAfter) > s) return non('invalid_exact_evm_payload_authorization_valid_after');
    /* La signature : l'USDC vérifie par ecrecover quand le signataire n'a PAS de
       code, par EIP-1271 sinon, quelle que soit la longueur (circlefin
       contracts/util/SignatureChecker.sol:38-47). Un Safe à un seul
       propriétaire signe 65 octets qui retrouvent le propriétaire, pas le Safe ;
       un compte EIP-7702 a du code aussi. Donc : 65 octets qui retrouvent
       `from` → bon ; sinon on lit le code de `from` (lecture seule) — pas de
       code → refus ici ; du code, un emballage ERC-6492 ou un RPC muet →
       Coinbase décide (verify est gratuit). */
    const m = { from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce };
    const sig = String(pl.signature || '');
    let retrouve = null;
    if (/^0x[0-9a-fA-F]{130}$/.test(sig)) {
      try { retrouve = ethers.utils.verifyTypedData(Object.assign({ chainId: B.chainId, verifyingContract: B.usdc }, B.domaine), TYPES_3009, m, sig); }
      catch (e) { retrouve = null; }
    }
    if (!meme(retrouve, a.from)) {
      if (!/^0x[0-9a-fA-F]+$/.test(sig)) return non('invalid_exact_evm_payload_signature');
      /* Un emballage ERC-6492 : le portefeuille n'a pas ENCORE de code, par définition —
         ne pas lire eth_getCode ici, Coinbase décide (et dit undeployed_smart_wallet au besoin). */
      if (!sig.toLowerCase().endsWith(MAGIE_6492)) {
        let code;
        try { code = await B.rpc.code(a.from); } catch (e) { code = undefined; }
        if (typeof code === 'string' && /^0x0*$/.test(code)) return non('invalid_exact_evm_payload_signature');
      }
    }
    const ag = agentRefus(outil, a.from, a.validBefore, s);
    if (ag) return Object.assign(ag, { reseau: B.reseau });
    return prend(cleN, Number(a.validBefore), async () => {
      /* Les conditions REFAITES avec nos valeurs, jamais celles du client ; le
         paiement envoyé à Coinbase garde `payload` tel quel (la signature ne
         couvre que les paramètres de transferWithAuthorization et le domaine du
         jeton : x402-foundation specs/schemes/exact/scheme_exact_evm.md:17,
         :23-30, :72-73) et prend NOTRE ressource (à l'adresse de ce canal) et
         NOTRE bloc bazaar — toute autre extension est retirée. */
      const exigence = { scheme: 'exact', network: B.reseau, asset: B.usdc, amount: String(acc.amount), payTo: B.payTo, maxTimeoutSeconds: delaiDe(outil),
        extra: { name: B.domaine.name, version: B.domaine.version } };
      let bz = null;
      if (ctx.bazaar !== undefined) bz = ctx.bazaar || null;
      else if (deps.bazaar) { try { bz = deps.bazaar(outil) || null; } catch (e) { bz = null; } }
      const res = Object.assign({}, ressourcesEmises.get(k) || { description: 'SwogeAgentic tool ' + outil, mimeType: 'application/json' }, { url: ctx.url || (ressourcesEmises.get(k) || {}).url });
      const paiementCdp = Object.assign({}, p, { accepted: exigence, resource: res, extensions: bz ? { bazaar: bz } : {} });
      const r = await B.facilitateur.verify(paiementCdp, exigence);
      garde100(par(B.reseau).msVerify, r.ms);
      compteBazaar(r.extension);
      const indispo = 'payment check unavailable - try again or pay on Robinhood Chain';
      if (r.etat === 'valide') {
        MESURE.base.lieuxDeSuite = 0;
        return { ok: true, methode: 'facilitateur', reseau: B.reseau, args: { paiement: paiementCdp, exigence }, from: a.from, montant: String(acc.amount), asset: B.usdc,
          nonce: String(a.nonce), validBefore: Number(a.validBefore) };
      }
      if (r.etat === 'refuse') { MESURE.base.lieuxDeSuite = 0; return non(r.raison || 'invalid_payload', MESSAGES_CDP[r.raison] || (r.message ? ascii(r.message).slice(0, 200) : undefined)); }
      if (r.etat === 'kyt') return non('kyt_risk_detected', MESSAGES_CDP.kyt_risk_detected);
      if (r.etat === 'lieu') { pauseSelon('lieu'); return non('request_blocked_by_location', MESSAGES_CDP.request_blocked_by_location); }
      if (r.etat === 'cle' || r.etat === 'carte') { pauseSelon(r.etat); return non('unexpected_verify_error', indispo); }
      if (r.etat === 'interdit') return non(r.raison || 'unexpected_verify_error', r.message ? ascii(r.message).slice(0, 200) : indispo);
      return non('unexpected_verify_error', indispo);
    });
  }

  /**
   * LA RELECTURE DE LA CHAÎNE (Base), jamais `authorizationState` : il devient
   * vrai aussi quand le payeur appelle cancelAuthorization (USDC
   * contracts/v2/EIP3009.sol:48, :64-69, :252-268 ; présent sur l'implémentation
   * de Base 0x2ce6311d…, sceptique2/cancel_probe_2026-09-27.out). Payé = un reçu
   * status 1 portant, de l'adresse de l'USDC, AuthorizationUsed(from, nonce) ET
   * Transfer(from → payTo, montant). Rend { etat: 'paye'|'echec'|'annule'|'inconnu', hash }.
   */
  async function lisChaine(e) {
    const R = B.rpc, usdc = B.usdc.toLowerCase();
    const t = (l, i) => String(((l && l.topics) || [])[i] || '').toLowerCase();
    const deUsdc = (l) => String(l.address || '').toLowerCase() === usdc;
    const utilise = (l) => deUsdc(l) && t(l, 0) === TOPIC_AUTH_USED && t(l, 1) === pad32(e.from) && t(l, 2) === String(e.nonce).toLowerCase();
    const transfert = (l) => { try { return deUsdc(l) && t(l, 0) === TOPIC_TRANSFER && t(l, 1) === pad32(e.from) && t(l, 2) === pad32(B.payTo) && ethers.BigNumber.from(l.data).eq(e.montant); } catch (x) { return false; } };
    const recu = async (h) => {
      const rc = await R.recu(h);
      if (!rc) return 'inconnu';                                   /* un reçu absent n'est pas un échec (DOCS settlement-pending, étape 2) */
      if (Number(rc.status) !== 1) return 'revert';
      const logs = rc.logs || [];
      return logs.some(utilise) && logs.some(transfert) ? 'paye' : 'autre';
    };
    try {
      if (e.hash) {
        const x = await recu(e.hash);
        if (x === 'paye') return { etat: 'paye', hash: e.hash };
        if (x === 'revert') return { etat: 'echec', hash: e.hash };
      }
      const bloc = await R.bloc();
      if (e.depuisBloc === undefined || e.depuisBloc === null) e.depuisBloc = Math.max(0, bloc - BLOCS_EN_ARRIERE);
      const vus = await R.journaux({ address: B.usdc, topics: [TOPIC_AUTH_USED, pad32(e.from), String(e.nonce).toLowerCase()], fromBlock: e.depuisBloc });
      const l = (vus || []).find(utilise);
      if (l) {
        const x = await recu(l.transactionHash);
        if (x === 'paye') return { etat: 'paye', hash: l.transactionHash };
        if (x === 'inconnu') return { etat: 'inconnu', hash: l.transactionHash };
        return { etat: 'echec', hash: l.transactionHash };
      }
      const annules = await R.journaux({ address: B.usdc, topics: [TOPIC_AUTH_CANCELED, pad32(e.from), String(e.nonce).toLowerCase()], fromBlock: e.depuisBloc });
      if ((annules || []).some((x) => deUsdc(x) && t(x, 0) === TOPIC_AUTH_CANCELED)) return { etat: 'annule', hash: '' };
      /* validBefore passé sans AuthorizationUsed : l'autorisation ne peut plus servir. */
      if (e.validBefore && Math.floor(maintenant() / 1000) > Number(e.validBefore)) return { etat: 'echec', hash: '' };
      return { etat: 'inconnu', hash: e.hash || '' };
    } catch (x) { return { etat: 'inconnu', hash: e.hash || '' }; }
  }
  /* Relire la chaîne jusqu'à `attenteMs` (60 s ; plus court dans les essais). */
  async function attendsChaine(e) {
    const fin = Date.now() + (B.attenteMs !== undefined ? B.attenteMs : ATTENTE_CHAINE_MS);
    for (;;) {
      const x = await lisChaine(e);
      if (x.etat !== 'inconnu' || Date.now() >= fin) return x;
      await new Promise((r) => setTimeout(r, Math.min(B.cadenceMs || CADENCE_CHAINE_MS, Math.max(1, fin - Date.now()))));
    }
  }

  /* Ce qui retire les champs internes (`_coutUsd`…) d'un résultat avant de le rendre. */
  const propre = (r) => { const o = {}; for (const k of Object.keys(r || {})) if (k[0] !== '_') o[k] = r[k]; return o; };
  /* ask_agent servi mais pas encaissé : au registre des pertes (et payeur bloqué 24 h). */
  const nonRegle = (outil, from, r, raison) => {
    if (outil === 'ask_agent' && deps.agent && deps.agent.nonRegle) { try { deps.agent.nonRegle(from, Number(r && r._coutUsd) || 0, raison); } catch (e) { /* jamais bloquant */ } }
  };

  /**
   * LE CŒUR, INDÉPENDANT DU TRANSPORT (HTTP ou MCP) : vérifie, sert, règle.
   * `paiement` : un objet (MCP), le base64 d'un PAYMENT-SIGNATURE, ou null.
   * `sert(payeur)` rend le résultat de l'outil ({ ok, ... }) ; rien n'est réglé s'il échoue.
   * Rend { etape: 'exige'|'refuse'|'indisponible'|'occupe'|'outil'|'reglement'|'attente'|'paye', … }.
   */
  async function paie({ outil, url, paiement, args, sert, canal, qui, sonde, bazaar }) {
    /* Les compteurs durables (compteurs.js) : 402 émis, payé, échec — `qui` est
       l'empreinte d'IP avant paiement, l'adresse VÉRIFIÉE du payeur après. */
    const note = (ev, info) => { if (deps.note) { try { deps.note(ev, Object.assign({ outil, canal: canal || 'rest' }, info)); } catch (e) { /* jamais bloquant */ } } };
    const opts = bazaar !== undefined ? { bazaar } : undefined;
    if (!paiement) {
      const e = await exige(outil, url, null, args, opts);
      if (!e) return { etape: 'indisponible' };
      note('demande402', { qui, sorte: sonde ? 'sonde' : 'demande' });
      return { etape: 'exige', exige: e };
    }
    /* ask_agent : au plus X402_AGENT_EN_VOL exécutions à la fois — la suivante avant toute vérification. */
    const agent = outil === 'ask_agent' && deps.agent;
    if (agent) {
      if (agentEnVol >= Math.max(1, deps.agent.enVolMax || 3)) return { etape: 'occupe' };
      agentEnVol++;
    }
    try { return await paieSuite({ outil, url, paiement, args, sert, qui, note, opts, ctx: { url, bazaar } }); }
    finally { if (agent) agentEnVol--; }
  }

  async function paieSuite({ outil, url, paiement, args, sert, qui, note, opts, ctx }) {
    const v = await verifie(paiement, outil, args, ctx);
    if (v.reconcilie) return reconcilie(v, outil, url, args, opts, note);
    if (!v.ok) {
      MESURE.refuses++;
      par(v.reseau || RESEAU).refuses++;
      note('echec', { qui, sorte: 'paiement_refuse:' + v.raison });
      const e = await exige(outil, url, v.raison + (v.detail ? ': ' + v.detail : ''), args, opts);
      return { etape: 'refuse', exige: e, raison: v.raison, detail: v.detail };
    }
    let r;
    try { r = await sert(v.from); } catch (e) { r = { ok: false, raison: 'the tool failed' }; }
    if (!r || !r.ok) {
      /* L'outil a échoué : on ne règle PAS — la signature n'est jamais soumise, le payeur ne paie rien. */
      pris.delete(v.cleNonce);
      note('echec', { qui: v.from, sorte: 'outil' });
      return { etape: 'outil', code: r && r.code === 400 ? 400 : 502, raison: (r && r.raison) || 'the tool failed — nothing was charged' };
    }
    if (v.methode === 'facilitateur') return regleBase(v, r, outil, url, args, opts, note);
    const reglement = await enFile(() => deps.chaine.regle(v.methode, v.args)).catch((e) => ({ ok: false, erreur: String(e && (e.reason || e.message) || e).slice(0, 160) }));
    const reponse = { success: !!reglement.ok, transaction: reglement.hash || '', network: RESEAU, payer: v.from };
    if (!reglement.ok) {
      MESURE.echecsReglement++;
      par(RESEAU).echecsReglement++;
      note('echec', { qui: v.from, sorte: 'reglement' });
      nonRegle(outil, v.from, r, 'settlement failed');
      reponse.errorReason = 'unexpected_settle_error';
      return { etape: 'reglement', reponse, raison: 'the payment could not be settled — the result is withheld and nothing was charged', detail: reglement.erreur || null, exige: null };
    }
    MESURE.payes++;
    par(RESEAU).payes++;
    if (reglement.gasUsed) {
      /* Le gaz réel, par méthode : settle, settleWithPermit et transferWithAuthorization ne coûtent pas pareil. */
      const g = Number(reglement.gasUsed), l = (MESURE.gazParMethode[v.methode] = MESURE.gazParMethode[v.methode] || []);
      MESURE.gasUsed.push(g); l.push(g);
      if (MESURE.gasUsed.length > 100) MESURE.gasUsed.shift();
      if (l.length > 100) l.shift();
    }
    if (deps.journal) deps.journal({ t: maintenant(), outil, payer: v.from, asset: v.asset, montant: v.montant, transaction: reglement.hash, methode: v.methode, gasUsed: reglement.gasUsed || null, gazPrix: reglement.gazPrix || null, network: RESEAU });
    /* Ce qui a été payé, en $ : exact en USDG (6 décimales), le prix du devis en $SWOGE.
       Ce que ça nous a coûté : le gaz réel du règlement (gasUsed × prix payé × ETH). */
    const cleP = outil + '|' + empreinte(args) + '|' + String(v.asset).toLowerCase() + '|' + v.montant;
    const usd = deps.usdg && meme(v.asset, deps.usdg) ? Number(v.montant) / 1e6 : (prixEmis.has(cleP) ? prixEmis.get(cleP) : null);
    let coutUsd = null;
    if (reglement.gasUsed && reglement.gazPrix) {
      const eth = await Promise.resolve().then(() => deps.ethUsd()).catch(() => null);
      if (eth > 0) coutUsd = Number(ethers.BigNumber.from(reglement.gasUsed).mul(ethers.BigNumber.from(reglement.gazPrix))) / 1e18 * eth;
    }
    note('paye_x402', { qui: v.from, usd, coutUsd, sorte: meme(v.asset, deps.usdg) ? 'USDG' : 'SWOGE', tx: reglement.hash, reseau: RESEAU });
    return { etape: 'paye', resultat: r, reponse, recu: { transaction: reglement.hash, network: RESEAU, amount: v.montant, asset: v.asset } };
  }

  /* Un paiement Base encaissé : compté, journalisé, rendu. */
  function livreBase(v, r, hash, outil, note) {
    MESURE.payes++;
    par(B.reseau).payes++;
    if (deps.journal) deps.journal({ t: maintenant(), outil, payer: v.from, asset: v.asset, montant: v.montant, transaction: hash, methode: 'facilitateur', network: B.reseau });
    note('paye_x402', { qui: v.from, usd: Number(v.montant) / 1e6, coutUsd: FRAIS_CDP_USD, sorte: 'USDC_BASE', tx: hash, reseau: B.reseau });
    return { etape: 'paye', resultat: r, reponse: { success: true, transaction: hash, network: B.reseau, payer: v.from },
      recu: { transaction: hash, network: B.reseau, amount: v.montant, asset: v.asset } };
  }
  /* Un échec DÉFINITIF d'encaissement Base : le résultat est retenu, un nouveau 402. */
  async function echecBase(v, r, erreur, outil, url, args, opts, note) {
    MESURE.echecsReglement++;
    par(B.reseau).echecsReglement++;
    note('echec', { qui: v.from, sorte: 'reglement' });
    nonRegle(outil, v.from, r, erreur);
    const e = await exige(outil, url, 'Settlement failed: ' + erreur, args, opts);
    return { etape: 'reglement', reponse: { success: false, errorReason: erreur, transaction: '', network: B.reseau, payer: v.from },
      raison: 'the payment could not be settled - the result is withheld and nothing was charged', detail: erreur, exige: e };
  }
  /* Une autorisation EIP-3009 ramenée à des chaînes comparables (adresses et nonce en minuscules). */
  function autorisationNormee(a) {
    a = a || {};
    return ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'].map((k) => String(a[k] === undefined || a[k] === null ? '' : a[k]).toLowerCase()).join('|');
  }
  /* Le paiement représenté est-il EXACTEMENT celui qu'on a retenu, pour le même appel ? */
  function memeQueRetenu(g, pl, outil, args) {
    if (!g || !g.sig) return false;
    return String((pl && pl.signature) || '').toLowerCase() === g.sig
      && autorisationNormee(pl && pl.authorization) === g.auth
      && outil === g.outil
      && empreinte(args) === g.empreinte;
  }

  /* L'issue inconnue : le résultat gardé 10 min sous base|from|nonce, AUCUNE nouvelle demande de paiement. */
  function retiensBase(v, r, hash, depuisBloc, outil, args) {
    const cleN = 'base|' + String(v.from).toLowerCase() + '|' + String(v.nonce).toLowerCase();
    /* L'identité du paiement retenu, figée MAINTENANT : la signature et l'autorisation
       telles que reçues, l'outil, l'empreinte des arguments (voir memeQueRetenu). */
    const pl0 = (v.args && v.args.paiement && v.args.paiement.payload) || {};
    enAttente.set(cleN, { v, resultat: r, hash: hash || '', depuisBloc, fin: maintenant() + GARDE_ATTENTE_MS, outil, args, from: v.from, nonce: v.nonce, montant: v.montant, validBefore: v.validBefore,
      sig: String(pl0.signature || '').toLowerCase(), auth: autorisationNormee(pl0.authorization), empreinte: empreinte(args) });
    par(B.reseau).enAttente++;
    return { etape: 'attente', reponse: { success: false, errorReason: hash ? 'settlement_pending' : 'unexpected_settle_error', transaction: hash || '', network: B.reseau, payer: v.from } };
  }

  /* Encaisser sur Base : Coinbase, JAMAIS dans enFile — cette file sert le nonce
     unique du portefeuille de gaz Robinhood, partagé avec la caisse. */
  async function regleBase(v, r, outil, url, args, opts, note) {
    const x = await B.facilitateur.regle(v.args.paiement, v.args.exigence);
    garde100(par(B.reseau).msSettle, x.ms);
    for (const ext of x.extensions || [x.extension]) compteBazaar(ext);
    if (x.pause) pauseSelon(x.pause);
    else if (x.etat !== 'inconnu') MESURE.base.lieuxDeSuite = 0;
    if (x.etat === 'paye') return livreBase(v, r, x.hash, outil, note);
    if (x.etat === 'echec') {
      return echecBase(v, r, x.erreur || 'unexpected_settle_error', outil, url, args, opts, note);
    }
    /* 'attente' (hash connu), 'ambigu' ou 'inconnu' (délai, réseau, 5xx : pas de hash,
       JAMAIS de rejeu) : on relit la chaîne avant de conclure. */
    const e = { from: v.from, nonce: v.nonce, montant: v.montant, validBefore: v.validBefore, hash: x.hash || '' };
    const c = await attendsChaine(e);
    if (c.etat === 'paye') return livreBase(v, r, c.hash, outil, note);
    if (c.etat === 'echec' || c.etat === 'annule') return echecBase(v, r, c.etat === 'annule' ? 'authorization_canceled' : (x.erreur || 'unexpected_settle_error'), outil, url, args, opts, note);
    return retiensBase(v, r, c.hash || x.hash, e.depuisBloc, outil, args);
  }

  /* Le MÊME paiement représenté pendant l'attente : la chaîne décide, sans nouveau verify ni règlement. */
  async function reconcilie(v, outil, url, args, opts, note) {
    const g = enAttente.get(v.cleN);
    const c = await lisChaine(g);
    if (c.etat === 'paye') { enAttente.delete(v.cleN); return livreBase(g.v, g.resultat, c.hash, g.outil, note); }
    if (c.etat === 'echec' || c.etat === 'annule') {
      /* Échec définitif (revert, annulée, ou expirée sans AuthorizationUsed) : le résultat
         retenu est jeté ; SEULEMENT maintenant on peut demander un nouveau paiement. */
      enAttente.delete(v.cleN);
      MESURE.echecsReglement++;
      par(B.reseau).echecsReglement++;
      note('echec', { qui: g.from, sorte: 'reglement' });
      nonRegle(g.outil, g.from, g.resultat, c.etat === 'annule' ? 'authorization canceled' : 'settlement failed');
      const raison = c.etat === 'annule' ? 'authorization_canceled' : 'invalid_transaction_state';
      const e = await exige(outil, url, raison + ': the earlier payment did not settle - sign a new one', args, opts);
      return { etape: 'refuse', exige: e, raison, detail: 'the earlier payment did not settle - sign a new one' };
    }
    return { etape: 'attente', reponse: { success: false, errorReason: g.hash ? 'settlement_pending' : 'unexpected_settle_error', transaction: g.hash || '', network: B.reseau, payer: g.from } };
  }

  /**
   * Un appel payé en x402 sur HTTP : l'enveloppe de `paie`. Rend { status, entetes, corps } —
   * octet pour octet ce qu'attend x402_route.test.js pour Robinhood Chain.
   */
  async function traite({ outil, url, entete, sert, args, canal, qui, sonde }) {
    const json = (status, corps, entetes) => ({ status, entetes: Object.assign({ 'content-type': 'application/json' }, entetes || {}), corps: JSON.stringify(corps) });
    const r = await paie({ outil, url, paiement: entete || null, args, sert, canal, qui, sonde });
    switch (r.etape) {
      case 'exige': return json(402, Object.assign({ ok: false }, r.exige), { 'payment-required': b64(r.exige) });
      case 'indisponible': return json(503, { ok: false, raison: 'x402 payment is unavailable right now (price or gas unknown)' });
      case 'occupe': return json(503, { ok: false, raison: 'ask_agent is busy - try again in a minute' });
      case 'refuse': return json(402, Object.assign({ ok: false }, r.exige || {}, { raison: r.raison, detail: r.detail || null }), r.exige ? { 'payment-required': b64(r.exige) } : {});
      case 'outil': return json(r.code, { ok: false, raison: r.raison, paye: false });
      case 'reglement': return json(402, Object.assign({ ok: false }, r.exige || {}, { raison: r.raison, detail: r.detail || null }),
        Object.assign({ 'payment-response': b64(r.reponse) }, r.exige ? { 'payment-required': b64(r.exige) } : {}));
      /* Issue inconnue : 402, PAYMENT-RESPONSE en attente, SANS PAYMENT-REQUIRED ni accepts —
         « Do not ask the buyer to authorize another payment while its outcome is unknown » (DOCS). */
      case 'attente': return json(402, { ok: false, error: 'payment pending - retry the same request with the same PAYMENT-SIGNATURE' }, { 'payment-response': b64(r.reponse) });
      default: return json(200, Object.assign({}, propre(r.resultat), { x402: r.recu }), { 'payment-response': b64(r.reponse) });
    }
  }

  return { prix, exige, verifie, paie, traite, MESURE, enFile, sondeBase, baseActif, pauseBase, propre };
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
    /* La preuve de propriété, quand la caisse EST ce portefeuille (caisse.js) : signer l'origine. */
    signe: (message) => w.signMessage(message),
    wallet: w,
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
      /* Le prix du gaz LU, +20 %, en transaction classique (règle du miroir, miroir.js
         fraisGaz) : sans lui, ethers ajoute 1,5 gwei de pourboire sur une chaîne
         relevée à ~0,028 gwei le 26 septembre 2026 — jusqu'à cinquante fois le prix. */
      const tx = await contrat(methode)[methode](...args, { gasLimit: 300000, gasPrice: (await p.getGasPrice()).mul(12).div(10) });
      /* Une transaction envoyée peut être passée même si l'attente échoue (RPC
         coupé) : on relit son reçu avant de conclure — sinon le payeur
         paierait sans recevoir le résultat. Un revert, lui, n'a rien pris. */
      let rc = null;
      try { rc = await tx.wait(1); }
      catch (e) { rc = e && e.receipt ? e.receipt : await p.waitForTransaction(tx.hash, 1, 90000).catch(() => null); }
      if (!rc) return { ok: false, hash: tx.hash, erreur: 'settlement receipt not found in time' };
      const gp = rc.effectiveGasPrice || tx.gasPrice;
      return { ok: rc.status === 1, hash: tx.hash, gasUsed: rc.gasUsed && rc.gasUsed.toString(), gazPrix: gp ? gp.toString() : null };
    },
  };
}

/**
 * Le RPC de Base, en LECTURE seule (JSON-RPC par fetch) : le code d'un signataire
 * (portefeuille intelligent ?), un reçu, des journaux, le dernier bloc. Aucune
 * clé ici : rien ne s'envoie sur Base depuis ce serveur.
 */
function rpcBase(url, f) {
  let id = 0;
  const appel = async (method, params) => {
    const r = await (f || fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.error) throw new Error('Base RPC ' + method + ': ' + String(j.error.message || j.error.code).slice(0, 120));
    return j.result;
  };
  return {
    code: (a) => appel('eth_getCode', [a, 'latest']),
    recu: (h) => appel('eth_getTransactionReceipt', [h]),
    journaux: (x) => appel('eth_getLogs', [{ address: x.address, topics: x.topics, fromBlock: '0x' + Number(x.fromBlock || 0).toString(16), toBlock: 'latest' }]),
    bloc: async () => parseInt(await appel('eth_blockNumber', []), 16),
  };
}

module.exports = { cree, chaineEthers, rpcBase, domainePermit2, TYPES_PERMIT2, TYPES_2612, DOMAINE_JETON, USDG, DOMAINE_USDG, DECIMALES_USDG, TYPES_3009,
  X402_VERSION, CHAIN_ID, RESEAU, PERMIT2, PROXY, MIN_USD, GAZ_UNITES, DELAI_S, DELAI_AGENT_S, MARGE_AGENT_S, DEADLINE_MAX_S, b64, empreinte, ascii, asciiProfond,
  RESEAU_BASE, USDC_BASE, DOMAINE_USDC_BASE, DECIMALES_USDC, RESEAU_BASE_SEPOLIA, USDC_BASE_SEPOLIA, DOMAINE_USDC_BASE_SEPOLIA, FRAIS_CDP_USD,
  TOPIC_AUTH_USED, TOPIC_AUTH_CANCELED, TOPIC_TRANSFER, DESCRIPTION_MAX, PAUSE_BASE_MS, LIEUX_DE_SUITE_MAX };
