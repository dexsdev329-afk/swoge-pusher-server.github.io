'use strict';
/* ==================================================================
 * SWOGEAGENTIC — SE FAIRE TROUVER PAR LES AGENTS
 * ==================================================================
 *
 * Demande du propriétaire, 26 septembre 2026 : « comment d'autres agents IA
 * peuvent nous trouver et utiliser nos services ». Relu le même jour :
 *   - spécification de découverte d'AgentCash (lue par x402scan et mppscan) :
 *     `GET /openapi.json` (OpenAPI 3.1, `info.x-guidance`, `x-payment-info`
 *     par opération payante, prix en DOLLARS décimaux — les unités atomiques
 *     sont dans le 402), preuve de propriété dans `x-discovery.ownershipProofs` ;
 *     « les sondes sans authentification atteignent le 402 AVANT la validation
 *     du corps » ;
 *   - manifeste `GET /.well-known/x402` lu par x402scan :
 *     `{ version: 1, x402Version: 2, resources: [url…], ownershipProofs: […] }` ;
 *   - la preuve de propriété : une signature EIP-191 de l'ORIGINE nue
 *     (https://hôte, sans barre finale) par une adresse `payTo`. Elle ne peut
 *     venir que du propriétaire (la clé de la trésorerie n'est pas ici) : il la
 *     pose dans `X402_PREUVE`, le serveur la VÉRIFIE et ne la publie que juste.
 *
 * Tout est construit depuis le catalogue en direct : un outil ajouté apparaît
 * partout, avec son prix du moment. Rien n'est inventé : sans x402 allumé, pas
 * de manifeste (404), et l'OpenAPI ne décrit que les appels par clé.
 * ================================================================== */

const { ethers } = require('ethers');

/** L'origine nue d'une URL : https://hôte[:port], sans chemin ni barre finale. */
function origine(url) {
  const u = new URL(url);
  return u.protocol + '//' + u.host;
}

/** Les preuves de propriété valides : signées (EIP-191) sur l'origine par la trésorerie. Les autres sont écartées. */
function preuvesValides(preuves, orig, payTo) {
  return String(preuves || '').split(',').map((x) => x.trim()).filter(Boolean).filter((sig) => {
    try { return ethers.utils.verifyMessage(orig, sig).toLowerCase() === String(payTo || '').toLowerCase(); }
    catch (e) { return false; }
  });
}

/** Le prix affiché d'un outil payable d'avance : décimal en $, 6 chiffres (spec AgentCash). */
const usd6 = (x) => Number(x).toFixed(6);

/**
 * L'OpenAPI 3.1. `c` = { base, outils (définitions + prix du catalogue), x402 (état public ou null),
 *   prixX402 : { nom → { usd, min, max } } (outils payables d'avance), preuves, docs }.
 */
