'use strict';
/* ==================================================================
 * SWOGEAGENTIC — LES OUTILS DE SWOGE, VENDUS À L'APPEL AUX AUTRES AGENTS
 * ==================================================================
 *
 * Le modèle de HYRE (relu le 26 septembre 2026 sur hyreagent.fun) : des
 * outils payés à l'appel, un devis avant d'exécuter, un reçu par appel. Ici,
 * la monnaie est le solde $SWOGE du joueur, débité par sa clé d'API
 * (agentic_cles.js) — chaque appel payé donne un usage au jeton.
 *
 * Les outils sont LES MÊMES fonctions que l'agent de la page
 * (`studio_agent.outils`) : un seul code pour lire un jeton, la colonie,
 * l'économie, le web. Plus `ask_agent` : la tâche entière confiée à
 * SwogeAgentic, facturée au réel comme dans la page.
 *
 * ---- LES PRIX ----
 * Ce ne sont PAS des mesures : ce sont des prix de départ fixés le 26
 * septembre 2026, dans la fourchette publiée par HYRE (0,001 à 0,60 $ par
 * appel), modifiables sans toucher au code (`AGENTIC_PRIX`, JSON
 * {outil: usd}). Les lectures de DexScreener, GoPlus et de la colonie ne nous
 * coûtent rien ; la recherche web coûte 0,005 $ chez Perplexity et se vend à
 * ce coût × STUDIO_MARGE, comme dans le chat. Un appel refusé (entrée
 * invalide, outil en panne) n'est JAMAIS facturé.
 * ================================================================== */

const crypto = require('crypto');
const studio = require('./studio');
const config = require('./config');
const Chat = require('./studio_chat');
const Agent = require('./studio_agent');
const Rech = require('./studio_recherche');

const Media = require('./studio_media');

/* Ajoutes le 26 septembre 2026 (etape 3) : les lancements du moment, le
   renseignement sur un lanceur, l'OSINT d'infrastructure — memes reperes de
   prix (lire nos propres donnees ne nous coute rien ; l'OSINT interroge des
   services tiers, d'ou un prix plus haut). Prix de depart, pas des mesures. */
const PRIX_DEFAUT = { scan_token: 0.01, colony_activity: 0.005, swoge_economy: 0.001,
  new_launches: 0.005, wallet_intel: 0.02, osint_lookup: 0.02 };
const VARIABLES = ['ask_agent', 'generate_image'];
const APPELS_PAR_MINUTE = 60;
const TACHE_MAX_CAR = 4000;

function prixUsd(outil) {
  let o = {};
  try { o = JSON.parse(process.env.AGENTIC_PRIX || '{}') || {}; } catch (e) { o = {}; }
  if (Number(o[outil]) > 0) return Number(o[outil]);
  if (outil === 'web_search') return Chat.factureUsd(Rech.PRIX_USD);
  return PRIX_DEFAUT[outil] || null;
}

/** Les définitions publiques : celles de l'agent, plus `ask_agent`. */
function definitions(actifs) {
  const base = Agent.definitions({ recherche: !!(actifs && actifs.recherche) })
    .map((d) => ({ name: d.name, description: d.description, inputSchema: d.input_schema }));
  base.push({ name: 'ask_agent', description: 'Give a whole task to SwogeAgentic (a Claude agent that chains the tools above and answers with the numbers it read, with sources). Billed at its real cost, up to the quoted maximum. Takes 10 to 60 seconds.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'what you want researched, in any language' },
      model: { type: 'string', enum: Chat.MODELES.filter((m) => m.fournisseur === 'anthropic').map((m) => m.id), description: 'optional Claude model (default sonnet-5)' } }, required: ['task'] } });
  base.push({ name: 'generate_image', description: 'Create an image with Grok Imagine or ChatGPT Image. A prompt that names SWOGE is drawn from the official SWOGE character. Billed at its real cost, up to the quoted maximum. Returns image URLs.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'what to draw, in any language' },
      provider: { type: 'string', enum: ['grok', 'openai'], description: 'grok (Grok Imagine, default) or openai (ChatGPT Image)' },
      count: { type: 'integer', enum: [1, 2, 4], description: 'how many images (default 1)' } }, required: ['prompt'] } });
  return base;
}

