'use strict';
/* ==================================================================
 * LES OUTILS MCP QUI NE SONT PAS DES OUTILS DE LECTURE (29 septembre 2026)
 * ==================================================================
 *
 * Suite du « SWOGE Agent Network » : que Claude Desktop, Cursor ou tout client MCP
 * puisse, sans code, (1) chercher une eSIM de voyage et (2) payer un autre service
 * x402 par la passerelle, dans les limites du proprietaire de la cle.
 *
 *   find_esim_plans : gratuit, sans cle (boutique_esim.plans) ; l'achat se fait en x402
 *                     sur /esim/buy (le prix d'un forfait depasse le plafond d'un appel
 *                     de la passerelle, 0,10 $ : pas d'achat par la cle ici).
 *   pay_service     : la passerelle (passerelle.paie) — une CLE, dont le proprietaire a
 *                     allume les paiements, et une idempotency_key en argument.
 *   payment_audit   : les lignes d'audit chainees de cette cle.
 *
 * Ces outils ne sont listes que lorsque leur module est allume. Une erreur revient en
 * isError (le modele la lit et se corrige), jamais en erreur JSON-RPC.
 * ================================================================== */

const texte = (t) => [{ type: 'text', text: String(t) }];
const erreurOutil = (t) => ({ isError: true, content: texte('Error: ' + t) });

/**
 * deps : { boutique() → boutique_esim (plans, actif), passerelle() → passerelle (paie, audit), paiementsActifs() → bool, api }
 */
