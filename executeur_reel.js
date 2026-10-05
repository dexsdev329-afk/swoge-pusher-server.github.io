'use strict';
/* ==================================================================
 * L'EXECUTEUR REEL — RACHAT-ET-BRULE — INERTE PAR DEFAUT (8c, piece 2/6)
 * ==================================================================
 *
 * Le squelette de l'execution REELLE on-chain. Jusqu'ici tout le trader est en
 * papier (pare_feu -> policy -> signer_papier) : rien ne depense de crypto. Cette
 * piece est le seul endroit du code qui POURRAIT signer une vraie transaction avec
 * l'argent du jeton. Elle est posee INERTE : tant que le proprietaire n'a pas donne
 * son feu vert, elle refuse tout et ne touche a rien.
 *
 * TROIS verrous, tous requis AVANT le moindre geste reel (demande du proprietaire) :
 *
 *   1. LE DRAPEAU  — `AGENT_TRADER_EXECUTE=1`. Absent => inerte.
 *   2. LA CLE DEDIEE — `AGENT_CLE`, un signataire ISOLE, propre a l'agent trader.
 *      Ce n'est JAMAIS `MIROIR_CLE` (l'argent des joueurs). Deux cles, deux bourses :
 *      le rachat de l'agent et le miroir ne partagent jamais de signataire. On ne lit
 *      ici que sa PRESENCE ; la cle elle-meme ne vit que dans l'environnement de
 *      l'hote, jamais dans le depot, jamais dans une reponse, jamais dans un journal.
 *   3. LE JETON D'ESSAI — `AGENT_TRADER_TOKEN_TEST` (liste blanche). Le reel commence
 *      sur UN jeton d'essai nomme explicitement. Liste vide => aucun jeton ne passe,
 *      meme drapeau et cle poses (fail-closed : « sur un jeton d'essai d'abord »).
 *
 * Et un QUATRIEME, cable par le feu vert lui-meme : le VRAI envoyeur on-chain
 * (`deps.envoie`) n'est PAS branche dans le serveur. Meme drapeau + cle + jeton
 * d'essai alignes, sans envoyeur cable l'executeur refuse. Brancher l'envoyeur est
 * le dernier geste, delibere, du proprietaire — pas un defaut.
 *
 * RACHAT-ET-BRULE SEULEMENT : la seule action reelle permise est `buyback`. Toute
 * autre action (vente, airdrop, swap) est refusee ici, quel que soit l'etat des
 * verrous. L'agent rachete son propre jeton et le brule ; il ne vend jamais en reel.
 *
 * Les garde-fous du signer papier sont repris a l'identique AVANT l'envoi : on ne
 * signe que ce qui CORRESPOND a l'intention approuvee (meme pool, jamais une adresse
 * d'un message), on resimule (devis reel), et si l'impact-prix live depasse le
 * plafond approuve, on refuse. Pur + injectable : aucun essai ne sort de la machine,
 * aucun essai ne signe quoi que ce soit.
 * ================================================================== */

const bas = (a) => String(a).toLowerCase();
const estAdr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));
const rond = (x) => Math.round(Number(x) * 1e6) / 1e6;

/* La liste blanche des jetons d'essai : des adresses 0x, en minuscules, dedupliquees. */
function listeJetons(src) {
  const brut = Array.isArray(src) ? src : String(src || '').split(/[,\s]+/);
  const vus = new Set();
  for (const x of brut) { const a = bas(String(x).trim()); if (estAdr(a)) vus.add(a); }
  return vus;
}

/**
 * cree(opts) : l'executeur reel, inerte par defaut.
 * opts : {
 *   execute,     // le drapeau (defaut: process.env.AGENT_TRADER_EXECUTE === '1')
 *   cle,         // PRESENCE de la cle dediee (defaut: process.env.AGENT_CLE) — jamais lue au-dela
 *   jetonsTest,  // liste blanche (defaut: process.env.AGENT_TRADER_TOKEN_TEST, séparée par virgules)
 * }
 */
