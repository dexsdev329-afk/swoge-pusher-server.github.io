'use strict';
/* ==================================================================
 * LIER LE COMPTE X D'UN JETON — côté CRÉATEUR, sans clé admin
 * ==================================================================
 *
 * Demande du propriétaire (05/10/2026) : « branche la liaison du compte X côté
 * créateur ». Jusqu'ici seul le propriétaire pouvait relier un compte X
 * (/agent/x/connect, jetons d'accès fournis à la main). Le créateur, lui, doit
 * pouvoir relier le compte X de SON jeton depuis le launchpad — sans jamais
 * nous confier ses jetons d'accès, et sans clé admin.
 *
 * LE TANGO À TROIS PATTES D'OAUTH 1.0a, EN MODE « PIN » (oob) :
 *
 *   1. debut() — on demande un jeton temporaire (oauth/request_token) avec les
 *      clés d'APP maison et oauth_callback=oob. X rend un oauth_token + son
 *      secret, et une URL d'autorisation.
 *   2. Le créateur ouvre l'URL, autorise le compte X de son jeton, et X lui
 *      montre un PIN à 7 chiffres.
 *   3. fin() — on échange (oauth/access_token) le jeton temporaire + le PIN
 *      contre les VRAIS jetons d'accès du compte, qu'on chiffre aussitôt
 *      (agent_x.connecte). Le PIN prouve que le créateur a bien autorisé.
 *
 * Le mode « oob » (PIN) ne demande AUCUNE URL de rappel enregistrée côté app :
 * il marche quel que soit le réglage de l'app X, ce qui le rend déployable sans
 * rien toucher chez X.
 *
 * Aucun secret n'est écrit ici : ce module ne fait que la poignée de main. Les
 * jetons obtenus repartent vers agent_x.connecte, qui les chiffre au repos.
 * `fetch` et `signe` sont injectables : l'essai tourne hors-ligne.
 * ================================================================== */

const xp = require('./x_post');

const API = 'https://api.x.com';

/* Un corps x-www-form-urlencoded (request_token / access_token le rendent ainsi,
   pas du JSON) → un objet plat. */
function formEnObjet(texte) {
  const o = {};
  for (const [k, v] of new URLSearchParams(String(texte || ''))) o[k] = v;
  return o;
}

function cree(opts) {
  opts = opts || {};
  const appCles = () => opts.consumer || { ck: process.env.X_CONSUMER_KEY || '', cs: process.env.X_CONSUMER_SECRET || '' };
  const signe = opts.signe || xp.signeOAuth;
  const fetchDe = (deps) => (deps && deps.fetch) || opts.fetch || (typeof fetch === 'function' ? fetch : null);

  /** Étape 1 : un jeton de requête + l'URL d'autorisation (mode PIN).
   *  Rend { ok, oauth_token, oauth_token_secret, authorizeUrl } ou { ok:false, ... }. */
  async function debut(deps) {
    const app = appCles();
    if (!app.ck || !app.cs) return { ok: false, code: 503, raison: 'house X app keys (X_CONSUMER_KEY/SECRET) are not configured' };
    const f = fetchDe(deps); if (!f) return { ok: false, code: 503, raison: 'no fetch available' };
    const url = API + '/oauth/request_token';
    /* Pas de jeton d'accès (at absent) ; le secret de signature est cs & "" ;
       oauth_callback=oob entre dans la signature et dans l'en-tête. */
    const s = signe('POST', url, {}, { ck: app.ck, cs: app.cs, as: '' }, { oauthExtra: { oauth_callback: 'oob' } });
    let r;
    try { r = await f(url, { method: 'POST', headers: { authorization: s.entete }, signal: AbortSignal.timeout(20000) }); }
    catch (e) { return { ok: false, code: 503, raison: 'could not reach X to start linking' }; }
    const corps = formEnObjet(await r.text().catch(() => ''));
    if (!r.ok || !corps.oauth_token || !corps.oauth_token_secret) {
      return { ok: false, code: 502, raison: 'X did not return a request token (HTTP ' + r.status + ')' };
    }
    return { ok: true, oauth_token: corps.oauth_token, oauth_token_secret: corps.oauth_token_secret,
      authorizeUrl: API + '/oauth/authorize?oauth_token=' + encodeURIComponent(corps.oauth_token) };
  }

  /** Étape 3 : échange le jeton temporaire + le PIN contre les jetons d'accès.
   *  Rend { ok, accessToken, accessSecret, handle } ou { ok:false, ... }. */
  async function fin(oauthToken, oauthTokenSecret, pin, deps) {
    const app = appCles();
    if (!app.ck || !app.cs) return { ok: false, code: 503, raison: 'house X app keys are not configured' };
    const verifier = String(pin || '').trim();
    if (!oauthToken || !oauthTokenSecret) return { ok: false, code: 400, raison: 'the linking session expired — start again' };
    if (!/^[0-9a-zA-Z]{4,12}$/.test(verifier)) return { ok: false, code: 400, raison: 'enter the PIN X showed you' };
    const f = fetchDe(deps); if (!f) return { ok: false, code: 503, raison: 'no fetch available' };
    const url = API + '/oauth/access_token';
    /* Le jeton temporaire sert de oauth_token ; son secret entre dans la clé de
       signature ; oauth_verifier=PIN entre dans la signature et dans l'en-tête. */
    const s = signe('POST', url, {}, { ck: app.ck, cs: app.cs, at: oauthToken, as: oauthTokenSecret },
      { oauthExtra: { oauth_verifier: verifier } });
    let r;
    try { r = await f(url, { method: 'POST', headers: { authorization: s.entete }, signal: AbortSignal.timeout(20000) }); }
    catch (e) { return { ok: false, code: 503, raison: 'could not reach X to finish linking' }; }
    const corps = formEnObjet(await r.text().catch(() => ''));
    if (!r.ok || !corps.oauth_token || !corps.oauth_token_secret) {
      return { ok: false, code: 502, raison: 'X rejected the PIN — check it and try again' };
    }
    return { ok: true, accessToken: corps.oauth_token, accessSecret: corps.oauth_token_secret,
      handle: corps.screen_name || null };
  }

  return { debut, fin };
}

module.exports = { cree, API, formEnObjet };
