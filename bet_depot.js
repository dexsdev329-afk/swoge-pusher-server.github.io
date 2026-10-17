'use strict';
/* ==================================================================
 * DEPOSER AUX PARIS EN SOL, USDT OU ETH, SANS PORTEFEUILLE CONNECTE (17 octobre 2026)
 * ==================================================================
 *
 * Demande du proprietaire : que les joueurs de SwogeBet deposent « aussi facilement que le
 * credit du Studio » — choisir SOL / USDT / ETH, recevoir une adresse a usage unique, envoyer
 * depuis n'importe quel portefeuille ou plateforme d'echange, et retrouver des $SWOGEBET dans
 * son solde de paris (p.betBalance). La maison garde 5 % de chaque depot. La monnaie RESTE le
 * $SWOGEBET (le proprietaire a refuse un solde en dollars) ; le retrait reste le bon $SWOGEBET
 * automatique, inchange.
 *
 * Le chemin est celui de credit_depot.js, destination changee :
 *   1. la page demande une adresse (POST /bet/deposit) ;
 *   2. le serveur la demande a Relay en mode STRICT, destinataire = LE COFFRE DES PARIS
 *      (BET_VAULT_ADDRESS), destination = $SWOGEBET sur Robinhood Chain (4663) ;
 *   3. la commande est ECRITE sur le disque (fsync, renommage) AVANT la reponse ;
 *   4. Relay convertit et livre les $SWOGEBET au coffre par un simple transfert ERC-20 : ils
 *      sont dans le pot (totalPot = balanceOf du coffre) sans evenement Deposit — c'est la
 *      commande, par son adresse de depot, qui dit a qui ils sont ;
 *   5. le suivi relit /requests/v3?depositAddress=… puis LE RECU sur Robinhood Chain, et
 *      credite 95 % des jetons ARRIVES (journal Transfer), une fois (cle relay:<tx>:<index>),
 *      a la session qui a cree la commande, par game.creditBetDeposit (seenTx, journal, etat).
 *
 * ---- CE QUI A ETE MESURE AVANT D'ECRIRE (17/10/2026, /quote/v2 public de Relay) ----
 *   vers $SWOGEBET (0xc0ae…8bea, chaine 4663 ; decimals() lu sur la chaine = 18, symbol = Swogebet) :
 *     0,1 SOL (10,37 $)        → 406 266 jetons   (impact 13,8 %)
 *     20 USDT Solana (19,97 $) → 782 915 jetons   (impact 13,9 %)
 *     0,008 ETH Ethereum (19,32 $) → 758 868      (impact 14,2 %)
 *     0,008 ETH Base (19,32 $)     → 759 171      (impact 14,2 %)
 *     20 USDT Base (19,97 $)       → 779 268      (impact 13,4 %)
 *   avec adresse de depot STRICTE (sans cle : Ethereum et Base seulement — Solana rend
 *   « missing an api key », la cle RELAY_API_KEY du serveur est donc indispensable) :
 *     20 USDT Base → 779 111 ; 0,008 ETH Ethereum → 756 985 ; 0,008 ETH Base → 759 034 ;
 *     a 5 $ : 5 USDT Base → 193 998 (38 850 par $ contre 39 010 a 20 $),
 *             0,002 ETH Ethereum (4,83 $) → 187 771 (38 886 par $ contre 39 183) :
 *     le balayage coute ~1 % de plus a 5 $ qu'a 20 $ — d'ou le minimum de 5 $ partout.
 *   L'impact est de 13 a 14 % A 5 $ COMME A 20 $ : ce n'est pas la profondeur qui le fait, c'est
 *   l'ecart entre le prix de la piscine et la valeur en dollars que Relay donne au jeton. Dans
 *   tous les cas on CREDITE CE QUI ARRIVE, jamais une cotation ni une conversion en dollars.
 *   USDC/USDT sur Solana, Base et Ethereum : ajoutes le meme jour a la demande du proprietaire,
 *   cotes vers $SWOGEBET (chiffres dans EXPLOITATION.md) ; minimum 10 $ depuis Ethereum (gaz L1).
 *
 * ---- LES REGLES D'ARGENT (celles de credit_depot.js, plus le frais) ----
 *   • rien de ce qu'envoie le client ne choisit une adresse, un requestId ou un destinataire :
 *     la provenance vient d'une LISTE FERMEE, tout le reste est fixe ici ;
 *   • on ne credite que ce que NOTRE lecture du recu montre : statut 1, journal Transfer du
 *     $SWOGEBET vers le coffre, au moins CONFIRMATIONS blocs ; la base est le montant du journal ;
 *   • le frais est FIGE A LA COMMANDE (c.fraisBps) : le joueur a vu « 5 % » ; un reglage change
 *     entre-temps ne s'applique pas a ses jetons ;
 *   • joueur = floor(arrive × (10 000 − frais) / 10 000) ; le reste (arrondi compris) est le
 *     frais : il reste dans le coffre comme surplus de la maison, compte dans fraisWei ;
 *   • l'intention (cle → commande) est ecrite AVANT le credit : un arret entre le credit et
 *     l'ecriture de la commande se rattrape sans double credit (seenTx de l'etat du jeu) ;
 *   • remboursement ou echec : rien n'est credite, la commande le dit ; la cle ne sort jamais.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RH = 4663;
const BASE = 8453;
const SOLANA = 792703809;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';   /* le cours du SOL et de l'ETH */
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NATIF_EVM = '0x0000000000000000000000000000000000000000';
const NATIF_SOL = '11111111111111111111111111111111';
/* decimals() du $SWOGEBET, LU sur la chaine le 17/10 (0x…12) ; le jeu compte en cfg.DECIMALS = 18.
   Le serveur refuse d'allumer le module si les deux divergent (server.js). */
