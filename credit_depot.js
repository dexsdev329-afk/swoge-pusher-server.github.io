'use strict';
/* ==================================================================
 * RECHARGER LE CREDIT EN DOLLARS AVEC DU SOL OU DE L'USDT (14 octobre 2026)
 * ==================================================================
 *
 * Demande du proprietaire : recharger le credit en SOL et en USDT, « simple
 * pour l'utilisateur ». La recharge existante (credits.recharge) ne prend que de
 * l'USDC signe en x402 (EIP-3009 sur Base, transaction Solana). L'USDT de Base et
 * celui d'Ethereum n'ont ni EIP-3009 ni permit : x402 ne peut pas les prendre. Le
 * SOL natif non plus. D'ou ce second chemin, sans signature :
 *
 *   1. la page demande une adresse de depot (POST /credit/deposit) ;
 *   2. le serveur la demande a Relay en mode STRICT, destinataire = la tresorerie
 *      de Base (le meme payTo que x402 Base), destination = USDC sur Base ;
 *   3. la commande est ECRITE sur le disque (fsync, renommage) AVANT la reponse ;
 *   4. le joueur envoie ; Relay convertit et livre de l'USDC a la tresorerie ;
 *   5. le suivi relit /requests/v3?depositAddress=… puis LE RECU sur Base, et
 *      credite EXACTEMENT l'USDC arrive, une fois (cle relay:<tx>:<index>), a la
 *      session qui a cree la commande.
 *
 * ---- CE QUI A ETE MESURE AVANT D'ECRIRE (14/10/2026, cotations sans cle) ----
 *   adresse de depot STRICTE, vers USDC sur Base :
 *     2 USDT Base      → 1,962778 USDC (1,9 %)   10 USDT Ethereum → 9,747613 USDC (2,5 %)
 *   sans adresse de depot (reference du cout de la route) :
 *     0,02 SOL (2,12 $) → 2,087144 USDC (frais 0,034 $, tolerance 3,27 %)
 *     10 USDT Solana    → 9,961986 USDC (frais 0,035 $, tolerance 2 %)
 *     2 USDT Base       → 1,996942 USDC
 *   Les frais sont presque FIXES (≈ 0,03 $ par route Solana, le balayage du depot en plus) :
 *   sous 2 $ ils mangent plus de 1,5 % — d'ou le minimum de 2 $. Sur Ethereum le balayage paie
 *   le gaz du reseau principal (2,5 % a 10 $) : minimum 10 $.
 *
 * ---- CE QUE DIT LA DOCUMENTATION DE RELAY (docs.relay.link/features/deposit-addresses, relue le 14/10) ----
 *   • strict : `refundTo` OBLIGATOIRE ; un sous-paiement est REMBOURSE ; un sur-paiement en
 *     EXACT_INPUT est converti en entier (rien n'est rendu) ; jamais de nouvelle cotation ;
 *   • `refundTo` = l'adresse native de la chaine (0x000…0, 1111…1111) : remboursement automatique
 *     a l'envoyeur — deconseille si l'envoi vient d'une PLATEFORME D'ECHANGE (l'envoyeur est leur
 *     portefeuille chaud). La page le dit ;
 *   • le suivi se fait PAR L'ADRESSE DE DEPOT (GET /requests/v3?depositAddress=), pas par le
 *     requestId de la cotation ; les depots de 0,05 $ ou moins ne sont jamais balayes ;
 *   • /requests/v3 ne montre que les demandes de NOTRE integrateur : la cle est indispensable ;
 *   • limites par cle : /quote 50 par minute, /requests/v3 200 par minute.
 *
 * ---- LES REGLES D'ARGENT ----
 *   • rien de ce qu'envoie le client ne choisit une adresse, un requestId ou un destinataire :
 *     la provenance vient d'une LISTE FERMEE, tout le reste est fixe ici ;
 *   • on ne credite que ce que NOTRE lecture du recu Base montre : statut 1, journal Transfer
 *     de l'USDC vers payTo, au moins CONFIRMATIONS blocs ; le montant est celui du journal ;
 *   • une arrivee qui ne se lit pas (recu absent) n'est PAS un echec : on relit ; un recu qui
 *     contredit Relay (statut 0, autre jeton, autre destinataire) ne credite rien et met la
 *     commande « a verifier » ;
 *   • remboursement ou echec : rien n'est credite, la commande le dit ;
 *   • la cle Relay ne sort jamais : ni reponse, ni journal.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 8453;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';   /* x402.js USDC_BASE */
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NATIF_EVM = '0x0000000000000000000000000000000000000000';
const NATIF_SOL = '11111111111111111111111111111111';
const SOLANA = 792703809;
const MICRO = 1e6;

