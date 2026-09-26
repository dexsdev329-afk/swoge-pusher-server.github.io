'use strict';
/* ==================================================================
 * LA CAISSE AUTOMATIQUE — 5 % RACHÈTENT DU $SWOGE, LE RESTE À LA TRÉSORERIE
 * ==================================================================
 *
 * Décisions du propriétaire, 26 septembre 2026 : « il faut que tout soit
 * automatique », « que notre application prenne un mini pourcentage pour que,
 * dans le futur, ça aide réellement SWOGE ». Réponses : 5 % de chaque paiement
 * rachètent du $SWOGE, les $SWOGE rachetés sont GARDÉS (envoyés à la
 * trésorerie avec le reste), et la caisse est le PORTEFEUILLE DE GAZ (aucun
 * nouveau wallet).
 *
 * Avec `X402_CAISSE=1`, les agents paient donc le portefeuille de gaz (sa clé
 * est sur le serveur : c'est ce qui rend tout automatique), et chaque tour
 * (`X402_CAISSE_MS`, une heure) :
 *   1. l'USDG arrivé depuis le tour d'avant est partagé : 5 % mis de côté pour
 *      le rachat, 95 % dus à la trésorerie. Les parts sont TENUES dans
 *      DATA_DIR/caisse.json : un paiement n'est jamais partagé deux fois, même
 *      si un versement attend son seuil ou si le serveur redémarre ;
 *   2. la part de rachat, dès RACHAT_MIN_USD, s'échange contre du $SWOGE par le
 *      routeur v2 en UNE transaction (USDG → WETH → $SWOGE) — relevé sur la
 *      chaîne le 26 septembre 2026 : paire v2 USDG/WETH 72 WETH / 194 473 USDG,
 *      1 USDG → 39 741 $SWOGE, soit ~0,5 % de moins que la jambe v3 (0,01 %) —
 *      négligeable pour quelques dollars, et une transaction de gaz en moins.
 *      Minimum de sortie : le devis moins TOLERANCE_BPS (jamais zéro : c'est la
 *      porte ouverte au sandwich). Un échange raté garde la part pour le tour
 *      suivant ;
 *   3. tout le $SWOGE de la caisse (payé par les agents, et racheté) part à la
 *      trésorerie ; l'USDG dû aussi, dès VERSEMENT_MIN_USD.
 * La caisse ne touche JAMAIS à l'ETH (c'est le gaz), n'envoie JAMAIS ailleurs
 * qu'à la trésorerie (`X402_PAYTO`), et entre deux tours n'y reste que ce qui
 * attend son seuil : quelques dollars.
 * ================================================================== */

const fs = require('fs');
const { ethers } = require('ethers');

const PART = () => Math.min(0.5, Math.max(0, Number(process.env.X402_RACHAT_PART === undefined ? 0.05 : process.env.X402_RACHAT_PART)));
const RACHAT_MIN_USD = () => Math.max(0.1, Number(process.env.X402_RACHAT_MIN_USD || 1));
const VERSEMENT_MIN_USD = () => Math.max(0.1, Number(process.env.X402_VERSEMENT_MIN_USD || 1));
const TOLERANCE_BPS = 300;
/* UniswapV2Router02 de Robinhood Chain — le même que le miroir (miroir.js) ; devis
   USDG → WETH → $SWOGE lu par lui sur la chaîne le 26 septembre 2026. */
const ROUTEUR2 = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';
const ECHEANCE_S = 300;
const DECIMALES_USDG = 6;
const B = ethers.BigNumber;

/**
 * deps = { chaine, tresor, usdg, swoge, weth, fichier, maintenant(), journal(l), enFile(fn) }
 * chaine = { caisse (adresse), solde(jeton), allowance(jeton, spender), approuve(jeton, spender),
 *            devis(montant, chemin) → BigNumber, echange(montant, mini, chemin, vers, echeance) → { ok, hash },
 *            envoie(jeton, vers, montant) → { ok, hash }, routeur (adresse) }
 */
