'use strict';
/* ==================================================================
 * SWOGEAGENTIC — LE SERVEUR MCP (Streamable HTTP, « dual-era »)
 * ==================================================================
 *
 * Ce qui fait utiliser HYRE : ses outils se branchent dans Claude Desktop,
 * Cursor et tout client MCP. Ici, `POST /mcp`, avec la clé d'API en
 * `Authorization: Bearer swg_…` (ou `/mcp/k/<clé>` pour un client qui ne sait
 * pas poser d'en-tête).
 *
 * Spécification relue le 26 septembre 2026 (modelcontextprotocol.io) : la
 * révision 2026-07-28 supprime la poignée de main `initialize` et porte la
 * version dans le `_meta` de CHAQUE requête ; les clients en circulation
 * parlent encore 2025-11-25 et avant. Ce serveur parle les deux (« dual-era ») :
 *   - MODERNE (`_meta['io.modelcontextprotocol/protocolVersion']` présent) :
 *     sans état ; en-têtes `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`
 *     obligatoires et comparés au corps (400 + -32020 HeaderMismatch) ;
 *     version inconnue → 400 + -32022 avec les versions servies ; méthode
 *     inconnue → 404 + -32601 ; `server/discover` servi ; résultats avec
 *     `resultType: "complete"`.
 *   - HÉRITÉ : `initialize` négocie la version (la même si servie, sinon la
 *     plus récente des héritées), `notifications/initialized` → 202 ; aucun
 *     identifiant de session n'est émis (il est optionnel).
 *   - GET et DELETE → 405 ; un en-tête `Origin` présent et hors liste → 403.
 *
 * Aucune logique d'argent : `tools/call` passe par agentic.appelle (devis,
 * plafond, réserve, reçu). Une erreur d'outil revient en `isError: true` —
 * le modèle peut la lire et se corriger.
 * ================================================================== */

const MODERNES = ['2026-07-28'];
const HERITEES = ['2025-11-25', '2025-06-18', '2025-03-26'];
const META = 'io.modelcontextprotocol/';
const SERVEUR = { name: 'swogeagentic', title: 'SwogeAgentic — SWOGE WORLD tools', version: '1.0.0' };
const INSTRUCTIONS = 'SWOGE WORLD tools for crypto research on Robinhood Chain and beyond: token scans (DexScreener, GoPlus, and what the SWOGE AI colony measured, with sample sizes), the colony\'s live activity, the $SWOGE economy, web search, and a full research agent. Read-only: nothing here buys, sells or signs. Each call is billed from the key owner\'s $SWOGE balance; call a tool with {"quote": true} in its arguments to get its price without paying.';

const erreur = (id, code, message, data) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: Object.assign({ code, message }, data ? { data } : {}) });
const json = (status, corps) => ({ status, entetes: { 'content-type': 'application/json' }, corps: JSON.stringify(corps) });

/* Une valeur d'en-tête Base64 « sentinelle » (=?base64?…?=), décodée. */
function decode(v) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(String(v || ''));
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}
const entete = (h, nom) => { const k = Object.keys(h || {}).find((x) => x.toLowerCase() === nom.toLowerCase()); return k ? h[k] : undefined; };

