'use strict';
/* ==================================================================
 * TOKEN_VERDICT — LE VERDICT RAPIDE D'UN JETON (etape 3 du plan, 27/09/2026)
 * ==================================================================
 *
 * Pourquoi : le catalogue PayAI (releve complet du 27/09) liste 1 206
 * services d'analyse de jetons ou de trading, prix median 0,01 $ (25 % a
 * 0,003 $, 75 % a 0,05 $). scan_token rend tout (0,02 $) ; un agent qui doit
 * decider vite veut UNE reponse qu'il peut brancher, et ses raisons.
 *
 * Ce module ne lit rien : il juge la fiche que studio_jeton a deja lue
 * (DexScreener, GoPlus, colonie), sans appel ni cout de plus. Chaque signal
 * porte sa source ; une regle qui n'est pas un fait brut porte sa mesure :
 *   - GoPlus : ses propres drapeaux, tels quels. Rouges : ceux qui empechent
 *     de revendre ou donnent la main sur les soldes (honeypot, vente ou achat
 *     bloque, soldes modifiables, createur deja auteur d'un honeypot).
 *     Prudence : les pouvoirs qui PEUVENT servir contre le porteur (mint,
 *     pause, liste noire, proxy, proprietaire cache ou repris, code non
 *     verifie), une taxe non nulle, une taxe inconnue. Aucun seuil invente :
 *     la taxe est rendue telle quelle, l'agent juge.
 *   - La piscine, sur Robinhood Chain seulement (la ou la colonie l'a mesuree) :
 *     sous LIQ_ACHAT_MIN (13 000 $), prudence. Mesure du carnet de la colonie
 *     (ai_colonie.js, 16/09/2026, trades papier par piscine d'achat) : 6-13k,
 *     28 trades, -7,8 % de moyenne, 29 % de gagnants ; 13-25k, 106 trades,
 *     +1,2 %, 46 %.
 *   - La colonie : un trait de CE jeton dont les jetons passes ont fait en
 *     moyenne moins de 0 a 30 minutes, sur au moins OBS_ASSEZ (30)
 *     observations, est une prudence, avec son effectif. En dessous, une
 *     poignee de jetons : de la chance, pas un resultat — non compte.
 *
 * Le verdict : `red_flags` si un rouge ; sinon `unknown` si le marche ou la
 * securite n'ont pas ete lus (inconnu n'est jamais une bonne nouvelle) ;
 * sinon `caution` s'il reste un signal ; sinon `no_red_flag_found` — jamais
 * « safe », ni un signal d'achat ou de vente.
 * ================================================================== */

const Jeton = require('./studio_jeton');

const liqMin = () => { const v = Number(process.env.LIQ_ACHAT_MIN); return v > 0 ? v : 13000; };
const MESURE_LIQ = 'SWOGE AI colony paper trades by pool size at buy (16 Sep 2026): pools $6-13k, 28 trades, -7.8% average, 29% winners; $13-25k, 106 trades, +1.2%, 46% winners';
const NOTE = 'Measurements, never a buy or sell signal. no_red_flag_found means none of these checks fired, not that the token is safe; unknown stays unknown.';

