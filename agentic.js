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

const PRIX_DEFAUT = { scan_token: 0.01, colony_activity: 0.005, swoge_economy: 0.001 };
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
  return base;
}

/** Une entrée invalide est refusée AVANT tout débit. Rend une phrase, ou null. */
function entreeInvalide(outil, a) {
  a = a || {};
  if (outil === 'scan_token' && !/^0x[0-9a-fA-F]{40}$/.test(String(a.address || ''))) return 'address must be 0x followed by 40 hex characters';
  if (outil === 'web_search' && !String(a.query || '').trim()) return 'query is required';
  if (outil === 'ask_agent' && !String(a.task || '').trim()) return 'task is required';
  if (outil === 'ask_agent' && String(a.task).length > TACHE_MAX_CAR) return 'task is too long (max ' + TACHE_MAX_CAR + ' characters)';
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

module.exports = { cree, definitions, prixUsd, entreeInvalide, PRIX_DEFAUT, APPELS_PAR_MINUTE };
