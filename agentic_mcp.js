'use strict';
/* ==================================================================
 * SWOGEAGENTIC — LE SERVEUR MCP (Streamable HTTP, « dual-era »)
 * ==================================================================
 *
 * Ce qui fait utiliser HYRE : ses outils se branchent dans Claude Desktop,
 * Cursor et tout client MCP. Ici, `POST /mcp`, avec la clé d'API en
 * `Authorization: Bearer swg_…` (ou `/mcp/k/<clé>` pour un client qui ne sait
 * pas poser d'en-tête). Sans clé : `tools/list` et les devis (`quote: true`)
 * sont servis ; un appel reçoit la marche à suivre pour payer.
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
/* 1.0.1 (26 septembre 2026) : devis sans clé, refus qui dit comment payer — même numéro que server.json. */
const SERVEUR = { name: 'swogeagentic', title: 'SwogeAgentic — SWOGE WORLD tools', version: '1.0.1' };
/* 26 septembre 2026 : le devis est GRATUIT et sans clé (l'audit du jour l'a
   trouvé promis ici mais refusé) ; la clé n'est requise que pour être servi. */
const instructions = (api, x402Mcp, extras) => 'SWOGE WORLD tools for crypto research on Robinhood Chain and beyond: token scans (market from DexScreener, contract security Powered by Go+ Security (https://gopluslabs.io), and what the SWOGE AI colony measured, with sample sizes), the colony\'s live activity, the $SWOGE economy, web search, and a full research agent. '
  /* 29/09 : une seule exception a « rien n'achete », et elle est dite. */
  + (extras && extras.gere('pay_service') ? 'Read-only except pay_service, which pays another x402 service only when the API key owner turned payments on for that key, within their per-call cap; nothing here sells or signs for itself.'
    : 'Read-only: nothing here buys, sells or signs.')
  + (extras && extras.gere('find_esim_plans') ? ' find_esim_plans finds travel data eSIMs (free).' : '')
  + ' No key needed to list the tools or to get a price: call any tool with {"quote": true} in its arguments — free, nothing runs. To run a tool, send an API key (create one at https://swoleeswoge.dog/swogeagentic.html, header "Authorization: Bearer swg_…"): each call is billed from the key owner\'s $SWOGE balance, within a daily cap. Fixed-price tools and images can also be paid per call without an account via x402 over REST: POST ' + (api || '') + '/agentic/call/<tool> (the quote says when that is open).'
  /* x402 sur MCP allumé (Base allumée et X402_MCP != '0', lot Base du 27 septembre 2026). */
  + (x402Mcp ? ' Fixed-price tools and images (and ask_agent when enabled) can also be paid per call without an account with x402 over MCP (_meta["x402/payment"], USDC on Base first): call the tool, read the PaymentRequired in structuredContent, sign it and call again with the payment.' : '');

const erreur = (id, code, message, data) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: Object.assign({ code, message }, data ? { data } : {}) });
const json = (status, corps) => ({ status, entetes: { 'content-type': 'application/json' }, corps: JSON.stringify(corps) });

/* Une valeur d'en-tête Base64 « sentinelle » (=?base64?…?=), décodée. */
function decode(v) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(String(v || ''));
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}
const entete = (h, nom) => { const k = Object.keys(h || {}).find((x) => x.toLowerCase() === nom.toLowerCase()); return k ? h[k] : undefined; };

/** Les outils au format MCP. `quote` est accepte par tous : il rend le prix sans payer.
 *  JAMAIS d'`outputSchema` sur un outil payant : @modelcontextprotocol/sdk 1.30.1 vérifie
 *  structuredContent contre lui MÊME pour une erreur (mcp.md §3 point 6) — la demande de
 *  paiement x402 (isError, structuredContent = PaymentRequired) serait rejetée.
 *  `prixBase(nom)` (x402 sur MCP allumé) : l'indice de prix que Cloudflare affiche
 *  (cloudflare/agents x402.ts:380-385) — seulement affiché, jamais un engagement. */
function outilsMcp(defs, prixBase) {
  return defs.map((d) => {
    const o = {
      name: d.name, title: d.name.replace(/_/g, ' '), description: d.description,
      inputSchema: Object.assign({}, d.inputSchema, { properties: Object.assign({}, d.inputSchema.properties,
        { quote: { type: 'boolean', description: 'true: return the price of this call without running or paying for it' } }) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    };
    const u = prixBase ? prixBase(d.name) : null;
    if (u > 0) o._meta = { 'agents-x402/paymentRequired': true, 'agents-x402/priceUSD': u };
    return o;
  });
}

/**
 * Une requête HTTP sur l'endpoint MCP → { status, entetes, corps }.
 *   req  = { methode, entetes, corps (texte), cle (résolue ou null), clePresentee (une clé a été
 *            envoyée, même inconnue), qui (empreinte d'IP, pour les compteurs), origines (liste permise) }
 *   deps = { agentic: agentic.cree(...), actifs(), api (adresse publique du serveur) }
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
  const x402Mcp = !!(deps.x402 && deps.x402.actif && deps.x402.actif());
  /* deps.extras (mcp_extras.js, 29/09) : l'eSIM et la passerelle de depense, a cote des outils de lecture. */
  const defs = () => outilsMcp(require('./agentic').definitions(deps.actifs ? deps.actifs() : {}), x402Mcp && deps.x402.prixBase ? deps.x402.prixBase : null)
    .concat(deps.extras ? deps.extras.defs() : []);

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
        capabilities: { tools: {} }, _meta: { [META + 'serverInfo']: SERVEUR }, instructions: instructions(deps.api, x402Mcp, deps.extras) } });
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
    return json(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVEUR, instructions: instructions(deps.api, x402Mcp, deps.extras) } });
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