function juge(f) {
  const flags = [];
  const drapeau = (level, code, text, source) => flags.push({ level, code, text, source });
  const m = f && f.marche, s = f && f.securite;
  let illisible = false;

  if (!m) {
    illisible = true;
    drapeau('unknown', 'not_found', (f && f.manque && f.manque.includes('DexScreener')) ? 'the DexScreener lookup failed' : 'no pool found on DexScreener', 'DexScreener');
  } else {
    if (!s) { illisible = true; drapeau('unknown', 'security_unavailable', 'the GoPlus lookup failed', 'GoPlus'); }
    else if (!s.couverte) { illisible = true; drapeau('unknown', 'security_not_covered', 'GoPlus does not cover ' + m.chaine, 'GoPlus'); }
    else if (!s.connu) { illisible = true; drapeau('unknown', 'security_no_record', 'GoPlus has no record of this token yet', 'GoPlus'); }
    else {
      const R = [['honeypot', 'honeypot', 'flagged as a honeypot'], ['venteBloquee', 'cannot_sell_all', 'holders cannot sell all their tokens'],
        ['achatBloque', 'cannot_buy', 'buying is blocked'], ['soldeModifiable', 'owner_can_change_balance', 'the owner can change balances'],
        ['memeCreateurHoneypot', 'creator_made_honeypot', 'the creator made a honeypot before']];
      const C = [['mint', 'mintable', 'the owner can mint'], ['pause', 'pausable', 'transfers can be paused'], ['listeNoire', 'blacklist', 'the contract has a blacklist'],
        ['proxy', 'upgradeable_proxy', 'upgradeable proxy: the code can change'], ['proprioCache', 'hidden_owner', 'hidden owner'],
        ['reprendPropriete', 'ownership_can_be_taken_back', 'ownership can be taken back']];
      for (const [k, code, t] of R) if (s[k] === true) drapeau('red', code, t, 'GoPlus');
      for (const [k, code, t] of C) if (s[k] === true) drapeau('caution', code, t, 'GoPlus');
      if (s.codeOuvert === false) drapeau('caution', 'unverified_code', 'source code not verified', 'GoPlus');
      if (s.taxeAchat > 0) drapeau('caution', 'buy_tax', 'buy tax ' + s.taxeAchat + '%', 'GoPlus');
      if (s.taxeVente > 0) drapeau('caution', 'sell_tax', 'sell tax ' + s.taxeVente + '%', 'GoPlus');
      if (s.taxeAchat == null || s.taxeVente == null) drapeau('unknown', 'tax_unknown', 'buy or sell tax not reported by GoPlus', 'GoPlus');
      if (s.lpVerrouillee === 0) drapeau('caution', 'lp_not_locked', 'no LP locked or burnt', 'GoPlus');
    }
    /* L'identite (28/09) : un jeton qui copie le symbole ou le nom d'une action tokenisee
       officielle n'est PAS cette action — Robinhood l'ecrit (docs.robinhood.com/chain/contracts).
       Rouge, comme ce qui empeche de revendre : l'acheteur ne detient pas ce qu'il croit.
       Releve du 28/09 : une copie de NVDA a 0,000000324 $ et 30 386 $ de liquidite. */
    if (f.action && f.action.imposteur) drapeau('red', 'impostor_stock_token', 'copies the ticker or name of the Robinhood Stock Token ' + f.action.symbole
      + ' but is not it — the official contract is ' + f.action.adresse, 'Robinhood official stock token list');
    if (m.chaine === 'robinhood') {
      if (m.liqUsd == null) drapeau('unknown', 'liquidity_unknown', 'pool liquidity not reported', 'DexScreener');
      else if (m.liqUsd < liqMin()) drapeau('caution', 'thin_pool', 'pool liquidity $' + Math.round(m.liqUsd).toLocaleString('en-US') + ', under the $'
        + liqMin().toLocaleString('en-US') + ' the SWOGE AI colony requires to buy — ' + MESURE_LIQ, 'DexScreener + SWOGE AI colony');
    }
  }

  let colonie = null;
  if (f && f.colonie) {
    const brutes = Array.isArray(f.colonie.toutes) ? f.colonie.toutes : (f.colonie.cases || []);
    const lignes = require('./carte_scan').casesEnAnglais(brutes).map((c) => ({ trait: c.traitLabel, case: c.label, observations: c.n, averagePct: c.moyenne }));
    const assez = lignes.filter((c) => c.observations >= Jeton.OBS_ASSEZ);
    const negatifs = assez.filter((c) => c.averagePct < 0).sort((a, b) => a.averagePct - b.averagePct);
    for (const c of negatifs.slice(0, 5)) drapeau('caution', 'colony_negative_trait', c.trait + ' = ' + c.case + ': past tokens with this trait moved '
      + c.averagePct + '% on average in 30 minutes, over ' + c.observations.toLocaleString('en-US') + ' observations', 'SWOGE AI colony');
    colonie = { observations: f.colonie.observations || 0, horizonMinutes: f.colonie.echeance || 30, minObservations: Jeton.OBS_ASSEZ,
      negativeTraits: negatifs.slice(0, 5), positiveTraits: assez.filter((c) => c.averagePct > 0).sort((a, b) => b.averagePct - a.averagePct).slice(0, 5),
      scan: f.colonie.scan || null };
  }

  const rouges = flags.filter((x) => x.level === 'red').length;
  const verdict = rouges ? 'red_flags' : illisible ? 'unknown' : flags.length ? 'caution' : 'no_red_flag_found';
  const resume = verdict === 'red_flags' ? rouges + ' red flag' + (rouges > 1 ? 's' : '') + ': ' + flags.filter((x) => x.level === 'red').map((x) => x.text).join('; ')
    : verdict === 'unknown' ? 'not enough data read to judge: ' + flags.filter((x) => x.level === 'unknown').map((x) => x.text).join('; ')
    : verdict === 'caution' ? flags.length + ' point' + (flags.length > 1 ? 's' : '') + ' to check: ' + flags.map((x) => x.code).join(', ')
    : 'none of the checks fired (GoPlus flags' + (m && m.chaine === 'robinhood' ? ', pool size, SWOGE AI colony traits' : '') + ') — not a statement that the token is safe';
  return {
    token: { address: f && f.adresse, symbol: (m && m.sym) || null, name: (m && m.nom) || null, chain: (m && m.chaine) || null, priceUsd: m ? m.prixUsd : null,
      liquidityUsd: m ? m.liqUsd : null, marketCapUsd: m ? m.mcUsd : null, poolAgeDays: m ? m.ageJours : null, url: (m && m.url) || null },
    verdict, summary: resume, flags, colony: colonie,
    attribution: s && s.couverte ? { security: Jeton.ATTRIBUTION.security, url: Jeton.ATTRIBUTION.url } : null,
    note: NOTE,
  };
}

/** Le texte que lit un modele : le verdict d'abord, puis chaque signal avec sa source. */
function texte(v) {
  const l = ['Quick verdict for ' + (v.token.symbol ? '$' + v.token.symbol + ' ' : '') + v.token.address + (v.token.chain ? ' on ' + v.token.chain : '') + ': '
    + v.verdict.toUpperCase().replace(/_/g, ' ') + ' — ' + v.summary + '.'];
  for (const x of v.flags) l.push('- [' + x.level + '] ' + x.text + ' (' + x.source + ')');
  if (v.colony && v.colony.positiveTraits.length) l.push('- SWOGE AI colony, traits that did better (not an endorsement): '
    + v.colony.positiveTraits.map((c) => c.case + ' ' + (c.averagePct > 0 ? '+' : '') + c.averagePct + '% over ' + c.observations).join('; '));
  if (v.attribution) l.push('Contract security data: ' + v.attribution.security + ' (' + v.attribution.url + ').');
  l.push(v.note);
  return l.join('\n');
}

module.exports = { juge, texte, liqMin, MESURE_LIQ, NOTE };