const DECIMALES_JETON = 18;
const MICRO = 1e6;

/* Les provenances, LISTE FERMEE. Chaque ligne a rendu une vraie cotation vers $SWOGEBET le 17/10
   (chiffres dans l'en-tete). `repere` : l'adresse native de la chaine (relay.js : `user` est juge
   contre la chaine de DEPART), aussi `refundTo` (remboursement a l'envoyeur). */
/* `minUsd` : 5 $ (le balayage coute ~1 % de plus qu'a 20 $, mesure ci-dessus) ; 10 $ depuis le
   reseau principal d'Ethereum, dont le balayage paie le gaz de L1 — la borne de credit_depot.js
   pour USDT Ethereum (2,5 % a 10 $ le 14/10), demandee pareille ici par le proprietaire (17/10).
   USDC et USDT (Solana, Base, Ethereum) ajoutes le 17/10 a la demande du proprietaire, cotes le
   meme jour (chiffres dans EXPLOITATION.md). */
const ORIGINES = {
  sol:       { chaine: SOLANA, jeton: NATIF_SOL, repere: NATIF_SOL, decimales: 9, symbole: 'SOL', reseau: 'Solana', minUsd: 5 },
  usdc_sol:  { chaine: SOLANA, jeton: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', repere: NATIF_SOL, decimales: 6, symbole: 'USDC', reseau: 'Solana', stable: true, minUsd: 5 },
  usdt_sol:  { chaine: SOLANA, jeton: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', repere: NATIF_SOL, decimales: 6, symbole: 'USDT', reseau: 'Solana', stable: true, minUsd: 5 },
  usdc_base: { chaine: BASE, jeton: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', repere: NATIF_EVM, decimales: 6, symbole: 'USDC', reseau: 'Base', stable: true, minUsd: 5 },
  usdt_base: { chaine: BASE, jeton: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', repere: NATIF_EVM, decimales: 6, symbole: 'USDT', reseau: 'Base', stable: true, minUsd: 5 },
  eth_base:  { chaine: BASE, jeton: NATIF_EVM, repere: NATIF_EVM, decimales: 18, symbole: 'ETH', reseau: 'Base', minUsd: 5 },
  eth:       { chaine: 1, jeton: NATIF_EVM, repere: NATIF_EVM, decimales: 18, symbole: 'ETH', reseau: 'Ethereum', minUsd: 10 },
  usdc_eth:  { chaine: 1, jeton: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', repere: NATIF_EVM, decimales: 6, symbole: 'USDC', reseau: 'Ethereum', stable: true, minUsd: 10 },
  usdt_eth:  { chaine: 1, jeton: '0xdAC17F958D2ee523a2206206994597C13D831ec7', repere: NATIF_EVM, decimales: 6, symbole: 'USDT', reseau: 'Ethereum', stable: true, minUsd: 10 },
};
/* 50 $ : « depot max 50 $ » (proprietaire, 17/10). MIN_USD : le plus petit minimum de la liste. */
const MIN_USD = 5;
const MAX_USD = 50;
const OUVERTES_PAR_SESSION = 3;
const COMMANDES_PAR_HEURE = 6;
const OUVERTES_MAX = 200;
const TOUR_MS = 2000;
const LECTURES_PAR_TOUR = 3;
/* Robinhood Chain est un rollup Arbitrum (un bloc ~0,25 s) : 2 confirmations, comme Base dans
   credit_depot.js, c'est moins d'une seconde d'attente. */
const CONFIRMATIONS = 2;
const ENVOI_CONSEILLE_MS = 30 * 60 * 1000;
const H = 3600 * 1000;
const JOURS_MAX = 7;
const PANNE_ECHECS = 3;
const PANNE_FENETRE_MS = 5 * 60 * 1000;
/* Le frais de depot : 500 points de base (5 %, proprietaire, 17/10), borne a 0..1000. */
const FRAIS_DEFAUT_BPS = 500;
const FRAIS_MAX_BPS = 1000;

const FINIS = new Set(['credite', 'rembourse', 'echec', 'expire', 'a_verifier']);
const STATUT_PUBLIC = { attente: 'waiting', recu: 'processing', credite: 'credited', rembourse: 'refunded', echec: 'failed', expire: 'expired', a_verifier: 'review' };

const minuscule = (a) => String(a || '').toLowerCase();
const memeAdresse = (a, b) => /^0x/i.test(String(a || '')) ? minuscule(a) === minuscule(b) : String(a || '') === String(b || '');
const pad32 = (a) => '0x' + '0'.repeat(24) + minuscule(a).slice(2);

function enTexte(unites, decimales) {
  const s = String(unites).padStart(decimales + 1, '0');
  const e = s.slice(0, s.length - decimales), d = s.slice(s.length - decimales).replace(/0+$/, '');
  return d ? e + '.' + d : e;
}

/**
 * Le frais en points de base, lu d'un texte d'environnement. Vide → 500. Un entier de 0 a 1000 →
 * lui. Tout le reste (« 5% », « 1500 », « abc ») → null : AUCUNE nouvelle commande, plutot que de
 * deviner l'intention du proprietaire ; les commandes ouvertes gardent le frais fige a leur creation.
 */
function lisFrais(brut) {
  const s = String(brut == null ? '' : brut).trim();
  if (s === '') return FRAIS_DEFAUT_BPS;
  if (!/^[0-9]{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= FRAIS_MAX_BPS ? n : null;
}

/** La part du joueur et le frais, en wei (BigInt), du montant ARRIVE. */
function partage(arriveWei, bps) {
  const a = BigInt(arriveWei);
  const net = a * BigInt(10000 - bps) / 10000n;
  return { net, frais: a - net };
}

/**
 * deps : { dossier, vault (adresse du coffre des paris, getAddress), jeton (cfg.SWOGEBET_TOKEN),
 *          rpc ({ recu(h), bloc() } sur Robinhood Chain), api (URL de Relay), cle (RELAY_API_KEY),
 *          fraisBps (lisFrais ; null = pas de nouvelle commande),
 *          credite({ player, amountWei (texte), tx }) → true | false (game.creditBetDeposit + persist),
 *          dejaVu(cle) → bool (game.seenTx), estMaison(addr) → bool, solde?(addr) → texte,
 *          fetch?, maintenant?, cadenceMs?, tourMs?, log? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const f = deps.fetch || fetch;
  const fichier = deps.dossier ? path.join(deps.dossier, 'bet_depots.json') : null;
  const log = deps.log || ((t) => console.log(t));
  const vault = deps.vault ? String(deps.vault) : null;
  const jeton = deps.jeton ? String(deps.jeton) : null;
  const cleRelay = String(deps.cle || '');
  const fraisBps = deps.fraisBps === undefined ? FRAIS_DEFAUT_BPS : deps.fraisBps;
  const MESURE = { commandes: 0, refus: 0, lectures: 0, echecsRelay: 0, credites: 0, rembourses: 0, echecs: 0, aVerifier: 0, expires: 0, reprises: 0 };
  const panne = { echecs: 0, derniere: 0 };
  const propre = (t) => { let s = String(t == null ? '' : t).slice(0, 200); if (cleRelay) s = s.split(cleRelay).join('***'); return s; };

  /* commandes ; cles : relay:<tx>:<index> → id de commande (l'intention, ecrite avant le credit) ;
     arriveWei / creditWei / fraisWei : les cumuls, en texte (BigInt). */
  let C = { commandes: {}, cles: {}, arriveWei: '0', creditWei: '0', fraisWei: '0' };
  if (fichier) {
    try { C = Object.assign(C, JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}); }
    catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.renameSync(fichier, fichier + '.illisible-' + maintenant()); } catch (x) {}
        console.error('[betdepot] bet_depots.json unreadable - set aside, orders must be checked by hand');
      }
    }
  }
  C.cles = C.cles || {};
  function ecrit() {
    if (!fichier) return true;
    try {
      fs.mkdirSync(deps.dossier, { recursive: true });
      const tmp = fichier + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify(C)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, fichier);
      return true;
    } catch (e) { console.error('[betdepot] write failed: ' + (e && e.code || e)); return false; }
  }

  const adresseOk = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
  /* actif = le suivi peut tourner (les commandes ouvertes sont creditees). `ouvert` = on peut en
     prendre de nouvelles : il faut EN PLUS un frais lisible. */
  const actif = () => !!(cleRelay && adresseOk(vault) && adresseOk(jeton) && deps.rpc && typeof deps.credite === 'function' && typeof deps.dejaVu === 'function');
  const ouvert = () => actif() && Number.isInteger(fraisBps) && fraisBps >= 0 && fraisBps <= FRAIS_MAX_BPS;
  const enPanne = () => panne.echecs >= PANNE_ECHECS && maintenant() - panne.derniere < PANNE_FENETRE_MS;
  const relayOk = () => { panne.echecs = 0; };
  const relayKo = () => { panne.echecs++; panne.derniere = maintenant(); MESURE.echecsRelay++; };

  async function appelle(chemin, corps) {
    const r = await f(deps.api + chemin, corps ? {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': cleRelay }, body: JSON.stringify(corps), signal: AbortSignal.timeout(15000),
    } : { headers: { 'x-api-key': cleRelay }, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* rien */ }
    if (!r.ok) { const e = new Error(propre((j && (j.message || j.error)) || t.slice(0, 160))); e.statut = r.status; throw e; }
    if (!j || typeof j !== 'object') { const e = new Error('unreadable answer'); e.statut = 502; throw e; }
    return j;
  }
  const corpsCotation = (o, montant) => ({
    useDepositAddress: true, strict: true,
    user: o.repere, recipient: vault, refundTo: o.repere,
    originChainId: o.chaine, originCurrency: o.jeton,
    destinationChainId: RH, destinationCurrency: jeton,
    amount: String(montant), tradeType: 'EXACT_INPUT',
  });

  /* Le cours d'une monnaie native (SOL, ETH de sa chaine) en micro-USDC par unite entiere : une
     cotation SANS adresse de depot vers l'USDC de Base (piscines profondes — jamais le $SWOGEBET,
     dont la piscine mince ne dit pas le prix du SOL). Garde 60 s par chaine. */
  const cours = {};
  async function microParUnite(o) {
    const k = o.chaine + ':' + o.jeton;
    const c = cours[k];
    if (c && maintenant() - c.t < 60000) return c.v;
    const j = await appelle('/quote/v2', {
      user: o.repere, recipient: vault, refundTo: o.repere, originChainId: o.chaine, originCurrency: o.jeton,
      destinationChainId: BASE, destinationCurrency: USDC_BASE, amount: (10n ** BigInt(o.decimales)).toString(), tradeType: 'EXACT_INPUT',
    });
    const out = j && j.details && j.details.currencyOut;
    const v = out && /^[0-9]+$/.test(String(out.amount)) ? BigInt(out.amount) : 0n;
    if (v <= 0n) { const e = new Error('no price'); e.statut = 502; throw e; }
    cours[k] = { v, t: maintenant() };
    return v;
  }

  const commandesDe = (k) => Object.values(C.commandes).filter((c) => c.addr === k);
  const ouverte = (c) => !FINIS.has(c.statut);
  const somme = (l, champ) => (l || []).reduce((s, x) => s + BigInt(x[champ] || '0'), 0n);

  function vue(c) {
    const o = ORIGINES[c.origine] || {};
    const net = somme(c.credits, 'net'), frais = somme(c.credits, 'frais');
    return {
      id: c.id, status: STATUT_PUBLIC[c.statut] || 'waiting', origin: c.origine,
      network: o.reseau, token: o.symbole, send: c.envoiTexte, depositAddress: c.depot,
      amountUsd: c.demandeUsd, feeBps: c.fraisBps, feePercent: c.fraisBps / 100,
      estimateSwogebet: enTexte(c.coteWei, DECIMALES_JETON),
      estimateCreditedSwogebet: enTexte(partage(c.coteWei, c.fraisBps).net, DECIMALES_JETON),
      creditedSwogebet: enTexte(net, DECIMALES_JETON), feeSwogebet: enTexte(frais, DECIMALES_JETON),
      createdAt: new Date(c.cree).toISOString(), sendBefore: new Date(c.cree + ENVOI_CONSEILLE_MS).toISOString(),
      message: c.message || null,
    };
  }

  /** Une nouvelle commande. `addr` : la SESSION (jamais une adresse du corps). Rend { status, corps }. */
  async function nouvelle(addr, q) {
    const non = (status, raison) => { MESURE.refus++; return { status, corps: { ok: false, raison } }; };
    if (!ouvert()) return non(503, 'depositing with SOL, USDC, USDT or ETH is not available right now');
    if (enPanne()) return non(503, 'our payment route is not answering right now - try again in a few minutes; nothing was charged');
    const k = minuscule(addr);
    if (!adresseOk(k)) return non(401, 'sign in with your wallet first');
    if (deps.estMaison && deps.estMaison(k)) return non(403, 'house accounts cannot use deposit addresses');
    const id = String((q && (q.origin || q.origine)) || '');
    const o = Object.prototype.hasOwnProperty.call(ORIGINES, id) ? ORIGINES[id] : null;
    if (!o) return non(400, 'unknown network or token');
    const usd = Math.round(Number(q && (q.amountUsd != null ? q.amountUsd : q.montantUsd)) * 100) / 100;
    if (!(usd >= o.minUsd) || !(usd <= MAX_USD)) return non(400, 'amount must be between $' + o.minUsd + ' and $' + MAX_USD + ' for ' + o.symbole + ' on ' + o.reseau);
    const miennes = commandesDe(k);
    if (miennes.filter(ouverte).length >= OUVERTES_PAR_SESSION) return non(429, 'you already have ' + OUVERTES_PAR_SESSION + ' deposits waiting - use one of them, or wait until they close');
    if (miennes.filter((c) => maintenant() - c.cree < H).length >= COMMANDES_PAR_HEURE) return non(429, 'too many deposit addresses this hour - try again later');
    if (Object.values(C.commandes).filter(ouverte).length >= OUVERTES_MAX) return non(503, 'too many deposits in progress - try again in a few minutes');

    /* Ce que le joueur envoie : 1 USDT = 1 $ ; SOL et ETH au cours du moment, arrondis AU-DESSUS
       a 0,0001 SOL / 0,00001 ETH. */
    let unites;
    try {
      if (o.stable) unites = BigInt(Math.round(usd * 100)) * 10n ** BigInt(o.decimales - 2);
      else {
        const p = await microParUnite(o);
        const brut = (BigInt(Math.round(usd * MICRO)) * 10n ** BigInt(o.decimales) + p - 1n) / p;
        const pas = 10n ** BigInt(o.decimales - (o.decimales === 9 ? 4 : 5));
        unites = ((brut + pas - 1n) / pas) * pas;
      }
    } catch (e) {
      relayKo();
      return non(e.statut && e.statut < 500 && e.statut !== 429 ? 400 : 503, 'could not price this deposit right now - try again; nothing was charged');
    }

    let j;
    try { j = await appelle('/quote/v2', corpsCotation(o, unites)); relayOk(); }
    catch (e) {
      if (!e.statut || e.statut >= 500 || e.statut === 429) relayKo();
      console.warn('[betdepot] quote refused (' + (e.statut || 'network') + '): ' + propre(e.message));
      return non(e.statut && e.statut < 500 && e.statut !== 429 ? 400 : 503, 'could not get a deposit address right now - try again; nothing was charged');
    }
    const d = j.details || {};
    const etape = (j.steps || []).find((s) => s && s.depositAddress) || {};
    const out = d.currencyOut || {}, cin = d.currencyIn || {};
    const coteOk = /^[0-9]{1,40}$/.test(String(out.amount)) && BigInt(out.amount) > 0n;
    const coherent = etape.depositAddress && typeof etape.depositAddress === 'string' && etape.depositAddress.length <= 64
      && out.currency && minuscule(out.currency.address) === minuscule(jeton) && Number(out.currency.chainId) === RH
      && (!d.recipient || minuscule(d.recipient) === minuscule(vault))
      && cin.currency && memeAdresse(cin.currency.address, o.jeton) && String(cin.amount) === String(unites)
      && coteOk;
    if (!coherent) { relayKo(); console.warn('[betdepot] quote does not match the request - refused'); return non(502, 'the payment route answered something unexpected - nothing was charged'); }

    const t = maintenant();
    const c = {
      id: 'b' + crypto.randomBytes(12).toString('hex'), addr: k, origine: id,
      depot: etape.depositAddress, requestId: String(etape.requestId || j.requestId || '').slice(0, 80) || null,
      envoi: String(unites), envoiTexte: enTexte(unites, o.decimales), demandeUsd: usd,
      coteWei: String(BigInt(out.amount)), minWei: /^[0-9]{1,40}$/.test(String(out.minimumAmount)) ? String(out.minimumAmount) : null,
      fraisBps, cree: t, statut: 'attente', prochain: t + 5000, lectures: 0, credits: [],
    };
    C.commandes[c.id] = c;
    if (!ecrit()) { delete C.commandes[c.id]; return non(503, 'could not save your deposit - try again; nothing was charged'); }
    MESURE.commandes++;
    log('[betdepot] order ' + c.id + ' ' + o.symbole + ' on ' + o.reseau + ' $' + usd + ' ~' + enTexte(c.coteWei, DECIMALES_JETON).split('.')[0] + ' $SWOGEBET (fee ' + fraisBps + ' bps) for ' + k.slice(0, 10) + '…');
    return { status: 200, corps: Object.assign({ ok: true }, vue(c), {
      sendExactly: c.envoiTexte + ' ' + o.symbole,
      warning: 'Send only ' + o.symbole + ' on the ' + o.reseau + ' network, from your own wallet.',
    }) };
  }

  function lit(addr, id) {
    const c = Object.prototype.hasOwnProperty.call(C.commandes, String(id || '')) ? C.commandes[String(id)] : null;
    if (!c || c.addr !== minuscule(addr)) return null;
    return vue(c);
  }
  const liste = (addr) => commandesDe(minuscule(addr)).sort((a, b) => b.cree - a.cree).slice(0, 10).map(vue);
  const origines = () => Object.keys(ORIGINES).map((k) => ({ id: k, token: ORIGINES[k].symbole, network: ORIGINES[k].reseau, minUsd: ORIGINES[k].minUsd, maxUsd: MAX_USD }));

  function cadence(c) {
    const age = maintenant() - c.cree;
    if (age < 2 * H) return deps.cadenceMs || 20000;
    if (age < 24 * H) return 5 * 60 * 1000;
    return 30 * 60 * 1000;
  }
  const clos = (c, statut, message) => {
    c.statut = statut; c.message = message || null; c.fini = maintenant();
    if (statut === 'rembourse') MESURE.rembourses++; else if (statut === 'echec') MESURE.echecs++;
    else if (statut === 'a_verifier') MESURE.aVerifier++; else if (statut === 'expire') MESURE.expires++;
    log('[betdepot] order ' + c.id + ' ' + statut + (message ? ' - ' + message : ''));
  };

  /**
   * NOTRE lecture d'une livraison sur Robinhood Chain : 'attend', { ko: raison }, ou
   * { wei (BigInt), cle, tx } — le journal Transfer du $SWOGEBET vers le coffre a crediter a `c`.
   * Une cle deja vue par le jeu n'est libre que si l'intention ecrite dit qu'elle est a `c`
   * (reprise apres un arret entre le credit et l'ecriture de la commande).
   */
  async function lisLivraison(c, tx, indice) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ''))) return { ko: 'the delivery transaction is not a Robinhood Chain hash' };
    const h = minuscule(tx);
    const rc = await deps.rpc.recu(h);
    if (!rc) return 'attend';
    if (Number(rc.status) !== 1) return { ko: 'the delivery transaction failed on Robinhood Chain' };
    const n = parseInt(rc.blockNumber, 16);
    const bloc = await deps.rpc.bloc();
    if (!(n >= 0) || bloc - n + 1 < CONFIRMATIONS) return 'attend';
    const vers = (rc.logs || []).filter((l) => minuscule(l.address) === minuscule(jeton)
      && minuscule((l.topics || [])[0]) === TOPIC_TRANSFER && minuscule((l.topics || [])[2]) === pad32(vault) && !l.removed);
    if (!vers.length) return { ko: 'no $SWOGEBET reached the bet vault in the delivery transaction' };
    if (deps.dejaVu(h)) return { ko: 'this transaction was already credited as a vault deposit' };
    const libres = vers.map((l) => {
      let v = 0n; try { v = BigInt(l.data); } catch (e) { v = 0n; }
      const i = parseInt(l.logIndex, 16);
      return { wei: v, cle: 'relay:' + h + ':' + i, i };
    }).filter((x) => x.wei > 0n && x.i >= 0
      && !(c.credits || []).some((k) => k.cle === x.cle)
      && (!C.cles[x.cle] || C.cles[x.cle] === c.id)
      && (!deps.dejaVu(x.cle) || C.cles[x.cle] === c.id));
    let pris = null;
    if (libres.length === 1 && vers.length === 1) pris = libres[0];
    else if (libres.length && indice) pris = libres.find((x) => x.wei === indice) || null;
    if (!pris) return { ko: vers.length > 1 ? 'several $SWOGEBET transfers in one delivery - checked by hand' : 'this delivery was already credited' };
    return { wei: pris.wei, cle: pris.cle, tx: h };
  }

  function indiceDe(o) {
    for (const s of (o && o.stateChanges) || []) {
      const ch = s && s.change;
      if (s && minuscule(s.address) === minuscule(vault) && ch && ch.data && minuscule(ch.data.tokenAddress) === minuscule(jeton)) {
        try { const v = BigInt(ch.balanceDiff); if (v > 0n) return v; } catch (e) { /* rien */ }
      }
    }
    return null;
  }

  /* Crediter une livraison lue : intention ecrite, credit du jeu, puis la commande. Rend true si
     la commande porte le credit (fait maintenant ou rattrape), false s'il faut relire. */
  function credite(c, l) {
    const { net, frais } = partage(l.wei, c.fraisBps);
    C.cles[l.cle] = c.id;
    if (!ecrit()) { delete C.cles[l.cle]; return false; }
    let fait = false;
    try { fait = deps.credite({ player: c.addr, amountWei: net.toString(), tx: l.cle }) === true; }
    catch (e) { console.error('[betdepot] credit failed for ' + c.id + ': ' + propre(e && e.message || e)); return false; }
    if (!fait) {
      /* Le jeu l'a deja : un arret avait coupe entre son credit et cette ecriture. */
      if (!deps.dejaVu(l.cle)) return false;
      MESURE.reprises++;
    }
    c.credits.push({ cle: l.cle, tx: l.tx, arrive: l.wei.toString(), net: net.toString(), frais: frais.toString(), t: maintenant() });
    C.arriveWei = (BigInt(C.arriveWei || '0') + l.wei).toString();
    C.creditWei = (BigInt(C.creditWei || '0') + net).toString();
    C.fraisWei = (BigInt(C.fraisWei || '0') + frais).toString();
    MESURE.credites++;
    ecrit();
    log('[betdepot] order ' + c.id + ' credited ' + enTexte(net, DECIMALES_JETON) + ' $SWOGEBET (arrived ' + enTexte(l.wei, DECIMALES_JETON) + ', fee ' + enTexte(frais, DECIMALES_JETON) + ', RH ' + l.tx.slice(0, 12) + '…)' + (fait ? '' : ' [resumed]'));
    return true;
  }

  async function suit(c) {
    c.lectures = (c.lectures || 0) + 1; MESURE.lectures++;
    let j;
    try {
      j = await appelle('/requests/v3?depositAddress=' + encodeURIComponent(c.depot) + '&limit=20');
      relayOk();
    } catch (e) {
      relayKo();
      if (MESURE.echecsRelay % 20 === 1) console.warn('[betdepot] Relay status read failed (' + (e.statut || 'network') + '): ' + propre(e.message));
      return;
    }
    const demandes = ((j && j.requests) || []).filter((r) => {
      const da = r && r.depositAddress;
      const a = da && typeof da === 'object' ? da.address : da;
      return a && memeAdresse(a, c.depot);
    });
    let attend = false, rembourse = null, echec = null, aVerifier = null;
    for (const r of demandes) {
      const st = String(r.status || '');
      const data = r.data || {};
      if (st === 'success') {
        if (r.recipient && minuscule(r.recipient) !== minuscule(vault)) { aVerifier = 'Relay delivered to another address'; continue; }
        const sorties = (data.outTxs || []).filter((o) => Number(o.chainId) === RH && o.txHash);
        if (!sorties.length) { if ((data.outTxs || []).length) aVerifier = 'Relay reports a delivery outside Robinhood Chain'; else attend = true; continue; }
        for (const o of sorties) {
          let l;
          try { l = await lisLivraison(c, o.txHash, indiceDe(o)); }
          catch (e) { attend = true; continue; }
          if (l === 'attend') { attend = true; continue; }
          if (l.ko) {
            if ((c.credits || []).some((x) => x.tx === minuscule(o.txHash))) continue;
            aVerifier = l.ko; continue;
          }
          if (!credite(c, l)) attend = true;
        }
      } else if (st === 'refund') rembourse = String(data.failReason || data.refundFailReason || 'refunded');
      else if (st === 'failure') echec = String(data.failReason || 'failed');
      else attend = true;
    }
    const fait = (c.credits || []).length > 0;
    if (fait && !attend) clos(c, 'credite', null);
    else if (fait) c.statut = 'recu';
    else if (aVerifier && !attend) clos(c, 'a_verifier', 'Relay reports a delivery we could not confirm on Robinhood Chain (' + aVerifier + ') - contact support with order ' + c.id);
    else if (rembourse && !attend) clos(c, 'rembourse', 'Your deposit was sent back to the sending address (' + propre(rembourse).slice(0, 60) + '). Nothing was credited.');
    else if (echec && !attend) clos(c, 'echec', 'The conversion failed (' + propre(echec).slice(0, 60) + '). Nothing was credited; any refund goes back to the sending address.');
    else if (demandes.length) c.statut = 'recu';
    if (!FINIS.has(c.statut) && maintenant() - c.cree > JOURS_MAX * 24 * H) {
      clos(c, 'expire', fait ? null : 'Nothing arrived within ' + JOURS_MAX + ' days. Do not send to this address any more.');
      if (fait) c.statut = 'credite';
    }
    c.prochain = maintenant() + cadence(c);
    ecrit();
  }

  let enTour = false;
  async function tour(n) {
    if (enTour || !actif()) return 0;
    enTour = true;
    try {
      const dues = Object.values(C.commandes).filter((c) => !FINIS.has(c.statut) && (c.prochain || 0) <= maintenant())
        .sort((a, b) => (a.prochain || 0) - (b.prochain || 0)).slice(0, n || LECTURES_PAR_TOUR);
      for (const c of dues) await suit(c);
      return dues.length;
    } finally { enTour = false; }
  }
  function presse(addr, id) {
    const c = Object.prototype.hasOwnProperty.call(C.commandes, String(id || '')) ? C.commandes[String(id)] : null;
    if (!c || c.addr !== minuscule(addr) || FINIS.has(c.statut)) return;
    const t = maintenant() + 1000;
    if ((c.prochain || 0) > t && maintenant() - c.cree < 2 * H) c.prochain = Math.max(t, (c.dernierePresse || 0) + 5000);
    c.dernierePresse = maintenant();
  }

  let minuteur = null;
  function demarre() {
    if (minuteur || !actif()) return false;
    minuteur = setInterval(() => { tour().catch((e) => console.error('[betdepot] poll: ' + propre(e && e.message || e))); }, deps.tourMs || TOUR_MS);
    if (minuteur.unref) minuteur.unref();
    const n = Object.values(C.commandes).filter(ouverte).length;
    if (n) log('[betdepot] ' + n + ' open bet deposit order(s) resumed from disk');
    return true;
  }
  const arrete = () => { if (minuteur) clearInterval(minuteur); minuteur = null; };

  const etat = () => ({ actif: actif(), ouvert: ouvert(), panne: enPanne(), fraisBps, ouvertes: Object.values(C.commandes).filter(ouverte).length,
    total: Object.keys(C.commandes).length, arrive: enTexte(C.arriveWei || '0', DECIMALES_JETON),
    credite: enTexte(C.creditWei || '0', DECIMALES_JETON), fraisCumules: enTexte(C.fraisWei || '0', DECIMALES_JETON), mesure: Object.assign({}, MESURE) });
  return { actif, ouvert, enPanne, nouvelle, lit, liste, origines, tour, presse, demarre, arrete, MESURE, etat };
}

module.exports = { cree, ORIGINES, MIN_USD, MAX_USD, CONFIRMATIONS, OUVERTES_PAR_SESSION, FRAIS_DEFAUT_BPS, FRAIS_MAX_BPS, DECIMALES_JETON, USDC_BASE, lisFrais, partage, enTexte };