/* Un appel d'outil : devis ou exécution, et le résultat au format MCP.
   Sans clé : un devis est servi (gratuit) ; un appel reçoit une erreur
   d'outil qui dit EXACTEMENT comment payer (clé, ou x402 en REST). */
async function appel(p, req, deps, id) {
  const nom = String(p.name || ''), args = Object.assign({}, p.arguments || {});
  if (deps.extras && deps.extras.gere(nom)) return deps.extras.appelle(nom, args, req);
  const devis = args.quote === true; delete args.quote;
  /* ---- x402 SUR MCP (contrat §C, 27 septembre 2026 ; x402-foundation
   * specs/transports-v2/mcp.md) : sans clé, Base allumée, outil payable. Le
   * paiement arrive sous trois formes, dans cet ordre : un OBJET dans
   * `_meta["x402/payment"]` (la spec, mcpc), le base64 d'un objet au même
   * endroit (Cloudflare : btoa(JSON.stringify(…)), x402.ts:481-488), ou l'en-tête
   * HTTP PAYMENT-SIGNATURE (mcpc envoie les deux). Une clé valide gagne : le
   * solde est débité, jamais les deux. `meta` est relu ici (local de `traite`). */
  const meta = (p._meta && typeof p._meta === 'object') ? p._meta : {};
  if (!req.cle && !req.clePresentee && !devis && deps.x402 && deps.x402.actif && deps.x402.actif() && deps.x402.payable(nom)) {
    const brut = meta['x402/payment'] !== undefined && meta['x402/payment'] !== null ? meta['x402/payment'] : entete(req.entetes, 'payment-signature');
    const paiement = brut === undefined || brut === null || brut === '' ? null : brut;
    const sonde = !paiement && !Object.keys(args).length;
    /* Refuser les mauvais arguments AVANT de demander un paiement, comme en REST. */
    const inv = sonde ? null : deps.x402.entreeInvalide(nom, args);
    if (inv) return { content: [{ type: 'text', text: 'Error: ' + inv }], isError: true };
    const r = await deps.x402.paie({ outil: nom, url: deps.api + '/mcp', paiement, args, canal: 'mcp', qui: req.qui, sonde, client: req.client,
      sert: (payeur) => deps.agentic.sertSansFacture({ outil: nom, args, payeur }) });
    return versMcp(r, nom, deps);
  }
  const r = await deps.agentic.appelle({ cle: req.cle, clePresentee: !!req.clePresentee, outil: nom, args, devis, canal: 'mcp', qui: req.qui, client: req.client });
  if (r.code === 404) return { inconnu: true, content: [{ type: 'text', text: r.raison }], isError: true };
  if (r.sansCle) return { content: [{ type: 'text', text: r.raison }], isError: true };
  if (!r.ok) return { content: [{ type: 'text', text: 'Error: ' + r.raison + (r.code === 401 ? ' (send it as "Authorization: Bearer swg_…")' : '') }], isError: true };
  if (devis) {
    const d = r.devis;
    const t = d.gratuit ? 'Price: free.' : d.variable ? 'Price: real cost, up to ' + d.maxSwoge + ' $SWOGE ($' + d.maxUsd + ').' : 'Price: ' + d.swoge + ' $SWOGE ($' + d.usd + ') per call.';
    const x = r.x402 && Array.isArray(r.x402.accepts) && r.x402.accepts.length
      ? ' Without an account (x402): ' + r.x402.accepts.map(etiquette).join(' or ') + ' — see structuredContent.x402.'
      : '';
    const quote = { quote: true, tool: nom, priceUsd: r.priceUsd, devis: d, howToPay: r.howToPay };
    if (r.x402) quote.x402 = r.x402;
    return { content: [{ type: 'text', text: t + x + (req.cle ? '' : ' How to pay: ' + r.howToPay) }], structuredContent: quote, isError: false };
  }
  /* Une clé payée au crédit en dollars (29/09) : le pied le dit en dollars, jamais en $SWOGE. */
  const auCredit = !!(r.facture && r.facture.paidWith);
  const pied = auCredit
    ? '\n\n— billed $' + r.facture.usd + ' from your dollar credit, receipt ' + r.recu + (r.creditUsd != null ? ', credit left $' + r.creditUsd : '')
    : '\n\n— billed ' + r.facture.swoge + ' $SWOGE ($' + r.facture.usd + '), receipt ' + r.recu + ', balance ' + r.solde + ' $SWOGE';
  return { content: [{ type: 'text', text: String(r.texte || '') + pied }],
           structuredContent: auCredit ? { result: r.resultat, billed: r.facture, receipt: r.recu, creditUsd: r.creditUsd != null ? r.creditUsd : null }
             : { result: r.resultat, billed: r.facture, receipt: r.recu, balance: r.solde }, isError: false };
}

