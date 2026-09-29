'use strict';
/* ==================================================================
 * LES PAIEMENTS VERIFIABLES — CE QUI A ETE PAYE, AVEC SA TRANSACTION (29/09/2026)
 * ==================================================================
 *
 * Tire de l'analyse DYOR du 29/09 : « montrer ce qui marche : les prix, l'usage ET
 * les transactions ». L'Agent Store donnait des compteurs ; un compteur se croit sur
 * parole. Une transaction se verifie : chaque paiement regle est deja ecrit dans
 * DATA_DIR/x402.jsonl (x402.js, apres reglement seulement : { t, outil, payer, asset,
 * montant, transaction, network }), et chacun est public sur sa chaine.
 *
 * Ce qui sort :
 *   - les paiements des agents EXTERIEURS seulement (la maison — AI_OWNER, X402_PAYTO,
 *     le portefeuille de gaz, les portefeuilles d'inscription, COMPTEURS_MAISON — est
 *     ecartee, comme dans les compteurs) ;
 *   - sur les trois reseaux de production seulement (un reseau d'essai n'est pas une preuve) ;
 *   - le payeur TRONQUE (0x21c3…3633) : l'adresse entiere est sur la chaine, derriere le
 *     lien de la transaction ; la page n'en fait pas une liste de clients ;
 *   - le montant en unites lisibles, dans la monnaie payee (le $SWOGE n'est pas converti :
 *     son cours du moment n'est pas celui du paiement).
 * ================================================================== */

const RESEAUX = {
  'eip155:8453': { nom: 'Base', tx: 'https://basescan.org/tx/' },
  'eip155:4663': { nom: 'Robinhood Chain', tx: 'https://robinhoodchain.blockscout.com/tx/' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { nom: 'Solana', tx: 'https://solscan.io/tx/' },
};
/* Les actifs payes (adresses en minuscules ; celle de Solana garde sa casse, base58). */
const ACTIFS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { sym: 'USDC', dec: 6, dollar: true },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { sym: 'USDC', dec: 6, dollar: true },
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { sym: 'USDG', dec: 6, dollar: true },
  '0x8a166fb41cd659a0a43396272ff73973ce29f817': { sym: 'SWOGE', dec: 18, dollar: false },
};
const N_DEFAUT = 20;

const actifDe = (a) => ACTIFS[String(a || '')] || ACTIFS[String(a || '').toLowerCase()] || null;
const tronque = (a) => { a = String(a || ''); if (/^0x/i.test(a)) a = a.toLowerCase(); return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a; };
/* Unites brutes → nombre lisible, sans passer par un flottant pour les 18 decimales. */
function lisible(brut, dec) {
  const s = String(brut || '').replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(s)) return null;
  const p = s.padStart(dec + 1, '0');
  return Number(p.slice(0, -dec) + '.' + p.slice(-dec));
}

/**
 * lignes : les objets du journal (dans l'ordre d'ecriture) ; maison(adr) → vrai pour nos adresses.
 * Rend { recent: [...], total: { paiements, usd, payeurs, depuis } } — le total porte sur
 * les paiements en dollars (USDC, USDG) ; ceux en $SWOGE sont comptes a part.
 */
function preuves(lignes, maison, n) {
  const ext = [];
  for (const l of lignes || []) {
    if (!l || !l.transaction || !RESEAUX[l.network]) continue;
    const a = actifDe(l.asset);
    if (!a) continue;
    if (maison && maison(String(l.payer || '').toLowerCase())) continue;
    const montant = lisible(l.montant, a.dec);
    if (montant == null) continue;
    ext.push({ t: l.t, tool: String(l.outil || '').slice(0, 40), network: RESEAUX[l.network].nom, asset: a.sym, amount: montant,
      usd: a.dollar ? montant : null, payer: tronque(l.payer), tx: String(l.transaction), txUrl: RESEAUX[l.network].tx + String(l.transaction),
      _qui: String(l.payer || '').toLowerCase() });
  }
  const enDollars = ext.filter((x) => x.usd != null);
  const total = { payments: ext.length, usd: Math.round(enDollars.reduce((s, x) => s + x.usd, 0) * 1e6) / 1e6,
    inSwoge: ext.length - enDollars.length, payers: new Set(ext.map((x) => x._qui)).size,
    since: ext.length ? new Date(ext[0].t).toISOString() : null };
  const recent = ext.slice(-(n || N_DEFAUT)).reverse().map((x) => { const o = Object.assign({}, x); delete o._qui; o.at = new Date(o.t).toISOString(); delete o.t; return o; });
  return { recent, total };
}

/** Lit le journal (JSONL) ; une ligne illisible est sautee, un fichier absent rend []. */
function lisJournal(fichier) {
  let txt;
  try { txt = require('fs').readFileSync(fichier, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const l of txt.split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch (e) { /* ligne coupee : sautee */ } }
  return out;
}

module.exports = { preuves, lisJournal, lisible, tronque, RESEAUX, ACTIFS, N_DEFAUT };
