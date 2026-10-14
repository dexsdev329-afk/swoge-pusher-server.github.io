'use strict';
/* ==================================================================
 * LE CREDIT EN DOLLARS (29 septembre 2026)
 * ==================================================================
 *
 * Demande du proprietaire : « faudrait surtout faciliter le systeme de paiement,
 * le $SWOGE devrait etre une option, et pouvoir payer facilement en signature
 * wallet avec les autres devises » — choix « les deux » :
 *
 *   1. un CREDIT en dollars : une signature USDC (Base ou Solana, le x402 deja en
 *      ligne) le recharge ; ensuite l'agent, le chat et les embauches de l'agent se
 *      debitent au cout reel, sans nouvelle signature ;
 *   2. une signature PAR ACTION : la page recharge exactement ce qui manque pour
 *      la tache (son pire cas), le reste de la reserve reste au credit.
 * Le $SWOGE du vault reste possible, en option (payeur 'swoge').
 *
 * La regle d'argent est celle du solde de jeu : reserver le pire cas, facturer
 * le cout reel, rendre le reste. Montants en MICRO-DOLLARS entiers, jamais en
 * flottant. Le credit est celui de l'adresse de SESSION : une recharge credite
 * la session qui l'a demandee, quel que soit le portefeuille qui signe.
 *
 * L'ordre de la recharge : x402 VERIFIE la signature, puis la REGLE ; le credit
 * n'est ajoute qu'apres le reglement (reponse 200), une seule fois par
 * transaction. Un reglement en attente (Base, et Solana depuis le 13/10) : rien n'est
 * credite, le client represente la meme signature et le credit tombe quand la chaine a
 * tranche — une fois, a la session qui l'a demande, apres relecture de la transaction.
 *
 * Une reserve ouverte au moment d'un arret du serveur est RENDUE au demarrage :
 * le fournisseur a peut-etre deja facture, la maison le paie.
 *
 * ---- SAUF UNE RESERVE DURABLE (14 octobre 2026) ----
 * Demande du proprietaire : « pourquoi la video ne se paie pas au credit ». Une
 * video tourne plusieurs minutes chez xAI ; un redeploiement Railway (chaque
 * poussee sur `main`) tombe pendant. Rendue au demarrage, la reserve d'une video
 * encore en cours laissait xAI facturer une video que personne ne paie (et la
 * reglait une seconde fois si le suivi la retrouvait). Une reserve DURABLE porte
 * son travail (`info` : l'identifiant xAI, l'heure de depart, la liste) dans le
 * MEME fichier que le solde, ecrit en une fois : elle n'est PAS rendue au
 * demarrage ; le suivi repris (studio_media.reprendVideos) la regle une fois,
 * a la fin de la video. Une reserve durable sans identifiant xAI (arret entre la
 * reserve et la reponse d'xAI) est rendue par la reprise ; une plus vieille que
 * DURABLE_MAX_MS l'est des le demarrage, quoi qu'il arrive. Releve du 14/10 :
 * aucune video n'est encore payee au credit — ces bornes sont celles du suivi
 * (STUDIO_VIDEO_MAX_MS, 15 min) et une marge, pas une mesure.
 * ================================================================== */
const fs = require('fs');
const path = require('path');

const MIN_RECHARGE_USD = 0.1;
const MAX_RECHARGE_USD = 50;
const MAX_SOLDE_USD = () => { const v = Number(process.env.CREDIT_MAX_USD); return v > 0 ? v : 100; };
const MICRO = 1e6;
const UN_18 = 10n ** 12n;                  /* 1 micro-dollar en unites 18 decimales (cours 1) */
const versMicro = (usd) => Math.round(Number(usd) * MICRO);
const versUsd = (m) => Math.round(m) / MICRO;
/* Une reserve durable plus vieille que ca est rendue au demarrage, suivie ou non : le suivi d'une
   video abandonne a STUDIO_VIDEO_MAX_MS (15 min par defaut) ; 2 h couvre un arret long. */