/** Les outils au format MCP. `quote` est accepte par tous : il rend le prix sans payer. */
function outilsMcp(defs) {
  return defs.map((d) => ({
    name: d.name, title: d.name.replace(/_/g, ' '), description: d.description,
    inputSchema: Object.assign({}, d.inputSchema, { properties: Object.assign({}, d.inputSchema.properties,
      { quote: { type: 'boolean', description: 'true: return the price of this call without running or paying for it' } }) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }));
}

/**
 * Une requête HTTP sur l'endpoint MCP → { status, entetes, corps }.
 *   req  = { methode, entetes, corps (texte), cle (résolue ou null), origines (liste permise) }
 *   deps = { agentic: agentic.cree(...), actifs() }
 */
async function traite(req, deps) {
  const origine = entete(req.entetes, 'origin');
  if (origine && !(req.origines || []).includes(origine)) return json(403, erreur(undefined, -32600, 'Origin not allowed'));
  if (req.methode !== 'POST') return { status: 405, entetes: { allow: 'POST' }, corps: '' };
  let m;
  try { m = JSON.parse(req.corps || ''); } catch (e) { return json(400, erreur(null, -32700, 'Parse error')); }
  if (!m || Array.isArray(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return json(400, erreur(m && m.id, -32600, 'Invalid Request: one JSON-RPC 2.0 message per POST'));

  /* Une notification (pas d'id) : acceptée, sans corps. */
  if (m.id === undefined) return { status: 202, entetes: {}, corps: '' };

  const p = m.params || {};
  const meta = (p._meta && typeof p._meta === 'object') ? p._meta : {};
  const moderne = typeof meta[META + 'protocolVersion'] === 'string';
  const defs = () => outilsMcp(require('./agentic').definitions(deps.actifs ? deps.actifs() : {}));

  if (moderne) {
    const v = meta[META + 'protocolVersion'];
    const hv = entete(req.entetes, 'mcp-protocol-version'), hm = entete(req.entetes, 'mcp-method');
    if (!hv || !hm) return json(400, erreur(m.id, -32020, 'Header mismatch: MCP-Protocol-Version and Mcp-Method headers are required'));
    if (hv !== v) return json(400, erreur(m.id, -32020, 'Header mismatch: MCP-Protocol-Version header value \'' + hv + '\' does not match body value \'' + v + '\''));
    if (hm !== m.method) return json(400, erreur(m.id, -32020, 'Header mismatch: Mcp-Method header value \'' + hm + '\' does not match body value \'' + m.method + '\''));
    if (m.method === 'tools/call') {
      const hn = entete(req.entetes, 'mcp-name');
      if (hn === undefined || decode(hn) !== p.name) return json(400, erreur(m.id, -32020, 'Header mismatch: Mcp-Name header does not match body value \'' + p.name + '\''));
    }
    if (!MODERNES.includes(v)) return json(400, erreur(m.id, -32022, 'Unsupported protocol version', { supported: MODERNES.concat(HERITEES), requested: v }));
    if (m.method === 'server/discover') {
      return json(200, { jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', supportedVersions: MODERNES.concat(HERITEES),
        capabilities: { tools: {} }, _meta: { [META + 'serverInfo']: SERVEUR }, instructions: INSTRUCTIONS } });
    }
    if (m.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: defs() } });
    if (m.method === 'tools/call') {
      const r = await appel(p, req, deps, m.id);
      if (r.inconnu) return json(200, erreur(m.id, -32602, 'Unknown tool: ' + p.name));
      return json(200, { jsonrpc: '2.0', id: m.id, result: Object.assign({ resultType: 'complete' }, r) });
    }
    return json(404, erreur(m.id, -32601, 'Method not found: ' + m.method));
  }

  /* ---- HÉRITÉ (2025-11-25 et avant) ---- */
  if (m.method === 'initialize') {
    const v = HERITEES.includes(p.protocolVersion) ? p.protocolVersion : HERITEES[0];
    return json(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVEUR, instructions: INSTRUCTIONS } });
  }
  if (m.method === 'ping') return json(200, { jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: m.id, result: { tools: defs() } });
  if (m.method === 'tools/call') {
    const r = await appel(p, req, deps, m.id);
    if (r.inconnu) return json(200, erreur(m.id, -32602, 'Unknown tool: ' + p.name));
    return json(200, { jsonrpc: '2.0', id: m.id, result: r });
  }
  return json(200, erreur(m.id, -32601, 'Method not found: ' + m.method));
}

/* Un appel d'outil : devis ou exécution, et le résultat au format MCP. */
async function appel(p, req, deps, id) {
  const nom = String(p.name || ''), args = Object.assign({}, p.arguments || {});
  const devis = args.quote === true; delete args.quote;
  const r = await deps.agentic.appelle({ cle: req.cle, outil: nom, args, devis });
  if (r.code === 404) return { inconnu: true, content: [{ type: 'text', text: r.raison }], isError: true };
  if (!r.ok) return { content: [{ type: 'text', text: 'Error: ' + r.raison + (r.code === 401 ? ' (send it as "Authorization: Bearer swg_…")' : '') }], isError: true };
  if (devis) {
    const d = r.devis;
    const t = d.variable ? 'Price: real cost, up to ' + d.maxSwoge + ' $SWOGE ($' + d.maxUsd + ').' : 'Price: ' + d.swoge + ' $SWOGE ($' + d.usd + ') per call.';
    return { content: [{ type: 'text', text: t }], structuredContent: { quote: d }, isError: false };
  }
  const pied = '\n\n— billed ' + r.facture.swoge + ' $SWOGE ($' + r.facture.usd + '), receipt ' + r.recu + ', balance ' + r.solde + ' $SWOGE';
  return { content: [{ type: 'text', text: String(r.texte || '') + pied }],
           structuredContent: { result: r.resultat, billed: r.facture, receipt: r.recu, balance: r.solde }, isError: false };
}

module.exports = { traite, outilsMcp, MODERNES, HERITEES, SERVEUR, decode };
