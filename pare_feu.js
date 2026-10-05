'use strict';
/* ==================================================================
 * LE PARE-FEU DE PROMPT — ce que l'agent a le droit de LIRE
 * ==================================================================
 *
 * Phase 1, etape 8b (en papier), piece 1/3. Avant que l'esprit d'un agent ne
 * voie un texte EXTERNE (un post X lie, une entree de concours, un resultat de
 * recherche, le profil d'un autre jeton), on le passe ici. Modele AgencyPad :
 *   - des REGLES deterministes bloquent le texte qui demande un mouvement de
 *     fonds, mentionne une cle/seed, tente d'injecter des instructions, usurpe
 *     le systeme/la maison, ou cache du contenu (base64, \u, data:, HTML, long hex) ;
 *   - les ADRESSES de portefeuille sont RETIREES (un geste n'agit jamais sur une
 *     adresse venue d'un message — regle du depot) ;
 *   - deux classifieurs de surete INDEPENDANTS doivent TOUS DEUX approuver. Si
 *     l'un refuse, doute, echoue ou expire → le texte est RETENU (fail-closed).
 * L'esprit ne recoit jamais le texte bloque, juste un avis de retrait.
 *
 * Tout est pur / injectable : aucun essai ne sort de la machine.
 * ================================================================== */

/* Les regles de blocage, deterministes. Chacune nommee pour l'avis de retrait. */
const BLOCS = [
  { nom: 'keys', re: /\b(private[\s-]?key|seed[\s-]?phrase|mnemonic|secret[\s-]?key|recovery[\s-]?phrase|keystore)\b/i },
  { nom: 'injection', re: /\b(ignore (all |the )?(previous|above)|disregard (all|the|previous)|system prompt|you are now|new instructions|override (your|the)|forget (your|the|all) (rules|instructions|prompt))\b/i },
  { nom: 'impersonation', re: /(^|\n)\s*(system|assistant|developer|admin)\s*:|\b(the (swoge|agency) (team|staff|admin|owner)|official (team|admin|support))\b/i },
  { nom: 'hidden-encoded', re: /data:[^;\s]+;base64,|\\u[0-9a-fA-F]{4}|<\s*(script|img|iframe|svg|style)\b|\b[0-9a-fA-F]{64,}\b|[A-Za-z0-9+/]{60,}={0,2}/ },
];
/* Un mouvement de fonds : un verbe de transfert + une somme ou une adresse. */
const VERBE_FONDS = /\b(send|transfer|withdraw|wire|drain|sweep|approve|revoke|delegate|authorize)\b/i;
const SOMME = /(\$\s*\d|\b\d+(?:\.\d+)?\s*(?:eth|weth|sol|usdc|usdt|swoge|tokens?)\b)/i;
/* Les adresses a RETIRER : EVM (0x + 40 hex) et Solana (base58, 32-44). */
const ADR_EVM = /\b0x[0-9a-fA-F]{40}\b/g;
const ADR_SOL = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

function normalise(t) {
  return String(t == null ? '' : t)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')   /* controles */
    .replace(/[​-‏‪-‮⁠﻿]/g, '')         /* zero-width / bidi caches */
    .replace(/[ \t]+/g, ' ').trim();
}

/** Retire les adresses (et marque qu'on l'a fait). */
function retireAdresses(t) {
  let retire = false;
  const sub = (s) => { retire = true; return '[address removed]'; };
  const out = t.replace(ADR_EVM, sub).replace(ADR_SOL, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? sub(m) : m));
  return { texte: out, retire };
}

/**
 * Passe un texte externe au pare-feu.
 * deps.classifieurs : tableau de fn(texte)->{sur:boolean} (ou qui jette/expire).
 *   Les DEUX doivent dire sur:true. Un seul refus/doute/echec → retenu.
 * Rend { ok:true, texte } (nettoye, adresses retirees) ou
 *      { ok:false, retire:true, raison, regle? }.
 */
async function filtre(texteBrut, deps) {
  deps = deps || {};
  const t = normalise(texteBrut);
  if (!t) return { ok: true, texte: '' };
  for (const b of BLOCS) if (b.re.test(t)) return { ok: false, retire: true, regle: b.nom, raison: 'blocked: ' + b.nom };
  if (VERBE_FONDS.test(t) && (SOMME.test(t) || ADR_EVM.test(t))) return { ok: false, retire: true, regle: 'fund-movement', raison: 'blocked: fund-movement request' };
  const { texte } = retireAdresses(t);
  /* Deux classifieurs independants, fail-closed. Aucun fourni → regles seules. */
  const cls = Array.isArray(deps.classifieurs) ? deps.classifieurs : [];
  for (const c of cls) {
    let r;
    try { r = await c(texte); } catch (e) { return { ok: false, retire: true, regle: 'classifier-error', raison: 'withheld: a safety check failed (fail-closed)' }; }
    if (!r || r.sur !== true) return { ok: false, retire: true, regle: 'classifier', raison: 'withheld: a safety check did not approve (fail-closed)' };
  }
  return { ok: true, texte };
}

module.exports = { filtre, normalise, retireAdresses, BLOCS, VERBE_FONDS };
