'use strict';
/* ==========================================================================
 * UNE ALERTE TELEGRAM QUAND QUELQU'UN PAIE UN OUTIL DE SWOGEAGENTIC
 *
 * Demande du proprietaire, 27 septembre 2026, apres le premier paiement en
 * USDC sur Base : « on peut avoir une alerte Telegram quand quelqu'un utilise
 * scan_token ? ». Branchee sur les compteurs durables (compteurs.js) : chaque
 * appel PAYE (paye_x402 : paiement sans compte ; paye_cle : cle d'API) passe
 * ici. Un devis, un 402 ou un refus ne sont pas un usage : pas d'alerte.
 *
 * Ce que dit le message : l'outil, le montant, le moyen de paiement, le
 * payeur en abrege (une adresse deja publique sur la chaine), « notre propre
 * portefeuille » quand c'en est un, et le lien de la transaction. JAMAIS les
 * arguments de l'appel (le jeton scanne par un client est son affaire).
 *
 * Reglages (chauds) : TG_ALERTE_OUTILS = liste d'outils (defaut scan_token),
 * « * » pour tous, « 0 » pour eteindre. Au plus MAX_HEURE messages par heure :
 * au-dela, les appels sont comptes et resumes dans le message suivant — un
 * agent qui boucle ne noie pas le canal.
 * ======================================================================== */

const MAX_HEURE = 12;
const EXPLORATEURS = { 'eip155:8453': 'https://basescan.org/tx/', 'eip155:4663': 'https://robinhoodchain.blockscout.com/tx/' };
const SORTES = { USDC_BASE: ['USDC on Base', 'eip155:8453'], USDG: ['USDG on Robinhood Chain', 'eip155:4663'], SWOGE: ['$SWOGE on Robinhood Chain', 'eip155:4663'] };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const court = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a || '')) ? String(a).slice(0, 6) + '…' + String(a).slice(-4) : null);

function outilsSuivis() {
  const v = String(process.env.TG_ALERTE_OUTILS == null ? 'scan_token' : process.env.TG_ALERTE_OUTILS).trim();
  if (v === '0' || v === '') return null;
  if (v === '*') return '*';
  return new Set(v.split(/[\s,;]+/).filter(Boolean));
}

/**
 * deps = { notify(texte HTML), maison() → Set d'adresses en minuscules, maintenant() }
 */
function cree(deps) {
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());
  let fenetre = [];          /* instants des messages envoyes dans l'heure */
  let enAttente = 0;         /* appels payes non annonces (au-dela du plafond) */
  const MESURE = { alertes: 0, tues: 0 };

  function note(evenement, info) {
    if (evenement !== 'paye_x402' && evenement !== 'paye_cle') return false;
    const suivis = outilsSuivis();
    const i = info || {};
    const outil = String(i.outil || '');
    if (!suivis || (suivis !== '*' && !suivis.has(outil))) return false;
    const t = maintenant();
    fenetre = fenetre.filter((x) => t - x < 3600e3);
    if (fenetre.length >= MAX_HEURE) { enAttente++; MESURE.tues++; return false; }
    const adr = String(i.qui || '').replace(/^x402:/, '').toLowerCase();
    const nous = !!(adr && deps.maison && deps.maison().has(adr));
    const [moyen, reseau] = evenement === 'paye_cle' ? ['$SWOGE balance (API key)', null]
      : (SORTES[i.sorte] || [esc(i.sorte || 'x402'), i.reseau || null]);
    const usd = Number(i.usd);
    const lignes = [
      `🔎 <b>${esc(outil)}</b> paid${Number.isFinite(usd) && usd > 0 ? ' — $' + (Math.round(usd * 10000) / 10000) : ''} in ${moyen}`,
      `by ${court(adr) ? '<code>' + court(adr) + '</code>' : 'an agent'}${nous ? ' (our own wallet — not a customer)' : ''}${i.canal ? ' · via ' + esc(i.canal) : ''}`,
    ];
    const h = String(i.tx || '');
    const base = EXPLORATEURS[i.reseau || reseau];
    if (base && /^0x[0-9a-fA-F]{64}$/.test(h)) lignes.push(`<a href="${base}${h}">transaction</a>`);
    if (enAttente) { lignes.push(`+${enAttente} more paid call${enAttente > 1 ? 's' : ''} in the last hour (alerts capped at ${MAX_HEURE}/h)`); enAttente = 0; }
    fenetre.push(t);
    MESURE.alertes++;
    try { deps.notify(lignes.join('\n')); } catch (e) { /* une alerte ne casse jamais un paiement */ }
    return true;
  }
  return { note, MESURE };
}

module.exports = { cree, MAX_HEURE, outilsSuivis };