/** Une entrée invalide est refusée AVANT tout débit. Rend une phrase, ou null. */
function entreeInvalide(outil, a) {
  a = a || {};
  if (outil === 'scan_token' && !/^0x[0-9a-fA-F]{40}$/.test(String(a.address || ''))) return 'address must be 0x followed by 40 hex characters';
  if (outil === 'web_search' && !String(a.query || '').trim()) return 'query is required';
  if (outil === 'ask_agent' && !String(a.task || '').trim()) return 'task is required';
  if (outil === 'ask_agent' && String(a.task).length > TACHE_MAX_CAR) return 'task is too long (max ' + TACHE_MAX_CAR + ' characters)';
  if (outil === 'generate_image' && !String(a.prompt || '').trim()) return 'prompt is required';
  if (outil === 'generate_image' && String(a.prompt).length > TACHE_MAX_CAR) return 'prompt is too long (max ' + TACHE_MAX_CAR + ' characters)';
  if (outil === 'generate_image' && a.provider !== undefined && !['grok', 'openai'].includes(a.provider)) return 'provider must be grok or openai';
  if (outil === 'generate_image' && a.count !== undefined && ![1, 2, 4].includes(Number(a.count))) return 'count must be 1, 2 or 4';
  if ((outil === 'wallet_intel') && !/^0x[0-9a-fA-F]{40}$/.test(String(a.address || ''))) return 'address must be 0x followed by 40 hex characters';
  if (outil === 'osint_lookup' && !String(a.target || '').trim()) return 'target is required';
  return null;
}

/** Le résultat d'un outil, en données (pour une API) ET en texte (pour un modèle). */
function resultatDe(outil, r) {
  if (outil === 'scan_token') return { donnees: { token: r.carte, sources: r.sources || [] }, texte: r.texte };
  if (outil === 'web_search') return { donnees: { results: r.sources || [] }, texte: r.texte };
  try { return { donnees: JSON.parse(r.texte), texte: r.texte }; } catch (e) { return { donnees: null, texte: r.texte }; }
}