/* Les provenances, LISTE FERMEE. Chaque ligne a rendu une vraie cotation vers USDC sur Base le
   14/10 (adresses des jetons confirmees par le symbole que Relay renvoie). `repere` : l'adresse
   native de la chaine, qui sert de `user` (relay.js : `user` est juge contre la chaine de DEPART)
   et de `refundTo` (remboursement a l'envoyeur). */
const ORIGINES = {
  sol:       { chaine: SOLANA, jeton: NATIF_SOL, repere: NATIF_SOL, decimales: 9, symbole: 'SOL', reseau: 'Solana', minUsd: 2 },
  usdt_sol:  { chaine: SOLANA, jeton: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', repere: NATIF_SOL, decimales: 6, symbole: 'USDT', reseau: 'Solana', minUsd: 2, stable: true },
  usdt_base: { chaine: BASE, jeton: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', repere: NATIF_EVM, decimales: 6, symbole: 'USDT', reseau: 'Base', minUsd: 2, stable: true },
  usdt_eth:  { chaine: 1, jeton: '0xdAC17F958D2ee523a2206206994597C13D831ec7', repere: NATIF_EVM, decimales: 6, symbole: 'USDT', reseau: 'Ethereum', minUsd: 10, stable: true },
};
/* 50 $ par recharge : la meme borne que la recharge USDC (credits.js MAX_RECHARGE_USD). */
const MAX_USD = 50;
const OUVERTES_PAR_SESSION = 3;
const COMMANDES_PAR_HEURE = 6;
/* Au plus 200 commandes suivies : a 20 s chacune, 600 lectures par minute au pire si toutes
   etaient jeunes ; le tour n'en lit que LECTURES_PAR_TOUR toutes les TOUR_MS (≤ 90/min, sous
   les 200/min de /requests/v3). */
const OUVERTES_MAX = 200;
const TOUR_MS = 2000;
const LECTURES_PAR_TOUR = 3;
const CONFIRMATIONS = 2;
/* « Envoyez dans les 30 min » : une consigne, pas une borne de Relay (la doc ne donne aucune
   duree de vie a une adresse stricte) ; le prix du SOL bouge, l'estimation vieillit. */
const ENVOI_CONSEILLE_MS = 30 * 60 * 1000;
/* Le suivi : 20 s pendant 2 h (un envoi normal arrive en secondes, timeEstimate = 2 s), puis
   5 min jusqu'a 24 h, puis 30 min jusqu'a 7 jours, puis la commande est close. */
const H = 3600 * 1000;
const JOURS_MAX = 7;
const PANNE_ECHECS = 3;
const PANNE_FENETRE_MS = 5 * 60 * 1000;

const FINIS = new Set(['credite', 'rembourse', 'echec', 'expire', 'a_verifier']);
const STATUT_PUBLIC = { attente: 'waiting', recu: 'processing', credite: 'credited', rembourse: 'refunded', echec: 'failed', expire: 'expired', a_verifier: 'review' };

const minuscule = (a) => String(a || '').toLowerCase();
/* Une adresse 0x se compare sans casse ; une adresse Solana (base58) AVEC. */
const memeAdresse = (a, b) => /^0x/i.test(String(a || '')) ? minuscule(a) === minuscule(b) : String(a || '') === String(b || '');
const pad32 = (a) => '0x' + '0'.repeat(24) + minuscule(a).slice(2);

/** Un montant en unites entieres (texte) → texte decimal, sans flottant. */
function enTexte(unites, decimales) {
  const s = String(unites).padStart(decimales + 1, '0');
  const e = s.slice(0, s.length - decimales), d = s.slice(s.length - decimales).replace(/0+$/, '');
  return d ? e + '.' + d : e;
}

/**
 * deps : { dossier, credits (credits.cree), payTo (adresse Base, getAddress), rpc ({ recu(h), bloc() }),
 *          api (URL de Relay), cle (RELAY_API_KEY), fetch?, maintenant?, cadenceMs? (essais : remplace 20 s),
 *          tourMs? (essais), log?(texte) }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const f = deps.fetch || fetch;
  const fichier = deps.dossier ? path.join(deps.dossier, 'credit_depots.json') : null;
  const log = deps.log || ((t) => console.log(t));
  const payTo = deps.payTo ? String(deps.payTo) : null;
  const cleRelay = String(deps.cle || '');
  const MESURE = { commandes: 0, refus: 0, lectures: 0, echecsRelay: 0, credites: 0, crediteMicro: 0, rembourses: 0, echecs: 0, aVerifier: 0, expires: 0 };
  const panne = { echecs: 0, derniere: 0 };
  /* Le texte d'une erreur, sans jamais la cle (Relay pourrait la renvoyer dans un message). */
  const propre = (t) => { let s = String(t == null ? '' : t).slice(0, 200); if (cleRelay) s = s.split(cleRelay).join('***'); return s; };

  let C = { commandes: {} };
  if (fichier) {
    try { C = Object.assign(C, JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}); }
    catch (e) {
      if (e.code !== 'ENOENT') {
        /* Un fichier illisible n'est JAMAIS ecrase : on le met de cote et on le dit. */
        try { fs.renameSync(fichier, fichier + '.illisible-' + maintenant()); } catch (x) {}
        console.error('[depot] credit_depots.json unreadable - set aside, orders must be checked by hand');
      }
    }
  }
  /* Ecriture DURABLE : fsync du fichier temporaire puis renommage. Rend false si elle a echoue
     (la commande n'est alors pas rendue au joueur). */
  function ecrit() {
    if (!fichier) return true;
    try {
      fs.mkdirSync(deps.dossier, { recursive: true });
      const tmp = fichier + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify(C)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, fichier);
      return true;
    } catch (e) { console.error('[depot] write failed: ' + (e && e.code || e)); return false; }
  }

  const actif = () => !!(cleRelay && payTo && /^0x[0-9a-fA-F]{40}$/.test(payTo) && deps.credits && deps.rpc);
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
  const corpsCotation = (o, montant, depot) => Object.assign(depot ? { useDepositAddress: true, strict: true } : {}, {
    user: o.repere, recipient: payTo, refundTo: o.repere,
    originChainId: o.chaine, originCurrency: o.jeton,
    destinationChainId: BASE, destinationCurrency: USDC_BASE,
    amount: String(montant), tradeType: 'EXACT_INPUT',
  });

  /* Le cours du SOL en micro-USDC par SOL, d'une cotation SANS adresse de depot d'un SOL entier,
     garde 60 s (la limite de /quote est de 50 par minute). */
  const coursSol = { v: null, t: 0 };
  async function microParSol() {
    if (coursSol.v && maintenant() - coursSol.t < 60000) return coursSol.v;
    const j = await appelle('/quote/v2', corpsCotation(ORIGINES.sol, '1000000000', false));
    const out = j && j.details && j.details.currencyOut;
    const v = out && /^[0-9]+$/.test(String(out.amount)) ? BigInt(out.amount) : 0n;
    if (v <= 0n) { const e = new Error('no SOL price'); e.statut = 502; throw e; }
    coursSol.v = v; coursSol.t = maintenant();
    return v;
  }

  const commandesDe = (k) => Object.values(C.commandes).filter((c) => c.addr === k);
  const ouverte = (c) => !FINIS.has(c.statut);

  function vue(c) {
    const o = ORIGINES[c.origine] || {};
    const credit = (c.credits || []).reduce((s, x) => s + x.micro, 0);
    return {
      id: c.id, status: STATUT_PUBLIC[c.statut] || 'waiting', origin: c.origine,
      network: o.reseau, token: o.symbole, send: c.envoiTexte, depositAddress: c.depot,
      estimateUsd: c.coteMicro / MICRO, creditedUsd: credit / MICRO,
      createdAt: new Date(c.cree).toISOString(), sendBefore: new Date(c.cree + ENVOI_CONSEILLE_MS).toISOString(),
      message: c.message || null,
    };
  }

  /**
   * Une nouvelle commande. `addr` : la SESSION (jamais une adresse du corps). Rend { status, corps }.
   */
  async function nouvelle(addr, q) {
    const non = (status, raison) => { MESURE.refus++; return { status, corps: { ok: false, raison } }; };
    if (!actif()) return non(503, 'paying with SOL or USDT is not available right now');
    if (enPanne()) return non(503, 'our payment route is not answering right now - try again in a few minutes; nothing was charged');
    const k = minuscule(addr);
    const o = ORIGINES[String((q && (q.origin || q.origine)) || '')];
    if (!o) return non(400, 'unknown network or token');
    const usd = Math.round(Number(q && (q.amountUsd != null ? q.amountUsd : q.montantUsd)) * 100) / 100;
    if (!(usd >= o.minUsd) || !(usd <= MAX_USD)) return non(400, 'amount must be between $' + o.minUsd + ' and $' + MAX_USD + ' for ' + o.symbole + ' on ' + o.reseau);
    const miennes = commandesDe(k);
    if (miennes.filter(ouverte).length >= OUVERTES_PAR_SESSION) return non(429, 'you already have ' + OUVERTES_PAR_SESSION + ' deposits waiting - use one of them, or wait until they close');
    if (miennes.filter((c) => maintenant() - c.cree < H).length >= COMMANDES_PAR_HEURE) return non(429, 'too many deposit addresses this hour - try again later');
    if (Object.values(C.commandes).filter(ouverte).length >= OUVERTES_MAX) return non(503, 'too many deposits in progress - try again in a few minutes');
    const enCours = miennes.filter(ouverte).reduce((s, c) => s + c.coteMicro, 0);
    const max = Math.round((deps.credits.LIMITES && deps.credits.LIMITES.maxSoldeUsd || 100) * MICRO);
    if (deps.credits.soldeMicro(k) + enCours + Math.round(usd * MICRO) > max) return non(400, 'your credit would go above $' + (max / MICRO) + ' - spend some first');

    /* Ce que le joueur envoie, en unites du jeton : 1 USDT = 1 $ ; le SOL au cours du moment,
       arrondi AU-DESSUS a 0,0001 SOL. */
    let unites;
    try {
      if (o.stable) unites = BigInt(Math.round(usd * 100)) * 10n ** BigInt(o.decimales - 2);
      else {
        const p = await microParSol();
        const brut = (BigInt(Math.round(usd * MICRO)) * 10n ** 9n + p - 1n) / p;
        const pas = 100000n;
        unites = ((brut + pas - 1n) / pas) * pas;
      }
    } catch (e) {
      relayKo();
      return non(e.statut && e.statut < 500 && e.statut !== 429 ? 400 : 503, 'could not price this deposit right now - try again; nothing was charged');
    }

    let j;
    try { j = await appelle('/quote/v2', corpsCotation(o, unites, true)); relayOk(); }
    catch (e) {
      if (!e.statut || e.statut >= 500 || e.statut === 429) relayKo();
      console.warn('[depot] quote refused (' + (e.statut || 'network') + '): ' + propre(e.message));
      return non(e.statut && e.statut < 500 && e.statut !== 429 ? 400 : 503, 'could not get a deposit address right now - try again; nothing was charged');
    }
    /* Relay ne decide de rien : on verifie que la cotation est bien celle demandee. */
    const d = j.details || {};
    const etape = (j.steps || []).find((s) => s && s.depositAddress) || {};
    const out = d.currencyOut || {}, cin = d.currencyIn || {};
    const coteMicro = /^[0-9]{1,15}$/.test(String(out.amount)) ? Number(out.amount) : 0;
    const coherent = etape.depositAddress && typeof etape.depositAddress === 'string' && etape.depositAddress.length <= 64
      && out.currency && minuscule(out.currency.address) === minuscule(USDC_BASE) && Number(out.currency.chainId) === BASE
      && (!d.recipient || minuscule(d.recipient) === minuscule(payTo))
      && cin.currency && memeAdresse(cin.currency.address, o.jeton) && String(cin.amount) === String(unites)
      && coteMicro > 0;
    if (!coherent) { relayKo(); console.warn('[depot] quote does not match the request - refused'); return non(502, 'the payment route answered something unexpected - nothing was charged'); }
    if (coteMicro > MAX_USD * MICRO) return non(400, 'this deposit would credit more than $' + MAX_USD + ' - choose a smaller amount');
    if (deps.credits.soldeMicro(k) + enCours + coteMicro > max) return non(400, 'your credit would go above $' + (max / MICRO) + ' - spend some first');

    const t = maintenant();
    const c = {
      id: 'd' + crypto.randomBytes(12).toString('hex'), addr: k, origine: Object.keys(ORIGINES).find((x) => ORIGINES[x] === o),
      depot: etape.depositAddress, requestId: String(etape.requestId || j.requestId || '').slice(0, 80) || null,
      envoi: String(unites), envoiTexte: enTexte(unites, o.decimales), demandeUsd: usd,
      coteMicro, minMicro: /^[0-9]{1,15}$/.test(String(out.minimumAmount)) ? Number(out.minimumAmount) : null,
      cree: t, statut: 'attente', prochain: t + 5000, lectures: 0, credits: [],
    };
    C.commandes[c.id] = c;
    if (!ecrit()) { delete C.commandes[c.id]; return non(503, 'could not save your deposit - try again; nothing was charged'); }
    MESURE.commandes++;
    log('[depot] order ' + c.id + ' ' + o.symbole + ' on ' + o.reseau + ' ~$' + (coteMicro / MICRO).toFixed(2) + ' for ' + k.slice(0, 10) + '…');
    return { status: 200, corps: Object.assign({ ok: true }, vue(c), {
      sendExactly: c.envoiTexte + ' ' + o.symbole,
      warning: 'Send only ' + o.symbole + ' on the ' + o.reseau + ' network, from your own wallet.',
    }) };
  }

  /** Une commande, pour SA session seulement (une autre session : 404, comme une commande inconnue). */
  function lit(addr, id) {
    const c = C.commandes[String(id || '')];
    if (!c || c.addr !== minuscule(addr)) return null;
    return vue(c);
  }
  const liste = (addr) => commandesDe(minuscule(addr)).sort((a, b) => b.cree - a.cree).slice(0, 10).map(vue);
  const origines = () => Object.keys(ORIGINES).map((k) => ({ id: k, token: ORIGINES[k].symbole, network: ORIGINES[k].reseau, minUsd: ORIGINES[k].minUsd, maxUsd: MAX_USD }));

  /* La prochaine lecture selon l'age. */
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
    log('[depot] order ' + c.id + ' ' + statut + (message ? ' - ' + message : ''));
  };

  /**
   * NOTRE lecture d'une livraison sur Base : 'attend' (recu absent ou trop frais), { ko: raison },
   * ou { micro, cle, tx } — le journal Transfer de l'USDC vers payTo qu'on credite.
   * `indice` : le montant que Relay dit avoir livre a payTo (stateChanges), qui departage
   * seulement si le recu porte PLUSIEURS transferts vers payTo.
   */
  async function lisLivraison(tx, indice) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ''))) return { ko: 'the delivery transaction is not a Base hash' };
    const h = minuscule(tx);
    const rc = await deps.rpc.recu(h);
    if (!rc) return 'attend';
    if (Number(rc.status) !== 1) return { ko: 'the delivery transaction failed on Base' };
    const n = parseInt(rc.blockNumber, 16);
    const bloc = await deps.rpc.bloc();
    if (!(n >= 0) || bloc - n + 1 < CONFIRMATIONS) return 'attend';
    const vers = (rc.logs || []).filter((l) => minuscule(l.address) === minuscule(USDC_BASE)
      && minuscule((l.topics || [])[0]) === TOPIC_TRANSFER && minuscule((l.topics || [])[2]) === pad32(payTo) && !l.removed);
    const libres = vers.map((l) => {
      let v = 0n; try { v = BigInt(l.data); } catch (e) { v = 0n; }
      const i = parseInt(l.logIndex, 16);
      return { micro: v, cle: 'relay:' + h + ':' + i, i };
    }).filter((x) => x.micro > 0n && x.i >= 0 && !deps.credits.dejaCredite(x.cle));
    if (!vers.length) return { ko: 'no USDC reached our Base address in the delivery transaction' };
    const marque = deps.credits.dejaCredite(h);
    if (marque && marque !== 'relay') return { ko: 'this transaction was already credited another way' };
    let pris = null;
    if (libres.length === 1 && vers.length === 1) pris = libres[0];
    else if (libres.length && indice) pris = libres.find((x) => x.micro === indice) || null;
    if (!pris) return { ko: vers.length > 1 ? 'several USDC transfers in one delivery - checked by hand' : 'this delivery was already credited' };
    if (pris.micro > BigInt(Number.MAX_SAFE_INTEGER)) return { ko: 'amount out of range' };
    return { micro: Number(pris.micro), cle: pris.cle, tx: h };
  }

  /** Ce que Relay dit avoir livre a payTo en USDC sur Base dans une sortie (indice seulement). */
  function indiceDe(o) {
    for (const s of (o && o.stateChanges) || []) {
      const ch = s && s.change;
      if (s && minuscule(s.address) === minuscule(payTo) && ch && ch.data && minuscule(ch.data.tokenAddress) === minuscule(USDC_BASE)) {
        try { const v = BigInt(ch.balanceDiff); if (v > 0n) return v; } catch (e) { /* rien */ }
      }
    }
    return null;
  }

  /** Une lecture d'une commande. Ne leve jamais : une panne de Relay se compte et se relit. */
  async function suit(c) {
    c.lectures = (c.lectures || 0) + 1; MESURE.lectures++;
    let j;
    try {
      j = await appelle('/requests/v3?depositAddress=' + encodeURIComponent(c.depot) + '&limit=20');
      relayOk();
    } catch (e) {
      relayKo();
      if (MESURE.echecsRelay % 20 === 1) console.warn('[depot] Relay status read failed (' + (e.statut || 'network') + '): ' + propre(e.message));
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
        if (r.recipient && minuscule(r.recipient) !== minuscule(payTo)) { aVerifier = 'Relay delivered to another address'; continue; }
        const sorties = (data.outTxs || []).filter((o) => Number(o.chainId) === BASE && o.txHash);
        if (!sorties.length) { if ((data.outTxs || []).length) aVerifier = 'Relay reports a delivery outside Base'; else attend = true; continue; }
        for (const o of sorties) {
          let l;
          try { l = await lisLivraison(o.txHash, indiceDe(o)); }
          catch (e) { attend = true; continue; }        /* noeud Base muet : on relira */
          if (l === 'attend') { attend = true; continue; }
          if (l.ko) {
            /* Deja credite par CETTE commande (une relecture apres coup) : rien a dire. */
            if ((c.credits || []).some((x) => x.tx === minuscule(o.txHash))) continue;
            aVerifier = l.ko; continue;
          }
          const s = deps.credits.ajoute(c.addr, null, { cle: l.cle, micro: l.micro, transaction: l.tx, network: 'relay:' + c.origine });
          if (s === null) continue;
          c.credits.push({ cle: l.cle, tx: l.tx, micro: l.micro, t: maintenant() });
          MESURE.credites++; MESURE.crediteMicro += l.micro;
          log('[depot] order ' + c.id + ' credited $' + (l.micro / MICRO).toFixed(6) + ' (Base ' + l.tx.slice(0, 12) + '…)');
        }
      } else if (st === 'refund') rembourse = String(data.failReason || data.refundFailReason || 'refunded');
      else if (st === 'failure') echec = String(data.failReason || 'failed');
      else attend = true;                                   /* waiting, pending, depositing… */
    }
    const credite = (c.credits || []).length > 0;
    if (credite && !attend) clos(c, 'credite', null);
    else if (credite) c.statut = 'recu';
    else if (aVerifier && !attend) clos(c, 'a_verifier', 'Relay reports a delivery we could not confirm on Base (' + aVerifier + ') - contact support with order ' + c.id);
    else if (rembourse && !attend) clos(c, 'rembourse', 'Your deposit was sent back to the sending address (' + propre(rembourse).slice(0, 60) + '). Nothing was credited.');
    else if (echec && !attend) clos(c, 'echec', 'The conversion failed (' + propre(echec).slice(0, 60) + '). Nothing was credited; any refund goes back to the sending address.');
    else if (demandes.length) c.statut = 'recu';
    if (!FINIS.has(c.statut) && maintenant() - c.cree > JOURS_MAX * 24 * H) {
      clos(c, 'expire', credite ? null : 'Nothing arrived within ' + JOURS_MAX + ' days. Do not send to this address any more.');
      if (credite) c.statut = 'credite';
    }
    c.prochain = maintenant() + cadence(c);
    ecrit();
  }

  /** Un tour : les commandes dues, dans l'ordre, LECTURES_PAR_TOUR au plus. */
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
  /** Relire tout de suite une commande de la session (la page qui regarde). Une fois par 5 s. */
  function presse(addr, id) {
    const c = C.commandes[String(id || '')];
    if (!c || c.addr !== minuscule(addr) || FINIS.has(c.statut)) return;
    const t = maintenant() + 1000;
    if ((c.prochain || 0) > t && maintenant() - c.cree < 2 * H) c.prochain = Math.max(t, (c.dernierePresse || 0) + 5000);
    c.dernierePresse = maintenant();
  }

  let minuteur = null;
  function demarre() {
    if (minuteur || !actif()) return false;
    minuteur = setInterval(() => { tour().catch((e) => console.error('[depot] poll: ' + propre(e && e.message || e))); }, deps.tourMs || TOUR_MS);
    if (minuteur.unref) minuteur.unref();
    const n = Object.values(C.commandes).filter(ouverte).length;
    if (n) log('[depot] ' + n + ' open deposit order(s) resumed from disk');
    return true;
  }
  const arrete = () => { if (minuteur) clearInterval(minuteur); minuteur = null; };

  return { actif, enPanne, nouvelle, lit, liste, origines, tour, presse, demarre, arrete, MESURE,
    etat: () => ({ actif: actif(), panne: enPanne(), ouvertes: Object.values(C.commandes).filter(ouverte).length, total: Object.keys(C.commandes).length, mesure: Object.assign({}, MESURE) }) };
}

module.exports = { cree, ORIGINES, USDC_BASE, MAX_USD, CONFIRMATIONS, OUVERTES_PAR_SESSION, enTexte };