/* Une option de paiement dite par réseau ET actif (contrat §C.3) : avant, toute option sans
   eip3009 se lisait « … base units of $SWOGE » — l'USDC de Base aurait été annoncé comme du $SWOGE. */
function etiquette(a) {
  const net = String(a.network || '');
  if (net === 'eip155:8453' || net === 'eip155:84532') return 'USDC ' + (Number(a.amount) / 1e6) + ' on Base' + (net === 'eip155:84532' ? ' Sepolia' : '');
  if (a.extra && a.extra.assetTransferMethod === 'eip3009') return 'USDG ' + (Number(a.amount) / 1e6) + ' on Robinhood Chain';
  return a.amount + ' base units of $SWOGE on Robinhood Chain';
}

/**
 * Ce que rend x402.paie, au format d'un résultat d'outil MCP (x402-foundation
 * specs/transports-v2/mcp.md) : une demande de paiement est un résultat
 * `isError` (pas une erreur JSON-RPC ; jamais -32042, que MCP 2026-07-28 ne
 * définit plus) avec le PaymentRequired en structuredContent, en texte
 * (content[0]) et dans `_meta['x402/error']` (Cloudflare ne lit que là,
 * x402.ts:408-415). « En attente » : AUCUN accepts nulle part — Cloudflare paie
 * tout seul un isError portant `_meta['x402/error'].accepts`, ce serait
 * demander un second paiement. Un règlement raté : jamais le résultat de l'outil.
 */
function versMcp(r, nom, deps) {
  const api = (deps && deps.api) || '';
  const demande = (PR) => {
    const a0 = (PR.accepts || [])[0];
    const prixTxt = a0 ? 'Price: ' + (PR.accepts || []).map(etiquette).join(', or ') + '.' : 'Payment required.';
    return { isError: true, structuredContent: PR,
      content: [{ type: 'text', text: JSON.stringify(PR) },
        { type: 'text', text: asc(prixTxt + ' Sign one option and call again with _meta["x402/payment"], or pay the same call over HTTP at ' + api + '/agentic/call/' + nom + '.') }],
      _meta: { 'x402/error': PR } };
  };
  /* ASCII (le btoa de Cloudflare jette au-delà de U+00FF) : les raisons Robinhood portent des « — ». */
  const asc = (t) => String(t).replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/[^\x20-\x7e]/g, '');
  const pr = (e, erreur) => Object.assign({}, e, erreur ? { error: asc(erreur) } : {});
  switch (r.etape) {
    case 'exige': return demande(pr(r.exige));
    case 'refuse': return r.exige ? demande(pr(r.exige, r.raison + (r.detail ? ': ' + r.detail : ''))) : { isError: true, content: [{ type: 'text', text: 'Error: payment refused: ' + r.raison }] };
    case 'reglement': return r.exige ? (() => { const d = demande(pr(r.exige, 'Settlement failed: ' + (r.detail || r.raison))); d._meta['x402/payment-response'] = r.reponse; return d; })()
      : { isError: true, content: [{ type: 'text', text: 'Settlement failed: ' + (r.detail || r.raison) + ' - the result is withheld and nothing was charged' }], _meta: { 'x402/payment-response': r.reponse } };
    case 'attente': return { isError: true, content: [{ type: 'text', text: 'Payment pending - retry the same call with the same payment.' }],
      _meta: { 'x402/payment-response': r.reponse } };
    case 'outil': return { isError: true, content: [{ type: 'text', text: 'Error: ' + r.raison + (/nothing was charged/.test(r.raison) ? '' : ' - nothing was charged') }] };
    case 'occupe': return { isError: true, content: [{ type: 'text', text: 'ask_agent is busy - try again in a minute' }] };
    case 'indisponible': return { isError: true, content: [{ type: 'text', text: 'x402 payment is unavailable right now' }] };
    default: {
      const recu = r.recu || {};
      const usdc = recu.network === 'eip155:8453' || recu.network === 'eip155:84532';
      const sym = usdc ? 'USDC' : /^0x5fc5360d/i.test(String(recu.asset || '')) ? 'USDG' : '$SWOGE';
      const usd = usdc || sym === 'USDG' ? '$' + (Number(recu.amount) / 1e6) : recu.amount + ' base units';
      const res = r.resultat || {};
      return { isError: false,
        content: [{ type: 'text', text: String(res.texte || '') + '\n\n- paid ' + usd + ' in ' + sym + ' (' + recu.network + '), tx ' + recu.transaction }],
        structuredContent: { result: res.resultat, x402: recu },
        _meta: { 'x402/payment-response': r.reponse } };
    }
  }
}

module.exports = { traite, outilsMcp, instructions, versMcp, etiquette, MODERNES, HERITEES, SERVEUR, decode };