function cree(deps) {
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const enFile = deps.enFile || ((fn) => fn());
  let etat = { rachat: '0', versement: '0', rachats: 0, usdgRachete: '0', swogeRachete: '0', versements: 0, usdgVerse: '0', swogeVerse: '0', dernier: null, anomalies: 0 };
  try { etat = Object.assign(etat, JSON.parse(fs.readFileSync(deps.fichier, 'utf8'))); } catch (e) { /* premier tour */ }
  const sauve = () => { try { fs.writeFileSync(deps.fichier + '.tmp', JSON.stringify(etat)); fs.renameSync(deps.fichier + '.tmp', deps.fichier); } catch (e) { console.error('[caisse] sauvegarde : ' + e.message); } };
  const usd = (u) => Number(ethers.utils.formatUnits(u, DECIMALES_USDG));
  const unites = (d) => B.from(Math.round(d * 10 ** DECIMALES_USDG));
  let enCours = false;

  /** Un tour de caisse. Rend ce qui a été fait (et le journalise). */
  async function tour() {
    if (enCours) return { ok: false, raison: 'already running' };
    enCours = true;
    const fait = { t: maintenant(), partage: null, rachat: null, versementUsdg: null, versementSwoge: null, erreurs: [] };
    try {
      /* 1. PARTAGER ce qui est arrivé : solde USDG − ce qui est déjà partagé. */
      const solde = B.from(await deps.chaine.solde(deps.usdg));
      let rachat = B.from(etat.rachat), versement = B.from(etat.versement);
      const tenu = rachat.add(versement);
      if (solde.lt(tenu)) {
        /* Moins que ce qu'on croyait tenir (ne devrait pas arriver) : on se recale sur
           la chaîne, rachat d'abord, et on le COMPTE — à lire avant de chercher ailleurs. */
        etat.anomalies++;
        rachat = rachat.gt(solde) ? solde : rachat;
        versement = solde.sub(rachat);
        console.error('[caisse] ANOMALIE : solde USDG ' + usd(solde) + ' < parts tenues ' + usd(tenu));
      } else {
        const nouveau = solde.sub(tenu);
        if (nouveau.gt(0)) {
          const part = nouveau.mul(Math.round(PART() * 10000)).div(10000);
          rachat = rachat.add(part); versement = versement.add(nouveau.sub(part));
          fait.partage = { nouveauUsd: usd(nouveau), rachatUsd: usd(part), versementUsd: usd(nouveau.sub(part)) };
        }
      }
      etat.rachat = rachat.toString(); etat.versement = versement.toString(); sauve();

      /* 2. RACHETER dès le seuil : USDG → WETH → $SWOGE, en une transaction, vers la caisse. */
      if (rachat.gte(unites(RACHAT_MIN_USD()))) {
        try {
          const chemin = [deps.usdg, deps.weth, deps.swoge];
          const devis = B.from(await deps.chaine.devis(rachat, chemin));
          if (devis.lte(0)) throw new Error('empty quote');
          const mini = devis.mul(10000 - TOLERANCE_BPS).div(10000);
          const avant = B.from(await deps.chaine.solde(deps.swoge));
          if (B.from(await deps.chaine.allowance(deps.usdg, deps.chaine.routeur)).lt(rachat)) {
            const a = await enFile(() => deps.chaine.approuve(deps.usdg, deps.chaine.routeur));
            if (!a || !a.ok) throw new Error('approve failed');
          }
          const x = await enFile(() => deps.chaine.echange(rachat, mini, chemin, deps.chaine.caisse, Math.floor(maintenant() / 1000) + ECHEANCE_S));
          if (!x || !x.ok) throw new Error('swap reverted');
          const recu = B.from(await deps.chaine.solde(deps.swoge)).sub(avant);
          fait.rachat = { usdgUsd: usd(rachat), swoge: ethers.utils.formatEther(recu), devis: ethers.utils.formatEther(devis), hash: x.hash };
          etat.rachats++;
          etat.usdgRachete = B.from(etat.usdgRachete).add(rachat).toString();
          etat.swogeRachete = B.from(etat.swogeRachete).add(recu.gt(0) ? recu : 0).toString();
          rachat = B.from(0); etat.rachat = '0'; sauve();
        } catch (e) { fait.erreurs.push('buyback: ' + String(e && (e.reason || e.message) || e).slice(0, 120)); }
      }

      /* 3. VERSER à la trésorerie : tout le $SWOGE, et l'USDG dû dès le seuil. */
      const swoge = B.from(await deps.chaine.solde(deps.swoge));
      if (swoge.gt(0)) {
        try {
          const x = await enFile(() => deps.chaine.envoie(deps.swoge, deps.tresor, swoge));
          if (!x || !x.ok) throw new Error('transfer reverted');
          fait.versementSwoge = { swoge: ethers.utils.formatEther(swoge), hash: x.hash };
          etat.swogeVerse = B.from(etat.swogeVerse).add(swoge).toString(); etat.versements++; sauve();
        } catch (e) { fait.erreurs.push('SWOGE transfer: ' + String(e && (e.reason || e.message) || e).slice(0, 120)); }
      }
      if (versement.gte(unites(VERSEMENT_MIN_USD()))) {
        try {
          const x = await enFile(() => deps.chaine.envoie(deps.usdg, deps.tresor, versement));
          if (!x || !x.ok) throw new Error('transfer reverted');
          fait.versementUsdg = { usd: usd(versement), hash: x.hash };
          etat.usdgVerse = B.from(etat.usdgVerse).add(versement).toString(); etat.versements++;
          etat.versement = '0'; sauve();
        } catch (e) { fait.erreurs.push('USDG transfer: ' + String(e && (e.reason || e.message) || e).slice(0, 120)); }
      }
    } catch (e) {
      fait.erreurs.push(String(e && (e.reason || e.message) || e).slice(0, 160));
    } finally {
      enCours = false;
    }
    etat.dernier = fait; sauve();
    if (deps.journal && (fait.partage || fait.rachat || fait.versementSwoge || fait.versementUsdg || fait.erreurs.length)) deps.journal(fait);
    return Object.assign({ ok: !fait.erreurs.length }, fait);
  }

  /** L'état public : ce qui attend, ce qui a été racheté et versé. Jamais une clé. */
  function vue() {
    return { actif: true, caisse: deps.chaine.caisse, tresor: deps.tresor, part: PART(), rachatMinUsd: RACHAT_MIN_USD(), versementMinUsd: VERSEMENT_MIN_USD(),
      enAttente: { rachatUsd: usd(etat.rachat), versementUsd: usd(etat.versement) },
      rachats: etat.rachats, usdgRacheteUsd: usd(etat.usdgRachete), swogeRachete: ethers.utils.formatEther(etat.swogeRachete),
      versements: etat.versements, usdgVerseUsd: usd(etat.usdgVerse), swogeVerse: ethers.utils.formatEther(etat.swogeVerse),
      anomalies: etat.anomalies, dernierTour: etat.dernier };
  }

  return { tour, vue, etat: () => etat };
}