function cree(opts) {
  opts = opts || {};
  const drapeau = opts.execute != null ? !!opts.execute : (String(process.env.AGENT_TRADER_EXECUTE || '0') === '1');
  /* On ne garde JAMAIS la cle : seulement si elle est posee (non vide). */
  const cleBrute = opts.cle != null ? opts.cle : process.env.AGENT_CLE;
  const clePosee = !!(cleBrute && String(cleBrute).trim());
  const jetons = listeJetons(opts.jetonsTest != null ? opts.jetonsTest : process.env.AGENT_TRADER_TOKEN_TEST);

  /* La raison exacte pour laquelle l'executeur reste inerte (pour l'ecran/l'audit, jamais la cle). */
  function raisonInerte() {
    if (!drapeau) return 'real execution disabled (AGENT_TRADER_EXECUTE is not 1)';
    if (!clePosee) return 'no dedicated signing key provisioned (AGENT_CLE is not set)';
    return null;
  }
  function actif() { return raisonInerte() === null; }

  /**
   * execute(approuve, deps) : tente le geste REEL. Ne signe/n'envoie QUE si tous les
   * verrous sont alignes ET l'envoyeur reel est cable. Sinon, refuse proprement.
   * approuve : { token, action, montantUsd, pool, impactMaxPct }  (l'intention deja approuvee)
   * deps : {
   *   devis(approuve) -> { ok, pool, impactPct, sortie },   // resimulation live (agent_devis via miroir)
   *   envoie(approuve, extra) -> { ok, txHash?, sortie?, ... }  // le VRAI envoi on-chain (cable au feu vert)
   * }
   * Rend { execute:true, mode:'real', recu } ou { execute:false, raison }.
   */
  async function execute(approuve, deps) {
    approuve = approuve || {}; deps = deps || {};
    const refus = (raison) => ({ execute: false, raison });

    /* Verrou 1 & 2 : drapeau + cle dediee. Inerte tant que les deux ne sont pas poses. */
    const ri = raisonInerte();
    if (ri) return refus(ri);

    /* Rachat-et-brule SEULEMENT. Aucune autre action ne passe en reel, jamais. */
    if (String(approuve.action) !== 'buyback') return refus('real execution is buy-back-and-burn only (action refused: ' + String(approuve.action) + ')');

    /* Verrou 3 : le jeton doit etre un jeton d'essai nomme explicitement. */
    if (!estAdr(approuve.token)) return refus('token must be a 0x address');
    if (!jetons.has(bas(approuve.token))) return refus('token is not in the real-execution test allowlist (AGENT_TRADER_TOKEN_TEST)');

    /* Le pool vient de l'intention approuvee (lu au registre en amont), jamais d'un message. */
    if (!estAdr(approuve.pool)) return refus('approved intent has no valid pool');
    const m = rond(approuve.montantUsd);
    if (!(m > 0)) return refus('amount must be positive');

    /* Resimulation live (devis reel) : memes garde-fous que le signer papier. */
    if (typeof deps.devis !== 'function') return refus('no quoter to re-simulate with');
    let d;
    try { d = await deps.devis(approuve); } catch (e) { return refus('simulation failed: ' + String((e && e.message) || e).slice(0, 80)); }
    if (!d || d.ok !== true) return refus('simulation did not succeed');
    if (bas(d.pool) !== bas(approuve.pool)) return refus('pool mismatch: the quote targets a different pool than approved (refused)');
    if (approuve.impactMaxPct != null && Number(d.impactPct) > Number(approuve.impactMaxPct) + 1e-9) return refus('live price impact exceeds the approved ceiling (refused)');

    /* Verrou 4 : le VRAI envoyeur on-chain doit etre cable (dernier geste du proprietaire).
       Non cable => on refuse. C'est ce qui garde l'executeur inerte meme si le drapeau et la
       cle venaient a etre poses sans feu vert explicite. */
    if (typeof deps.envoie !== 'function') return refus('no real on-chain sender wired (awaiting owner go)');

    let r;
    try { r = await deps.envoie(approuve, { devis: d }); } catch (e) { return refus('real send failed: ' + String((e && e.message) || e).slice(0, 80)); }
    if (!r || r.ok !== true) return refus('real send did not succeed' + (r && r.raison ? ': ' + r.raison : ''));
    const recu = { mode: 'real', token: bas(approuve.token), pool: bas(approuve.pool), action: 'buyback',
      montantUsd: m, sortie: d.sortie != null ? rond(d.sortie) : null, impactPct: d.impactPct != null ? rond(d.impactPct) : null,
      txHash: r.txHash || null, quand: Date.now() };
    return { execute: true, mode: 'real', recu };
  }

  return { actif, raisonInerte, execute, jetonsTest: jetons };
}

module.exports = { cree, listeJetons };