function openapi(c) {
  const paths = {};
  const payable = c.prixX402 || {};
  for (const o of c.outils) {
    const p = payable[o.name];
    const op = {
      operationId: o.name,
      summary: String(o.description || '').split('. ')[0].replace(/\.$/, ''),
      description: o.description,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
        properties: { arguments: Object.assign({ type: 'object' }, o.inputSchema || {}), quote: { type: 'boolean', description: 'with an API key: return the price without running the tool' } },
        required: ['arguments'] } } } },
      responses: {
        200: { description: 'The tool result (`resultat`, `texte`) and, when paid, the receipt (`facture` and `recu` with a key, `x402` without).' },
        400: { description: 'Invalid arguments — nothing is charged' },
        401: { description: 'No API key (and this tool cannot be paid per call without one)' },
        402: { description: p ? 'Payment Required — the PAYMENT-REQUIRED header (x402 v2) quotes this exact request; or, with an API key, the balance or daily cap is too low'
          : 'The balance or the key\'s daily cap is too low' },
        502: { description: 'The tool or its provider failed — nothing is charged' },
      },
      security: p ? [{ cleApi: [] }, {}] : [{ cleApi: [] }],
    };
    if (p) {
      op['x-payment-info'] = { protocols: [{ x402: {} }],
        price: p.min === p.max ? { mode: 'fixed', currency: 'USD', amount: usd6(p.min) } : { mode: 'dynamic', currency: 'USD', min: usd6(p.min), max: usd6(p.max) } };
    }
    paths['/agentic/call/' + o.name] = { post: op };
  }
  paths['/agentic/tools'] = { get: { operationId: 'listTools', summary: 'The live tool catalogue: names, input schemas, prices', responses: { 200: { description: 'The catalogue' } }, security: [] } };
  if (c.x402) paths['/agentic/x402'] = { get: { operationId: 'x402Status', summary: 'x402 status: networks, assets, prices now, what was collected', responses: { 200: { description: 'Public status (never a key)' } }, security: [] } };
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'SwogeAgentic',
      version: '1.0.0',
      description: 'Pay-per-call tools for AI agents from SWOGE WORLD: token scans, the SWOGE AI colony\'s measurements on Robinhood Chain (with sample sizes), launches, wallet and infrastructure OSINT (passive), web search, image and video generation, and a research agent. Read-only: nothing here trades or signs.',
      'x-guidance': 'POST /agentic/call/<tool> with a JSON body {"arguments": {...}}. With an API key (Authorization: Bearer swg_…, created at ' + (c.page || 'the SwogeAgentic page') + ') the call is billed from the key owner\'s $SWOGE balance; add "quote": true for the price. '
        + (c.x402 ? 'Without a key, tools marked x-payment-info answer 402 with a PAYMENT-REQUIRED header (x402 v2, scheme exact, ' + c.x402.network + ', ' + (c.x402.assets || []).map((a) => a.symbol + ' via ' + a.assetTransferMethod).join(' or ') + '): sign and retry with PAYMENT-SIGNATURE and the SAME arguments; the server pays the gas. ' : '')
        + 'Tool list and input schemas: GET /agentic/tools. MCP (Streamable HTTP, same key): /mcp.',
    },
    servers: [{ url: c.base }],
    paths,
    components: { securitySchemes: { cleApi: { type: 'http', scheme: 'bearer', description: 'SwogeAgentic API key (swg_…)' } } },
  };
  if (c.docs) doc.externalDocs = { url: c.docs };
  if (c.preuves && c.preuves.length) doc['x-discovery'] = { ownershipProofs: c.preuves };
  return doc;
}

/** Le manifeste `/.well-known/x402` (forme lue par x402scan). */
function manifeste(c) {
  const m = { version: 1, x402Version: 2, name: 'SwogeAgentic',
    description: 'Pay-per-call crypto intelligence, OSINT, search and image tools for AI agents — Robinhood Chain, paid in USDG or $SWOGE.',
    resources: Object.keys(c.prixX402 || {}).map((n) => c.base + '/agentic/call/' + n) };
  if (c.preuves && c.preuves.length) m.ownershipProofs = c.preuves;
  if (c.docs) m.docs = c.docs;
  return m;
}

/** La fiche du registre MCP officiel (server.json, schéma 2025-12-11 relu le 26 septembre 2026). */
function ficheMcp({ nom, base, version }) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: nom,
    title: 'SwogeAgentic',
    /* ≤ 100 caractères (schéma server.json 2025-12-11, relu le 26 septembre 2026). */
    description: 'Crypto intel for AI agents: token scans, SWOGE AI colony data, OSINT, web search, images, video',
    version: version || '1.0.0',
    remotes: [{ type: 'streamable-http', url: base + '/mcp',
      headers: [{ name: 'Authorization', description: 'Bearer swg_… — an API key from swoleeswoge.dog/swogeagentic.html (a daily cap bounds what it can spend)', isRequired: true, isSecret: true }] }],
  };
}

module.exports = { origine, preuvesValides, openapi, manifeste, ficheMcp, usd6 };
