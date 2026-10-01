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
    } catch (e) { MESURE.erreurs++; return { code: 502, corps: { ok: false, raison: 'The browser is not reachable right now.' } }; }
  }
  async function ferme(addr) {
    if (!actif()) return { code: 200, corps: { ok: true } };
    try { await appelle('/ferme', { joueur: addr }); } catch (e) { /* il fermera seul apres son delai */ }
    return { code: 200, corps: { ok: true } };
  }
  return { actif, geste, ferme, MESURE };
}
module.exports = { cree, ACTIONS, GESTE_MIN_MS };