function cree(deps) {
  /* deps : { cles (agentic_cles), cours(), solde{reserve,regle}, outils (studio_agent.outils(src)),
             actifs(){recherche}, agent({addr, tache, modele}) → résultat de studio_chat.repond } */
  const rythme = new Map();
  const dec = config.DECIMALS || 18;
  const rythmeOk = (h) => {
    const t = Date.now(), l = (rythme.get(h) || []).filter((x) => t - x < 60000);
    if (l.length >= APPELS_PAR_MINUTE) { rythme.set(h, l); return false; }
    l.push(t); rythme.set(h, l); return true;
  };

  async function catalogue() {
    const cours = await deps.cours();
    /* Les montants en $SWOGE sont des CHAINES exactes (au wei pres), comme
       `factureSwoge` du chat : un nombre JavaScript s'arrondit vers le 15e
       chiffre, et « annonce » doit egaler « debite ». */
    const enSwoge = (usd) => (cours > 0 && usd ? studio.formateBase(studio.montantBaseDe(usd, cours, dec), dec) : null);
    const act = deps.actifs ? deps.actifs() : {};
    return { ok: true, monnaie: '$SWOGE', coursUsd: cours || null,
      outils: definitions(act).map((d) => {
        if (d.name === 'generate_image') {
          const max = Media.pireCasImageUsd('openai', 'qualite', 1);
          return Object.assign({}, d, { prix: { variable: true, maxUsd: Number(max.toFixed(4)), maxSwoge: enSwoge(max), note: 'real cost, up to this maximum for one ChatGPT Image (Grok Imagine costs less)' } });
        }
        if (d.name === 'ask_agent') {
          const m = Chat.modele('sonnet-5');
          const max = Chat.factureUsd(Agent.pireCasUsd(m, [{ content: 'x'.repeat(2000) }], !!act.recherche));
          return Object.assign({}, d, { prix: { variable: true, maxUsd: Number(max.toFixed(4)), maxSwoge: enSwoge(max), note: 'real cost, up to this maximum (Sonnet 5, 2 000-character task)' } });
        }
        const u = prixUsd(d.name);
        return Object.assign({}, d, { prix: { usd: u, swoge: enSwoge(u) } });
      }) };
  }

  /**
   * Un appel d'outil par une clé. `cle` = résultat de cles.resout().
   * `devis: true` rend le prix sans rien débiter.
   */
  async function appelle({ cle, outil, args, devis }) {
    if (!cle) return { ok: false, code: 401, raison: 'missing or revoked API key — create one at swoleeswoge.dog/swogeagentic.html' };
    const defs = definitions(deps.actifs ? deps.actifs() : {});
    if (!defs.some((d) => d.name === outil)) return { ok: false, code: 404, raison: 'unknown tool: ' + outil };
    const inv = entreeInvalide(outil, args);
    if (inv) return { ok: false, code: 400, raison: inv, facture: null };
    const cours = await deps.cours();
    if (!(cours > 0)) return { ok: false, code: 503, raison: 'the $SWOGE price is unavailable — try again shortly' };

    if (outil === 'generate_image') {
      const fournisseur = args.provider === 'openai' ? 'openai' : 'grok', nb = Number(args.count || 1);
      const maxUsd = Media.pireCasImageUsd(fournisseur, 'qualite', nb);
      const maxSwoge = studio.formateBase(studio.montantBaseDe(maxUsd, cours, dec), dec);
      if (devis) return { ok: true, outil, devis: { variable: true, maxSwoge, maxUsd: Number(maxUsd.toFixed(4)) } };
      if (!deps.cles.sousPlafond(cle.h, Number(maxSwoge))) return { ok: false, code: 402, raison: 'this key\'s daily cap does not leave room for this image (up to ' + maxSwoge + ' $SWOGE)' };
      if (!rythmeOk(cle.h)) return { ok: false, code: 429, raison: 'too many calls — max ' + APPELS_PAR_MINUTE + ' per minute per key' };
      if (!deps.image) return { ok: false, code: 503, raison: 'image generation is not switched on yet' };
      const r = await deps.image({ addr: cle.addr, prompt: String(args.prompt), fournisseur, n: nb });
      if (!r || !r.ok) return { ok: false, code: (r && r.code) || 502, raison: (r && r.raison) || 'the image provider failed — you were not charged' };
      const swoge = String(r.factureSwoge);
      const recu = crypto.randomBytes(8).toString('hex');
      deps.cles.depense(cle.h, Number(swoge), { id: recu, outil, swoge, usd: r.factureUsd });
      const urls = (r.urls || []).map((u) => (deps.urlPublique ? deps.urlPublique(u) : u));
      return { ok: true, outil, resultat: { images: urls, provider: fournisseur, understoodAs: r.compris || null, reference: r.reference || null },
               texte: 'Images:\n' + urls.join('\n') + (r.compris ? '\nUnderstood as: ' + r.compris : ''), facture: { swoge, usd: r.factureUsd }, solde: r.solde, recu };
    }

    if (outil === 'ask_agent') {
      const m = Chat.modele(args.model || 'sonnet-5');
      if (!m || m.fournisseur !== 'anthropic') return { ok: false, code: 400, raison: 'model must be a Claude model' };
      const maxUsd = Chat.factureUsd(Agent.pireCasUsd(m, [{ content: String(args.task) }], !!(deps.actifs && deps.actifs().recherche)));
      const maxSwoge = studio.formateBase(studio.montantBaseDe(maxUsd, cours, dec), dec);
      if (devis) return { ok: true, outil, devis: { variable: true, maxSwoge, maxUsd: Number(maxUsd.toFixed(4)) } };
      if (!deps.cles.sousPlafond(cle.h, Number(maxSwoge))) return { ok: false, code: 402, raison: 'this key\'s daily cap does not leave room for this task (up to ' + maxSwoge + ' $SWOGE)' };
      if (!rythmeOk(cle.h)) return { ok: false, code: 429, raison: 'too many calls — max ' + APPELS_PAR_MINUTE + ' per minute per key' };
      const r = await deps.agent({ addr: cle.addr, tache: String(args.task), modele: m.id });
      if (!r.ok) return { ok: false, code: r.code || 502, raison: r.raison || 'the agent failed — you were not charged' };
      const swoge = String(r.factureSwoge);
      const recu = crypto.randomBytes(8).toString('hex');
      deps.cles.depense(cle.h, Number(swoge), { id: recu, outil, swoge, usd: r.factureUsd });
      return { ok: true, outil, resultat: { answer: r.texte, sources: r.sources || [], tokens: r.jetons || [], steps: r.etapes || 1 },
               texte: r.texte, facture: { swoge, usd: r.factureUsd }, solde: r.solde, recu };
    }

    const usd = prixUsd(outil);
    const wei = studio.montantBaseDe(usd, cours, dec);
    const swoge = studio.formateBase(wei, dec);
    if (devis) return { ok: true, outil, devis: { swoge, usd } };
    if (!deps.cles.sousPlafond(cle.h, Number(swoge))) return { ok: false, code: 402, raison: 'this key reached its daily spending cap' };
    if (!rythmeOk(cle.h)) return { ok: false, code: 429, raison: 'too many calls — max ' + APPELS_PAR_MINUTE + ' per minute per key' };
    if (!deps.solde.reserve(cle.addr, wei)) return { ok: false, code: 402, raison: 'balance too low — top up $SWOGE in the Wallet', requisSwoge: swoge };
    let r;
    try { r = await deps.outils[outil](args); }
    catch (e) { deps.solde.regle(cle.addr, wei, 0n); return { ok: false, code: 502, raison: 'the tool failed — you were not charged' }; }
    if (!r || r.erreur) { deps.solde.regle(cle.addr, wei, 0n); return { ok: false, code: 400, raison: (r && r.erreur) || 'the tool returned nothing — you were not charged' }; }
    const solde = deps.solde.regle(cle.addr, wei, wei);
    const recu = crypto.randomBytes(8).toString('hex');
    deps.cles.depense(cle.h, Number(swoge), { id: recu, outil, swoge, usd });
    const res = resultatDe(outil, r);
    return { ok: true, outil, resultat: res.donnees, texte: res.texte, facture: { swoge, usd }, solde, recu };
  }

  return { catalogue, appelle };
}

