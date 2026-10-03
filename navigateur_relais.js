'use strict';
/* ==================================================================
 * LE RELAIS VERS LE NAVIGATEUR (30 septembre 2026)
 * ==================================================================
 * Le joueur ne parle jamais au service navigateur : il parle au serveur du jeu, qui lit
 * SA session (l'adresse vient du jeton, jamais du corps) et relaie avec le secret partage.
 * Tant que NAVIGATEUR_URL / NAVIGATEUR_SECRET manquent, l'onglet dit que le navigateur
 * n'est pas encore branche — et rien d'autre ne change.
 * Un geste par joueur toutes les GESTE_MIN_MS (le service fait deja la file) : un clic
 * frenetique ne coute pas une capture chacun.
 * ================================================================== */
const GESTE_MIN_MS = 250, CLAVIER_MIN_MS = 30;
/* La liste des gestes et le filtre des champs vivent dans navigateur_direct.js (02/10) : le
   navigateur, qui recoit maintenant aussi les gestes en direct, filtre avec le meme code. */
const Direct = require('./navigateur_direct');
const ACTIONS = Direct.ACTIONS;

function cree(deps) {
  deps = deps || {};
  const url = () => String(deps.url != null ? deps.url : process.env.NAVIGATEUR_URL || '').replace(/\/$/, '');
  const secret = () => String(deps.secret != null ? deps.secret : process.env.NAVIGATEUR_SECRET || '');
  /* L'adresse PUBLIQUE du navigateur (02/10) : sans elle, pas de ticket, la page passe par le relais. */
  const publique = () => String(deps.publique != null ? deps.publique : process.env.NAVIGATEUR_PUBLIC_URL || '').replace(/\/$/, '');
  const lire = deps.fetch || fetch;
  const maintenant = deps.maintenant || Date.now;
  const dernier = new Map();
  const MESURE = { gestes: 0, refusRythme: 0, erreurs: 0 };
  const actif = () => !!(url() && secret());

  async function appelle(chemin, corps) {
    const r = await lire(url() + chemin, { method: 'POST', headers: { 'content-type': 'application/json', 'x-navigateur-secret': secret() },
      body: JSON.stringify(corps), signal: AbortSignal.timeout(35000) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    return { code: r.status, j };
  }
  /** Un geste du joueur `addr` (adresse de SESSION). Rend { code, corps }. */
  async function geste(addr, q) {
    if (!actif()) return { code: 503, corps: { ok: false, raison: 'The browser is not connected yet.' } };
    const champs = Direct.champs(q);
    if (!champs) return { code: 400, corps: { ok: false, raison: 'unknown action' } };
    const t = maintenant(), d = dernier.get(addr) || 0;
    /* 03/10 : une frappe ne charge rien et ne capture rien (flux) : 30 ms entre deux, pas 250. */
    if (t - d < (Direct.CLAVIER.has(champs.action) ? CLAVIER_MIN_MS : GESTE_MIN_MS)) { MESURE.refusRythme++; return { code: 429, corps: { ok: false, raison: 'slow down' } }; }
    dernier.set(addr, t);
    if (dernier.size > 5000) dernier.clear();
    /* Seuls les champs d'un geste passent ; le joueur est celui de la session.
       02/10 : `flux` — le client recoit les images par /image, le geste ne les attend plus. */
    const corps = Object.assign({ joueur: addr }, champs);
    MESURE.gestes++;
    try {
      const r = await appelle('/geste', corps);
      if (!r.j) { MESURE.erreurs++; return { code: 502, corps: { ok: false, raison: 'The browser did not answer.' } }; }
      return { code: r.code, corps: r.j };
    } catch (e) { MESURE.erreurs++; return { code: 502, corps: { ok: false, raison: 'The browser is not reachable right now (' + codeDe(e) + ').' } }; }
  }
  /* ---- LE FLUX (02/10/2026) : la derniere image, en longue attente ----
   * Pas la cadence des gestes (une image n'agit sur rien), mais deux demandes en vol au plus
   * par joueur : un onglet ouvert deux fois ne double pas le debit, il attend son tour. */
  const enVol = new Map();
  async function image(addr, q) {
    if (!actif()) return { code: 503, corps: { ok: false, raison: 'The browser is not connected yet.' } };
    const n = enVol.get(addr) || 0;
    if (n >= 2) { MESURE.refusRythme++; return { code: 429, corps: { ok: false, raison: 'slow down' } }; }
    enVol.set(addr, n + 1);
    try {
      const corps = { joueur: addr, apres: Math.max(0, Number(q && q.apres) || 0), attente: Math.max(0, Math.min(10000, Number(q && q.attente) || 0)) };
      const r = await appelle('/image', corps);
      if (!r.j) { MESURE.erreurs++; return { code: 502, corps: { ok: false, raison: 'The browser did not answer.' } }; }
      MESURE.images = (MESURE.images || 0) + (r.j.image ? 1 : 0);
      return { code: r.code, corps: r.j };
    } catch (e) { MESURE.erreurs++; return { code: 502, corps: { ok: false, raison: 'The browser is not reachable right now (' + codeDe(e) + ').' } }; }
    finally { const m = (enVol.get(addr) || 1) - 1; if (m > 0) enVol.set(addr, m); else enVol.delete(addr); }
  }
  /** Le ticket de la liaison directe (navigateur_direct.js) pour le joueur `addr` (SESSION). */
  function ticket(addr) {
    if (!actif() || !publique()) return { code: 404, corps: { ok: false, raison: 'no direct link — use the relay' } };
    const t = Direct.signe(secret(), addr, maintenant());
    if (!t) return { code: 400, corps: { ok: false, raison: 'no player' } };
    MESURE.tickets = (MESURE.tickets || 0) + 1;
    return { code: 200, corps: { ok: true, url: publique(), ticket: t.ticket, dureeMs: t.dureeMs } };
  }
  async function ferme(addr) {
    if (!actif()) return { code: 200, corps: { ok: true } };
    try { await appelle('/ferme', { joueur: addr }); } catch (e) { /* il fermera seul apres son delai */ }
    return { code: 200, corps: { ok: true } };
  }
  /* Le diagnostic (01/10) : au premier branchement en ligne, « The browser is not reachable » sans
     autre detail. Ce qui coince se dit par un CODE (nom introuvable, connexion refusee, delai) —
     jamais l'adresse ni le secret. Lu au plus toutes les 15 s. */
  let diag = null, diagT = 0;
  const codeDe = (e) => { const c = e && (e.cause && (e.cause.code || e.cause.name) || e.code || e.name); return String(c || 'ERROR').slice(0, 40); };
  async function sante() {
    if (!actif()) return { joignable: false, code: 'NOT_CONFIGURED' };
    if (diag && maintenant() - diagT < 15000) return diag;
    diagT = maintenant();
    try {
      const r = await lire(url() + '/sante', { signal: AbortSignal.timeout(5000) });
      const j = await r.json().catch(() => null);
      /* Les durees des gestes (02/10) : moyenne et pire par action, rien d'autre — ni adresse,
         ni page, ni erreur detaillee. C'est ce qui permet de dire si « lent » a change. */
      const m = (j && j.mesure) || {}, pa = {};
      for (const k in (m.parAction || {})) { const o = m.parAction[k]; if (o && o.n) pa[k] = { n: o.n, msMoyen: Math.round(o.ms / o.n), msMax: o.max }; }
      diag = r.ok && j ? { joignable: true, pret: !!j.ok, sessions: j.sessions, max: j.max,
                           mesure: { gestes: m.gestes || 0, msMoyen: m.gestes ? Math.round((m.msTotal || 0) / m.gestes) : null,
                                     images: m.images || 0, dnsCache: m.dnsCache || 0, parAction: pa } }
                       : { joignable: false, code: 'HTTP_' + r.status };
    } catch (e) { diag = { joignable: false, code: codeDe(e) }; }
    return diag;
  }
  return { actif, geste, image, ferme, sante, ticket, MESURE, _codeDe: codeDe };
}
module.exports = { cree, ACTIONS, GESTE_MIN_MS };
