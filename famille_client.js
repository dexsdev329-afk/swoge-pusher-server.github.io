'use strict';
/* ==================================================================
 * QUI DEMANDE UN PRIX ? LA FAMILLE DU CLIENT, EN UN CODE (29/09/2026)
 * ==================================================================
 *
 * Mesure du 29/09 (compteurs publics, 30 jours) : 4 189 demandes de paiement
 * (402) exterieures le 29/09, 5 622 le 28/09, 84 et 265 demandeurs distincts,
 * AUCUNE signature tentee depuis le 28/09 (0 paiement, 0 echec). Les demandes
 * sont presque uniformes (310 a 360 par outil, meme les plus obscurs) : ce sont
 * sans doute des robots d'annuaire, pas des acheteurs — mais sans le client,
 * c'est une supposition. Ce module range le User-Agent dans une FAMILLE, un
 * code parmi une liste fixe : jamais le texte brut, jamais l'IP (compteurs.js
 * ne garde que des codes).
 * ================================================================== */
const FAMILLES = [
  ['x402scan', /x402scan/i], ['agentcash', /agentcash/i], ['payai', /payai/i], ['coinbase', /coinbase|\bcdp\b|bazaar/i],
  ['claude', /claude|anthropic/i], ['openai', /openai|chatgpt|gptbot/i], ['mcp', /\bmcp\b|modelcontextprotocol/i],
  ['bot', /bot\b|crawler|spider|slurp|facebookexternalhit|headless/i],
  ['python', /python|aiohttp|httpx|urllib/i], ['node', /node|undici|axios|got\b/i], ['go', /go-http-client|\bgo\//i],
  ['curl', /curl|wget/i], ['browser', /mozilla/i],
];
/** Le code de la famille d'un User-Agent : un des codes ci-dessus, 'none' (vide) ou 'other'. */
function famille(ua) {
  const s = String(ua || '').slice(0, 300);
  if (!s.trim()) return 'none';
  for (const [code, re] of FAMILLES) if (re.test(s)) return code;
  return 'other';
}
module.exports = { famille, CODES: FAMILLES.map((x) => x[0]).concat(['none', 'other']) };
