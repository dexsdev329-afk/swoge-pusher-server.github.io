'use strict';
/* LIER LE COMPTE X CÔTÉ CRÉATEUR (agent_x_oauth.js, 05/10/2026).
 *
 * Intention : le tango à trois pattes d'OAuth 1.0a en mode PIN (oob) — un jeton
 * de requête puis l'échange du PIN contre les vrais jetons d'accès — pour que le
 * créateur relie le compte X de SON jeton sans clé admin et sans nous confier ses
 * secrets. On tient : les bonnes requêtes signées (request_token sans jeton mais
 * avec oauth_callback ; access_token avec oauth_verifier), et les refus propres.
 * Hors-ligne : fetch est un bouchon, aucune requête ne sort. */

const oauth = require('./agent_x_oauth');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const APP = { ck: 'APPKEY', cs: 'APPSECRET' };

/* Un faux X : capte chaque requête, rend un corps x-www-form-urlencoded. */
function fauxX(repertoire) {
  const vus = [];
  const f = async (url, o) => {
    const u = String(url); vus.push({ url: u, auth: (o && o.headers && o.headers.authorization) || '' });
    const rep = repertoire[u.replace(/\?.*$/, '')];
    if (!rep) return { ok: false, status: 404, text: async () => '' };
    return { ok: rep.ok !== false, status: rep.status || 200, text: async () => rep.body };
  };
  return { f, vus };
}

async function main() {
  console.log('-- formEnObjet lit un corps x-www-form-urlencoded --');
  const o = oauth.formEnObjet('oauth_token=abc&oauth_token_secret=def&oauth_callback_confirmed=true');
  ok(o.oauth_token === 'abc' && o.oauth_token_secret === 'def' && o.oauth_callback_confirmed === 'true', 'les paires sont extraites');

  console.log('\n-- étape 1 : request_token (mode PIN) --');
  let X = fauxX({ 'https://api.x.com/oauth/request_token': { body: 'oauth_token=TEMP&oauth_token_secret=TEMPSEC&oauth_callback_confirmed=true' } });
  let ox = oauth.cree({ consumer: APP, fetch: X.f });
  let r = await ox.debut();
  ok(r.ok && r.oauth_token === 'TEMP' && r.oauth_token_secret === 'TEMPSEC', 'un jeton temporaire + son secret sont rendus');
  ok(r.authorizeUrl === 'https://api.x.com/oauth/authorize?oauth_token=TEMP', 'l URL d autorisation porte le jeton temporaire');
  const authDebut = X.vus[0].auth;
  ok(/oauth_callback="oob"/.test(authDebut), 'la requête signée porte oauth_callback="oob" (aucune URL de rappel à enregistrer)');
  ok(!/oauth_token=/.test(authDebut), 'request_token n a PAS de oauth_token (on ne l a pas encore)');
  ok(/oauth_consumer_key="APPKEY"/.test(authDebut) && /oauth_signature=/.test(authDebut), 'elle est signée avec la clé d APP');

  console.log('\n-- étape 3 : access_token (PIN → vrais jetons) --');
  X = fauxX({ 'https://api.x.com/oauth/access_token': { body: 'oauth_token=ACCESS&oauth_token_secret=ACCESSSEC&screen_name=foocoin&user_id=42' } });
  ox = oauth.cree({ consumer: APP, fetch: X.f });
  r = await ox.fin('TEMP', 'TEMPSEC', '1234567');
  ok(r.ok && r.accessToken === 'ACCESS' && r.accessSecret === 'ACCESSSEC', 'le PIN est échangé contre les vrais jetons d accès');
  ok(r.handle === 'foocoin', 'le handle (screen_name) est rendu');
  const authFin = X.vus[0].auth;
  ok(/oauth_verifier="1234567"/.test(authFin), 'la requête porte oauth_verifier=le PIN');
  ok(/oauth_token="TEMP"/.test(authFin), 'elle porte le jeton temporaire comme oauth_token');

  console.log('\n-- refus propres --');
  ox = oauth.cree({ consumer: { ck: '', cs: '' }, fetch: X.f });
  r = await ox.debut();
  ok(!r.ok && r.code === 503, 'sans clés d APP maison : 503');
  ox = oauth.cree({ consumer: APP, fetch: fauxX({ 'https://api.x.com/oauth/request_token': { ok: false, status: 401, body: 'error' } }).f });
  r = await ox.debut();
  ok(!r.ok && r.code === 502, 'X refuse le jeton de requête : 502');
  ox = oauth.cree({ consumer: APP, fetch: X.f });
  r = await ox.fin('TEMP', 'TEMPSEC', 'xx');
  ok(!r.ok && r.code === 400, 'un PIN mal formé : 400 (aucune requête)');
  r = await ox.fin('', '', '1234567');
  ok(!r.ok && r.code === 400, 'session de liaison perdue : 400');
  ox = oauth.cree({ consumer: APP, fetch: fauxX({ 'https://api.x.com/oauth/access_token': { ok: false, status: 401, body: 'bad verifier' } }).f });
  r = await ox.fin('TEMP', 'TEMPSEC', '7654321');
  ok(!r.ok && r.code === 502, 'X rejette le PIN : 502');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