const DURABLE_MAX_MS = () => { const v = Number(process.env.CREDIT_DURABLE_MAX_MS); return v > 0 ? v : 2 * 60 * 60 * 1000; };

/**
 * deps : { dossier, x402() → l'instance x402 ou null, url (URL publique de /credit/topup), maintenant?, note?(evenement, info) }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const fEtat = deps.dossier ? path.join(deps.dossier, 'credits.json') : null;
  const fJournal = deps.dossier ? path.join(deps.dossier, 'credits_journal.jsonl') : null;
  const MESURE = { recharges: 0, rechargesUsd: 0, reserves: 0, factureUsd: 0, refus: 0, rendusAuDemarrage: 0,
    durablesGardees: 0, durablesRenduesAuDemarrage: 0, durablesReglees: 0 };
  /* E.soldes : addr → micro-dollars ; E.ouvertes : id → { addr, micro, durable?, t?, info? } ; E.tx : transaction → 1 */
  let E = { soldes: {}, ouvertes: {}, tx: {}, seq: 0 };
  try { if (fEtat) E = Object.assign(E, JSON.parse(fs.readFileSync(fEtat, 'utf8')) || {}); } catch (e) { /* premier demarrage */ }
  const journal = (l) => {
    if (!fJournal) return;
    try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.appendFileSync(fJournal, JSON.stringify(Object.assign({ t: maintenant() }, l)) + '\n'); } catch (e) { /* jamais bloquant */ }
  };
  /* Ecriture atomique : un fichier a moitie ecrit ne doit jamais remplacer le bon. */
  const ecrit = () => {
    if (!fEtat) return;
    try {
      fs.mkdirSync(deps.dossier, { recursive: true });
      fs.writeFileSync(fEtat + '.tmp', JSON.stringify(E));
      fs.renameSync(fEtat + '.tmp', fEtat);
    } catch (e) { console.error('[credits] write failed: ' + (e && e.code || e)); }
  };
  /* Les reserves restees ouvertes (arret pendant une reponse) : rendues — sauf une reserve
     DURABLE de moins de DURABLE_MAX_MS, dont le travail est repris et la reglera. */
  {
    const t = maintenant();
    let change = false;
    for (const [id, o] of Object.entries(E.ouvertes)) {
      if (o.durable && t - (Number(o.t) || 0) < DURABLE_MAX_MS()) { MESURE.durablesGardees++; continue; }
      E.soldes[o.addr] = (E.soldes[o.addr] || 0) + o.micro;
      if (o.durable) MESURE.durablesRenduesAuDemarrage++; else MESURE.rendusAuDemarrage++;
      journal({ sorte: o.durable ? 'rendu_durable_expire' : 'rendu_demarrage', addr: o.addr, micro: o.micro, id });
      delete E.ouvertes[id];
      change = true;
    }
    if (change) ecrit();
  }

  const cle = (a) => String(a || '').toLowerCase();
  const soldeMicro = (a) => E.soldes[cle(a)] || 0;

  /** Reserver `micro` sur le credit de `a` : un jeton, ou null si le credit ne suffit pas.
      `info` (objet) : la reserve est DURABLE — gardee a un redemarrage, avec ce qu'il faut pour
      reprendre son travail. */
  function reserveMicro(a, micro, info) {
    const k = cle(a);
    micro = Math.ceil(micro);
    if (!(micro > 0) || soldeMicro(k) < micro) { MESURE.refus++; return null; }
    E.soldes[k] -= micro;
    const id = 'r' + (++E.seq);
    E.ouvertes[id] = info && typeof info === 'object' ? { addr: k, micro, durable: true, t: maintenant(), info: Object.assign({}, info) } : { addr: k, micro };
    MESURE.reserves++;
    ecrit();
    return id;
  }
  /** Regler une reserve : facturer `microFacture` (borne a la reserve), rendre le reste. */
  function regleMicro(id, microFacture, quoi) {
    const o = E.ouvertes[id];
    if (!o) return null;
    const f = Math.max(0, Math.min(o.micro, Math.ceil(Number(microFacture) || 0)));
    E.soldes[o.addr] = (E.soldes[o.addr] || 0) + (o.micro - f);
    delete E.ouvertes[id];
    if (f > 0) { MESURE.factureUsd += versUsd(f); journal({ sorte: 'debit', addr: o.addr, micro: f, quoi: String(quoi || '').slice(0, 60) }); }
    if (o.durable) MESURE.durablesReglees++;
    ecrit();
    return versUsd(E.soldes[o.addr]);
  }
  /* 10^18 unites (cours 1) → micro-dollars, arrondi au micro-dollar SUPERIEUR (jamais sous le cout). */
  const weiVersMicro = (w) => Number((BigInt(String(w)) + UN_18 - 1n) / UN_18);

  /**
   * Le solde d'un travail LONG (une video) : reserves durables. reserve(a, w, info) rend l'identifiant
   * de la reserve (ou null) ; attache(id, info) y ajoute l'identifiant du fournisseur des qu'il est
   * connu ; regleJeton(id, fw) regle CETTE reserve, une seule fois (null ensuite), et rend le credit.
   */
  function soldeDurable(quoi) {
    return {
      durable: true,
      cours: async () => 1,
      reserve: (a, w, info) => reserveMicro(a, weiVersMicro(w), Object.assign({ quoi: String(quoi || '') }, info || {})),
      attache: (id, info) => {
        const o = E.ouvertes[id];
        if (!o || !o.durable) return false;
        o.info = Object.assign({}, o.info, info);
        ecrit();
        return true;
      },
      regleJeton: (id, fw) => {
        const s = regleMicro(id, weiVersMicro(fw || 0), quoi);
        return s === null ? null : String(s);
      },
    };
  }
  /** Les reserves durables encore ouvertes (relues au demarrage), pour reprendre leur travail. */
  const durables = () => Object.entries(E.ouvertes).filter(([, o]) => o.durable)
    .map(([id, o]) => ({ id, addr: o.addr, micro: o.micro, t: o.t, info: Object.assign({}, o.info) }));

  /**
   * Le solde au format du chat (studio_chat.repond) : cours 1, donc 1 $ = 10^18 unites.
   * reserve(a, w) / regle(a, rw, fw) comme game.studioReserve / studioRegle ; une seule
   * reserve ouverte par (adresse, montant) a la fois suffit, EN_VOL borne le reste.
   */
  function soldeChat(quoi) {
    const ouvertes = new Map();                /* addr|rw → [id] */
    return {
      cours: async () => 1,
      reserve: (a, w) => {
        const micro = Number((BigInt(String(w)) + UN_18 - 1n) / UN_18);
        const id = reserveMicro(a, micro);
        if (!id) return false;
        const k = cle(a) + '|' + String(w);
        ouvertes.set(k, (ouvertes.get(k) || []).concat([id]));
        return true;
      },
      regle: (a, rw, fw) => {
        const k = cle(a) + '|' + String(rw);
        const l = ouvertes.get(k) || [];
        const id = l.shift();
        if (l.length) ouvertes.set(k, l); else ouvertes.delete(k);
        if (!id) return String(soldeUsd(a));
        const micro = Number((BigInt(String(fw)) + UN_18 - 1n) / UN_18);
        return String(regleMicro(id, micro, quoi));
      },
    };
  }

  /** La facture d'une embauche ou d'un achat de l'agent (meme forme que factuEmbauche du serveur). */
  function factu(a, quoi) {
    return {
      reserve: async (usd) => {
        const id = reserveMicro(a, Math.ceil(Number(usd) * MICRO));
        if (!id) return { ok: false, raison: 'your credit is too low to ' + (quoi || 'hire this service') + ' ($' + (Math.ceil(Number(usd) * 100) / 100).toFixed(2) + ' needed) - top it up with a wallet signature' };
        return { ok: true, jeton: { id } };
      },
      regle: async (j, usd) => { if (j && j.id) regleMicro(j.id, usd > 0 ? Math.ceil(Number(usd) * MICRO) : 0, quoi); },
    };
  }

  const soldeUsd = (a) => versUsd(soldeMicro(a));

  /** Le montant d'une recharge, valide : 0,10 $ a 50 $, au cent ; null sinon. */
  function montant(usd) {
    const v = Math.round(Number(usd) * 100) / 100;
    return v >= MIN_RECHARGE_USD && v <= MAX_RECHARGE_USD ? v : null;
  }
  /** Le prix x402 de la recharge (appele par x402.prix) : le montant lui-meme. */
  const prixUsd = (args) => montant(args && args.usd);

  /** Ajouter au credit, une seule fois par transaction. Rend le solde, ou null si deja credite.
      Depot Relay (14/10, credit_depot.js) : `recu.cle` (« relay:<tx Base>:<index du journal> ») est
      l'anti-doublon et `recu.micro` le montant ENTIER en micro-dollars lu dans le recu — `usd` est
      alors ignore. La transaction elle-meme (`recu.transaction`) est refusee si x402 l'a deja
      creditee : une meme arrivee d'USDC ne se compte jamais par les deux chemins. */
  function ajoute(a, usd, recu) {
    /* Une signature Solana est en base58 : la casse en fait partie (13/10 : le journal gardait
       `5kgnq9kz…`, une signature qu'aucun explorateur ne retrouve). Un hash 0x reste en minuscules.
       L'anti-doublon regarde aussi la forme en minuscules, celle des recharges Solana d'avant. */
    const brut = String((recu && recu.transaction) || '');
    const tx = /^0x/i.test(brut) ? brut.toLowerCase() : brut;
    const parCle = !!(recu && recu.cle);
    const id = parCle ? String(recu.cle).toLowerCase() : tx;
    if (!id) return null;
    if (E.tx[id] || E.tx[id.toLowerCase()]) return null;
    /* La transaction elle-meme : refusee si x402 l'a creditee (marque 1) ; une marque 'relay' (un
       autre journal de la MEME livraison, deja credite par sa propre cle) ne bloque pas. */
    if (parCle && tx && ((E.tx[tx] && E.tx[tx] !== 'relay') || (E.tx[tx.toLowerCase()] && E.tx[tx.toLowerCase()] !== 'relay'))) return null;
    let micro;
    if (parCle) {
      micro = Number(recu.micro);
      if (!Number.isSafeInteger(micro) || micro <= 0) return null;
    } else micro = versMicro(usd);
    const k = cle(a);
    E.tx[id] = 1;
    /* Une livraison Relay marque aussi sa transaction : x402 ne la creditera jamais une seconde fois. */
    if (parCle && tx && !E.tx[tx]) E.tx[tx] = 'relay';
    E.soldes[k] = (E.soldes[k] || 0) + micro;
    MESURE.recharges++; MESURE.rechargesUsd += versUsd(micro);
    journal({ sorte: 'recharge', addr: k, micro, tx: tx || id, reseau: (recu && recu.network) || null });
    ecrit();
    return versUsd(E.soldes[k]);
  }
  /** Deja credite sous cette cle (ou cette transaction) ? Lecture seule : 1 (x402 ou cle Relay),
      'relay' (transaction d'une livraison Relay deja creditee), ou false. */
  const dejaCredite = (k) => { const s = String(k || ''); return (s && (E.tx[s] || E.tx[s.toLowerCase()])) || false; };
  /** Le solde en micro-dollars entiers (les bornes d'un depot se comparent sans flottant). */
  const soldeMicroDe = (a) => soldeMicro(a);

  /**
   * La recharge en x402 : sans signature, le 402 ; avec, x402.traite verifie, `sert` accepte
   * (rien n'est encore credite), x402 regle, et SEULEMENT sur 200 le credit est ajoute.
   * addr : l'adresse de SESSION (jamais une adresse du corps ou du payeur).
   */
  async function recharge({ entete, usd, addr, qui, client }) {
    const json = (status, o) => ({ status, entetes: { 'content-type': 'application/json' }, corps: JSON.stringify(o) });
    const x = deps.x402 && deps.x402();
    if (!x) return json(503, { ok: false, raison: 'wallet payments are not available right now' });
    const v = montant(usd);
    if (v === null) return json(400, { ok: false, raison: 'amount must be between $' + MIN_RECHARGE_USD.toFixed(2) + ' and $' + MAX_RECHARGE_USD });
    const k = cle(addr);
    if (versMicro(v) + soldeMicro(k) > versMicro(MAX_SOLDE_USD())) return json(400, { ok: false, raison: 'your credit would go above $' + MAX_SOLDE_USD() + ' - spend some first' });
    /* `sert` ne credite pas : il porte l'adresse et le montant jusqu'au reglement. */
    const sert = async () => ({ ok: true, credit: { addr: k, usd: v } });
    /* `lien` : la session. Un reglement « en attente » (Base ou Solana) n est repris que par la
       session qui l a demande ; une autre qui represente la meme signature est refusee, et
       l attente reste a la premiere (credit_solana_attente.test.js). */
    const r = await x.traite({ outil: 'credit', url: deps.url, entete: entete || null, sert, args: { usd: v }, canal: 'rest', qui, client, lien: k });
    if (r.status !== 200) return r;
    let c;
    try { c = JSON.parse(r.corps); } catch (e) { c = null; }
    const cr = c && c.credit;
    const recu = c && c.x402;
    if (!cr || !cr.addr || !recu) return json(502, { ok: false, raison: 'the payment settled but its credit could not be read - contact support with transaction ' + String((recu && recu.transaction) || '?') });
    /* cr.addr : la session du PREMIER appel, fixee par le serveur (un reglement en attente
       represente plus tard rend ce resultat retenu) — jamais une adresse du corps. */
    const s = ajoute(cr.addr, cr.usd, recu);
    return json(200, { ok: true, creditedUsd: s === null ? 0 : cr.usd, balanceUsd: soldeUsd(k), alreadyCredited: s === null, x402: recu });
  }

  /** Les dernieres lignes du journal d'une adresse (recharges et debits), les plus recentes d'abord. */
  function historique(a, n) {
    if (!fJournal) return [];
    const k = cle(a);
    let l = [];
    try { l = fs.readFileSync(fJournal, 'utf8').split('\n').filter(Boolean).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter((x) => x && x.addr === k); } catch (e) { l = []; }
    return l.slice(-(n || 20)).reverse().map((x) => ({ at: new Date(x.t).toISOString(), kind: x.sorte === 'recharge' ? 'top-up' : x.sorte === 'debit' ? 'spent' : 'refund',
      usd: versUsd(x.micro), what: x.quoi || null, tx: x.tx || null, network: x.reseau || null }));
  }

  return { soldeUsd, soldeChat, soldeDurable, durables, factu, recharge, ajoute, dejaCredite, soldeMicro: soldeMicroDe, prixUsd, montant, historique, MESURE,
    etat: () => ({ comptes: Object.keys(E.soldes).filter((k) => E.soldes[k] > 0).length, totalUsd: versUsd(Object.values(E.soldes).reduce((a, b) => a + b, 0)),
      ouvertes: Object.keys(E.ouvertes).length, durables: Object.values(E.ouvertes).filter((o) => o.durable).length, mesure: Object.assign({}, MESURE) }),
    LIMITES: { minUsd: MIN_RECHARGE_USD, maxUsd: MAX_RECHARGE_USD, maxSoldeUsd: MAX_SOLDE_USD() } };
}

module.exports = { cree, MIN_RECHARGE_USD, MAX_RECHARGE_USD };