/** Le lien réel (ethers v5), sur le portefeuille de gaz : la clé ne sort jamais d'ici. */
function chaineEthers({ wallet, routeur }) {
  const p = wallet.provider;
  const ERC = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)'];
  const R2 = new ethers.Contract(routeur, ['function getAmountsOut(uint256,address[]) view returns (uint256[])',
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)'], wallet);
  const jeton = (a) => new ethers.Contract(a, ERC, wallet);
  /* Le prix du gaz lu +20 %, en transaction classique (règle du miroir). */
  const frais = async (g) => ({ gasLimit: g, gasPrice: (await p.getGasPrice()).mul(12).div(10) });
  const attend = async (tx) => { const rc = await tx.wait(1); return { ok: rc.status === 1, hash: tx.hash }; };
  return {
    caisse: wallet.address, routeur,
    solde: (j) => jeton(j).balanceOf(wallet.address),
    allowance: (j, s) => jeton(j).allowance(wallet.address, s),
    approuve: async (j, s) => attend(await jeton(j).approve(s, ethers.constants.MaxUint256, await frais(80000))),
    devis: async (m, chemin) => { const a = await R2.getAmountsOut(m, chemin); return a[a.length - 1]; },
    echange: async (m, mini, chemin, vers, ech) => {
      await R2.callStatic.swapExactTokensForTokensSupportingFeeOnTransferTokens(m, mini, chemin, vers, ech);   /* simulé d'abord */
      return attend(await R2.swapExactTokensForTokensSupportingFeeOnTransferTokens(m, mini, chemin, vers, ech, await frais(400000)));
    },
    envoie: async (j, vers, m) => attend(await jeton(j).transfer(vers, m, await frais(120000))),
  };
}

module.exports = { cree, chaineEthers, ROUTEUR2, PART, RACHAT_MIN_USD, VERSEMENT_MIN_USD, TOLERANCE_BPS };
