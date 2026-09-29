'use strict';
/* ==================================================================
 * L'AGENT STORE — CE QUE SWOGE VEND, AVEC CE QUI A ETE MESURE (29/09/2026)
 * ==================================================================
 *
 * Etape 2 de l'analyse « Agent OS » (ChatGPT/Grok), retenue par le proprietaire.
 * Chaque agent a : un identifiant, un proprietaire, ses capacites, son prix, son
 * entree, ses permissions, ses facons de payer, et son HISTORIQUE — mais seulement
 * ce qui est MESURE. Aucune reputation inventee :
 *   - l'usage vient des compteurs durables (compteurs.js, 30 jours UTC), agents
 *     EXTERIEURS seulement (nos propres essais et inscriptions ne comptent pas) ;
 *   - une « tentative sans resultat » est un compteur `echec` de l'outil : paiement
 *     refuse, reglement rate ou outil en panne (les compteurs ne les separent pas par
 *     outil) — le libelle le dit ;
 *   - aucun taux sous TENTATIVES_ASSEZ tentatives payees ou ratees (convention du
 *     projet : un chiffre dit sur combien d'observations il porte).
 * Les services x402 d'autres vendeurs viennent de sonde_services.js (sondes sans
 * payer, aucun verdict sous 3 sondes) : la page les lit sur /agentic/services.
 * ================================================================== */

const TENTATIVES_ASSEZ = 10;

/* Ce que chaque outil a le droit de faire. Tous : lecture seule, jamais d'achat, de
   vente ni de signature (agentic.js, contrat des cles). Quelques-uns font un peu plus. */
const PERMISSIONS_EN_PLUS = {
  generate_image: 'creates images (stored by SWOGE, public link)',
  generate_video: 'creates videos (stored by SWOGE, public link)',
  roast_token: 'creates a shareable image card',
  ask_agent: 'runs a research agent that uses the other read-only tools',
  fair_commit: 'records a seed commitment (public, for later verification)',
  chat_completion: 'sends your messages to the chosen AI model',
};
/* Le nom montre aux joueurs (anglais), et la famille qui sert de filtre. */
const FAMILLES = {
  'token-security': 'Crypto', crypto: 'Crypto', 'robinhood-chain': 'Crypto', base: 'Crypto',
  osint: 'OSINT', research: 'Research', 'ai-models': 'AI models', images: 'Image', video: 'Video', randomness: 'Randomness',
};

const premierePhrase = (t) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); const m = s.match(/^(.{20,260}?[.!?])(\s|$)/); return m ? m[1] : s.slice(0, 260); };

/** Le prix affiche : { usd } fixe, { maxUsd, variable } au cout reel, ou { free }. */
function prixDe(p) {
  p = p || {};
  if (p.gratuit) return { free: true, usd: 0 };
  if (p.variable && p.maxUsd != null) return { variable: true, maxUsd: p.maxUsd, note: p.note || null };
  if (p.usd != null) return Object.assign({ usd: p.usd }, p.variable ? { variable: true, note: p.note || null } : {});
  return { usd: null };
}

/** L'usage mesure d'un outil sur la fenetre des compteurs : exterieur seulement. */
function usageDe(c) {
  c = c || {};
  const ext = (k) => (c[k] && c[k].exterieur ? c[k].exterieur : { n: 0, usd: 0 });
  const payes = ext('paye_x402').n + ext('paye_cle').n;
  const usd = Math.round((ext('paye_x402').usd + ext('paye_cle').usd) * 1e4) / 1e4;
  const rates = ext('echec').n;
  const tentatives = payes + rates;
  return { paidCalls: payes, paidUsd: usd, priceQuotes: ext('demande402').n, attemptsWithoutResult: rates,
    verdict: tentatives < TENTATIVES_ASSEZ ? 'not enough paid calls yet (' + tentatives + '/' + TENTATIVES_ASSEZ + ')'
      : 'completed ' + payes + ' of ' + tentatives + ' paid attempts (' + Math.round(payes / tentatives * 1000) / 10 + '%)' };
}

/**
 * Les fiches des outils de SWOGE.
 * o : { catalogue (agentic().catalogue()), compteurs (compteurs.publique(30)), x402Payable(nom), etiquettes, api, page, solana(nom)? }
 */
function fiches(o) {
  const outils = (o.catalogue && o.catalogue.outils) || [];
  const parOutil = (o.compteurs && o.compteurs.outils) || {};
  return outils.map((d) => {
    const tags = (o.etiquettes && o.etiquettes[d.name]) || [];
    const familles = [...new Set(tags.map((t) => FAMILLES[t]).filter(Boolean))];
    const req = (d.inputSchema && d.inputSchema.required) || [];
    const props = (d.inputSchema && d.inputSchema.properties) || {};
    const x402 = !!(o.x402Payable && o.x402Payable(d.name));
    const paiement = [];
    if (x402) paiement.push('x402 per call, no account: USDC on Base' + (o.solana && o.solana(d.name) ? ' or Solana' : '') + ', or USDG / $SWOGE on Robinhood Chain');
    paiement.push('API key: from the owner\'s dollar credit (USDC top-up) or $SWOGE, within a daily cap');
    paiement.push('MCP: the same tools in Claude Desktop, Cursor or any MCP client');
    return {
      id: 'swoge:' + d.name, name: d.name, owner: { name: 'SWOGE', url: o.page },
      summary: premierePhrase(d.description), description: String(d.description || '').slice(0, 1200),
      capabilities: familles.length ? familles : ['Other'], tags,
      price: prixDe(d.prix),
      input: Object.keys(props).slice(0, 8).map((k) => ({ name: k, required: req.includes(k), about: premierePhrase((props[k] && props[k].description) || '').slice(0, 140) })),
      permissions: ['read-only: never buys, sells or signs'].concat(PERMISSIONS_EN_PLUS[d.name] ? [PERMISSIONS_EN_PLUS[d.name]] : []),
      payment: paiement,
      endpoints: { rest: o.api + '/agentic/call/' + d.name, mcp: o.api + '/mcp' },
      usage: usageDe(parOutil[d.name]),
    };
  });
}

module.exports = { fiches, usageDe, prixDe, premierePhrase, TENTATIVES_ASSEZ, FAMILLES };