/* ---- LLMS.TXT : l'API decrite aux agents (format llmstxt.org, relu le 26 septembre 2026) ----
 * Un H1 (le seul obligatoire), un resume en citation, du detail sans titre,
 * puis des listes de liens sous des H2, « Optional » en dernier. Le serveur le
 * sert en direct depuis le catalogue (prix et outils toujours exacts) ; le
 * site en publie une copie, faite par la MEME fonction, avec les prix en $. */
function llmsTxt(cat, u) {
  const outils = (cat && cat.outils) || [];
  const prix = (o) => (o.prix && o.prix.variable ? 'real cost, up to $' + o.prix.maxUsd + (o.prix.maxSwoge && u.swoge ? ' (' + o.prix.maxSwoge + ' $SWOGE)' : '')
    : o.prix ? '$' + o.prix.usd + (o.prix.swoge && u.swoge ? ' (' + o.prix.swoge + ' $SWOGE)' : '') : '?');
  const args = (o) => Object.keys((o.inputSchema && o.inputSchema.properties) || {}).map((k) => k + ((o.inputSchema.required || []).includes(k) ? '' : '?')).join(', ');
  return [
    '# SwogeAgentic',
    '',
    '> Pay-per-call tools for AI agents from SWOGE WORLD: token scans (DexScreener, GoPlus, and what the SWOGE AI colony measured on Robinhood Chain, with sample sizes), the colony\'s newest launches and live activity, wallet and infrastructure OSINT (passive), the $SWOGE economy, web search, image generation and a full research agent. Read-only: nothing here buys, sells or signs. Each call is paid from the key owner\'s $SWOGE balance, within a daily cap they set.',
    '',
    'Get an API key at ' + u.page + ' (sign in with a wallet, set a daily cap; the key is shown once). Send it as `Authorization: Bearer swg_…`.',
    '',
    'REST: `GET ' + u.api + '/agentic/tools` lists tools, prices and input schemas. `POST ' + u.api + '/agentic/call/<tool>` with `{"arguments": {...}}` runs one; add `"quote": true` to get the price without paying. Every paid call returns `facture` (the exact amount billed, as a string), `recu` (a receipt id) and `solde` (the balance left). Refused calls (bad input, tool failure, cap reached) are never billed. Errors: 400 bad input, 401 no/revoked key, 402 balance or daily cap, 404 unknown tool, 429 over 60 calls/minute/key, 502 tool failed, 503 unavailable.',
    '',
    'MCP: Streamable HTTP at `' + u.api + '/mcp` with the same bearer key (protocol 2026-07-28, and 2025-11-25 / 2025-06-18 / 2025-03-26 via initialize). Every tool also takes `quote: true`. Claude Code: `claude mcp add --transport http swogeagentic ' + u.api + '/mcp --header "Authorization: Bearer swg_…"`.',
    '',
    'Tools:',
    '',
  ].concat(outils.map((o) => '- `' + o.name + '(' + args(o) + ')` — ' + prix(o) + '. ' + String(o.description || '').split('. ')[0].replace(/\.$/, '') + '.'))
   .concat(['',
    '## Docs',
    '',
    '- [API documentation](' + u.docs + '): authentication, endpoints, MCP setup, errors, examples',
    '- [Live tool catalogue (JSON)](' + u.api + '/agentic/tools): tools, prices in $ and $SWOGE, input schemas',
    '- [Live llms.txt](' + u.api + '/llms.txt): this file, generated from the live catalogue',
    '',
    '## Optional',
    '',
    '- [SwogeAgentic in the browser](' + u.page + '): the same agent for humans, and where API keys are created',
    '- [SWOGE AI colony](' + u.site + '/swoge_ai.html): the autonomous colony whose measurements these tools return',
    '']).join('\n');
}

module.exports = { cree, definitions, prixUsd, entreeInvalide, llmsTxt, PRIX_DEFAUT, VARIABLES, APPELS_PAR_MINUTE };
