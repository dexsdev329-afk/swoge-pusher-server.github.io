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
const GESTE_MIN_MS = 250;
const ACTIONS = ['goto', 'clic', 'defile', 'tape', 'touche', 'retour', 'avance', 'recharge', 'capture'];

function cree(deps) {
  deps = deps || {};
  const url = () => String(deps.url != null ? deps.url : process.env.NAVIGATEUR_URL || '').replace(/\/$/, '');
  const secret = () => String(deps.secret != null ? deps.secret : process.env.NAVIGATEUR_SECRET || '');
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
    const a = String((q && q.action) || '');
    if (!ACTIONS.includes(a)) return { code: 400, corps: { ok: false, raison: 'unknown action' } };
    const t = maintenant(), d = dernier.get(addr) || 0;
    if (t - d < GESTE_MIN_MS) { MESURE.refusRythme++; return { code: 429, corps: { ok: false, raison: 'slow down' } }; }
    dernier.set(addr, t);
    if (dernier.size > 5000) dernier.clear();
    /* Seuls les champs d'un geste passent ; le joueur est celui de la session. */
    const corps = { joueur: addr, action: a, ecran: q.ecran === 'telephone' ? 'telephone' : 'bureau' };
    if (a === 'goto') corps.url = String(q.url || '').slice(0, 2000);
    if (a === 'clic') { corps.x = Number(q.x); corps.y = Number(q.y); }
    if (a === 'defile') corps.dy = Number(q.dy);
    if (a === 'tape') corps.texte = String(q.texte || '').slice(0, 500);
    if (a === 'touche') corps.touche = String(q.touche || '').slice(0, 20);
    MESURE.gestes++;
    try {
      const r = await appelle('/geste', corps);
      if (!r.j) { MESURE.erreurs++; return { code: 502, corps: { ok: false, raison: 'The browser did not answer.' } }; }
      return { code: r.code, corps: r.j };
    } catch (e) { MESURE.erreurs++; return { code: 502, corps: { ok: false, raison: 'The browser is not reachable right now (' + codeDe(e) + ').' } }; }
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
      diag = r.ok && j ? { joignable: true, pret: !!j.ok, sessions: j.sessions, max: j.max } : { joignable: false, code: 'HTTP_' + r.status };
    } catch (e) { diag = { joignable: false, code: codeDe(e) }; }
    return diag;
  }
  return { actif, geste, ferme, sante, MESURE, _codeDe: codeDe };
}
module.exports = { cree, ACTIONS, GESTE_MIN_MS };