function cree(deps) {
  const boutiqueOk = () => !!(deps.boutique && deps.boutique() && deps.boutique().actif());
  const paieOk = () => !!(deps.passerelle && deps.paiementsActifs && deps.paiementsActifs());

  function defs() {
    const d = [];
    if (boutiqueOk()) d.push({ name: 'find_esim_plans', title: 'find esim plans',
      description: 'Use this when someone needs mobile data abroad: data-only travel eSIM plans (no phone number) for a country (name or 2-letter code) or a region '
        + '(Europe, Asia, Middle East, South America, North America, Global), cheapest per GB first, each with its price in USD. Free: nothing is paid. '
        + 'To buy one, POST ' + deps.api + '/esim/buy {"plan": id} and pay the x402 request in USDC on Base or Solana, no account; the eSIM is bought before the payment settles.',
      inputSchema: { type: 'object', properties: { country: { type: 'string', description: 'e.g. France, JP, Europe' },
        min_gb: { type: 'number', description: 'optional: at least this many GB' }, min_days: { type: 'integer', description: 'optional: valid at least this many days' } }, required: ['country'] },
      annotations: { readOnlyHint: true, openWorldHint: true } });
    if (deps.services) d.push({ name: 'search_x402_services', title: 'search x402 services',
      description: 'Use this when you need a paid API an agent can pay per call (x402): searches the public x402 catalogue and returns each service with what SWOGE MEASURED without paying '
        + '(how many probes, share answered, median latency, last failure) and real paid calls made through SWOGE. No verdict under 3 probes. Free.',
      inputSchema: { type: 'object', properties: { need: { type: 'string', description: 'what you need, in a few English keywords' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['need'] },
      annotations: { readOnlyHint: true, openWorldHint: true } });
    if (paieOk()) d.push({ name: 'pay_service', title: 'pay service',
      description: 'Use this when your task needs a paid x402 service (a data or AI API that answers 402): SWOGE pays it for you in USDC and bills the key owner (from their dollar credit, or in $SWOGE), '
        + 'within the limits the owner set for this API key (payments off by default; per-call cap up to $0.10; optional allowed sites). Only services of the public x402 catalogue; '
        + 'paid only if the service answers 200. Always send a new idempotency_key per payment: the same key never pays twice. Every attempt is written to a hash-chained audit (payment_audit).',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'https URL of the paid service' }, idempotency_key: { type: 'string', description: '8 to 100 characters, unique per payment' },
        method: { type: 'string', enum: ['GET', 'POST'] }, query: { type: 'object', description: 'query parameters (GET)' }, body: { type: 'object', description: 'JSON body (POST)' },
        max_usd: { type: 'number', description: 'optional: a lower cap for this call' } }, required: ['url', 'idempotency_key'] },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    { name: 'payment_audit', title: 'payment audit',
      description: 'Use this to check what this API key paid: the latest hash-chained audit lines (paid, free or refused, with price and transaction) and whether the chain is intact. Free.',
      inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } });
    return d;
  }
  const gere = (nom) => defs().some((d) => d.name === nom);

  async function appelle(nom, args, req) {
    args = Object.assign({}, args || {});
    const devis = args.quote === true; delete args.quote;
    if (nom === 'find_esim_plans') {
      if (devis) return { content: texte('Price: free.'), structuredContent: { quote: true, tool: nom, priceUsd: 0 }, isError: false };
      const r = await deps.boutique().plans({ country: args.country, min_gb: args.min_gb, min_days: args.min_days });
      if (!r.ok) return erreurOutil(r.raison);
      const l = r.plans.map((p, i) => (i + 1) + '. ' + p.name + (p.covers ? ' (covers ' + p.covers + ')' : '') + ' - ' + (p.gb || '?') + ' GB, ' + (p.days || '?') + ' days - $' + p.priceUsd + ' - plan id: ' + p.plan);
      return { content: texte((r.plans.length ? 'Data-only eSIM plans for ' + r.destination + ':\n' + l.join('\n') : 'No plan for ' + r.destination + ' right now.')
        + '\nBuy: POST ' + deps.api + '/esim/buy {"plan": "<plan id>"} and pay the x402 request (USDC, Base or Solana). Check the device supports eSIM: ' + r.compatibility), structuredContent: r, isError: false };
    }
    if (nom === 'search_x402_services') {
      if (devis) return { content: texte('Price: free.'), structuredContent: { quote: true, tool: nom, priceUsd: 0 }, isError: false };
      const r = await deps.services().recherche(args.need, args.limit || 10);
      const l = r.services.map((s, i) => (i + 1) + '. ' + s.url + ' - ' + (s.priceUsd != null ? '$' + s.priceUsd : 'price in its 402') + ' - ' + s.verdict
        + (s.probes.medianMs != null ? ', median ' + s.probes.medianMs + ' ms' : '') + (s.paidCalls.n ? ', ' + s.paidCalls.n + ' paid calls, ' + s.paidCalls.succeededPct + '% succeeded' : '') + (s.description ? ' - ' + s.description.slice(0, 140) : ''));
      return { content: texte((l.length ? l.join('\n') : 'No service matches.') + '\n' + r.note), structuredContent: r, isError: false };
    }
    if (nom === 'payment_audit') {
      if (!req.cle) return erreurOutil('send your API key (Authorization: Bearer swg_...): the audit is per key');
      const a = deps.passerelle().audit(req.cle.addr, req.cle.id, 20);
      const t = a.lignes.map((x) => new Date(x.t).toISOString().slice(0, 16) + ' ' + x.statut + ' ' + (x.hote || '') + (x.usd ? ' $' + x.usd : '') + (x.tx ? ' tx ' + x.tx : '') + (x.raison ? ' - ' + x.raison : ''));
      return { content: texte((t.length ? t.join('\n') : 'No payment yet with this key.') + '\nAudit chain: ' + (a.chaine.ok ? 'intact (' + a.chaine.lignes + ' lines)' : 'BROKEN at line ' + a.chaine.casseA)),
        structuredContent: a, isError: false };
    }
    if (nom === 'pay_service') {
      if (devis) return { content: texte('Price: the price in the service\'s 402, within this key\'s per-call cap; nothing is charged if the service fails.'), structuredContent: { quote: true, tool: nom }, isError: false };
      if (!req.cle) return erreurOutil(req.clePresentee ? 'this API key is unknown or revoked' : 'send your API key (Authorization: Bearer swg_...): payments are made for the key owner, within the limits they set');
      const r = await deps.passerelle().paie(req.cle, args, args.idempotency_key);
      const c = r.corps || {};
      if (!c.ok) return erreurOutil((c.raison || 'refused') + (c.audit ? ' (audit line ' + c.audit.seq + ')' : ''));
      const rc = c.recu || {};
      const res = typeof c.resultat === 'string' ? c.resultat : JSON.stringify(c.resultat);
      return { content: texte(String(res).slice(0, 20000) + '\n\n- paid $' + (rc.usd || 0) + (rc.factureUsd ? ', billed $' + rc.factureUsd + (req.cle.payeur === 'credit' ? ' from the dollar credit' : ' in $SWOGE') : '') + (rc.tx ? ', transaction ' + rc.tx : '')
        + ', audit line ' + c.audit.seq + (c.rejoue ? ' (this idempotency_key was already used: original answer)' : '')), structuredContent: c, isError: false };
    }
    return null;
  }

  return { defs, gere, appelle };
}

module.exports = { cree };
