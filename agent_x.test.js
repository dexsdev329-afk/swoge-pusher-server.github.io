'use strict';
/* LE COMPTE X D'UN JETON (creds chiffrees + publication).
 *
 * Intention : les jetons d'acces sont chiffres au repos ; sans cle de
 * chiffrement on REFUSE de stocker (fail-closed) ; le handle est public mais
 * jamais les secrets ; la publication signe avec les cles d'app maison + les
 * jetons du jeton ; sans compte relie, ou sans cles d'app, on ne poste pas (et
 * on le dit). fetch injectable : rien ne sort de la machine.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const X = require('./agent_x');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T = '0x' + '1'.repeat(40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-x-'));
const consumer = { ck: 'APPKEY', cs: 'APPSECRET' };

(async () => {
  console.log('-- 1. fail-closed : sans cle de chiffrement, on refuse de stocker --');
  const sansCle = X.cree({ fichier: path.join(dir, 'a.json'), cle: '', consumer });
  let r = sansCle.connecte(T, { accessToken: 'AT', accessSecret: 'AS', handle: '@foocoin' });
  ok(!r.ok && r.code === 503 && /AGENT_X_CLE/.test(r.raison), 'pas de cle : 503, aucun secret ecrit');

  const S = X.cree({ fichier: path.join(dir, 'b.json'), cle: 'host-secret-key', consumer });

  console.log('\n-- 2. connecte : creds chiffrees, handle assaini --');
  r = S.connecte(T, { accessToken: 'AT-123', accessSecret: 'AS-456', handle: '@Foo_Coin!' });
  ok(r.ok && r.handle === 'Foo_Coin', 'relie : handle nettoye (sans @, sans ponctuation)');
  ok(S.aDesCreds(T) && S.handleDe(T) === 'Foo_Coin', 'aDesCreds vrai, handleDe rend le handle public');
  const brut = fs.readFileSync(path.join(dir, 'b.json'), 'utf8');
  ok(!/AT-123/.test(brut) && !/AS-456/.test(brut), 'ni le token ni le secret d acces n apparaissent EN CLAIR sur le disque');

  console.log('\n-- 3. une mauvaise cle ne dechiffre pas (donc ne poste pas) --');
  const mauvaise = X.cree({ fichier: path.join(dir, 'b.json'), cle: 'autre-cle', consumer });
  let p = await mauvaise.poste(T, { texte: 'hi' }, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { id: '1' } }) }) });
  ok(p.surX === false, 'cle de chiffrement differente : creds illisibles, on ne poste pas');

  console.log('\n-- 4. publication : signe avec app maison + jetons du jeton --');
  let vu = null;
  p = await S.poste(T, { texte: 'gm from $FOO', mediaId: '42' }, { fetch: async (u, o) => { vu = { u, o }; return { ok: true, status: 200, json: async () => ({ data: { id: '777' } }) }; } });
  ok(p.surX === true && p.id === '777' && p.url === 'https://x.com/Foo_Coin/status/777', 'poste : surX, id, url avec le handle du jeton');
  ok(/\/2\/tweets$/.test(vu.u) && /OAuth /.test(vu.o.headers.authorization) && /oauth_consumer_key="APPKEY"/.test(vu.o.headers.authorization),
     'appel /2/tweets signe OAuth avec la cle d app maison');
  ok(/gm from \$FOO/.test(vu.o.body) && /"media_ids":\["42"\]/.test(vu.o.body), 'le corps porte le texte et le media');

  console.log('\n-- 5. refus propres --');
  p = await S.poste('0x' + '9'.repeat(40), { texte: 'x' }, { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  ok(p.surX === false && /no usable X account/.test(p.raison), 'jeton sans compte relie : pas de post, raison claire');
  const sansApp = X.cree({ fichier: path.join(dir, 'b.json'), cle: 'host-secret-key', consumer: { ck: '', cs: '' } });
  p = await sansApp.poste(T, { texte: 'x' }, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { id: '1' } }) }) });
  ok(p.surX === false && /app keys/.test(p.raison), 'sans cles d app maison : pas de post, on le dit');
  const httpErr = await S.poste(T, { texte: 'x' }, { fetch: async () => ({ ok: false, status: 403, json: async () => ({ detail: 'Forbidden' }) }) });
  ok(httpErr.surX === false && /403/.test(httpErr.raison), 'un refus de X : surX false, le code remonte');

  console.log('\n-- 5b. lire les mentions + repondre (engagement) --');
  let capt = null;
  const fauxX = async (u, o) => {
    const s = String(u);
    if (/\/2\/users\/me/.test(s)) return { ok: true, status: 200, json: async () => ({ data: { id: '999', username: 'Foo_Coin' } }) };
    if (/\/2\/users\/999\/mentions/.test(s)) return { ok: true, status: 200, json: async () => ({
      data: [{ id: '111', text: 'gm @Foo_Coin love the project', author_id: '42', created_at: 't' }, { id: '222', text: 'me talking to myself', author_id: '999' }],
      includes: { users: [{ id: '42', username: 'alice' }] } }) };
    if (/\/2\/tweets/.test(s)) { capt = o; return { ok: true, status: 200, json: async () => ({ data: { id: '333' } }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const ms = await S.mentions(T, { max: 10 }, fauxX);
  ok(ms.length === 1 && ms[0].id === '111' && ms[0].auteur === 'alice' && /love the project/.test(ms[0].texte), 'mentions : le tweet d un tiers, avec son handle ; le sien est filtre');
  const rep = await S.repond(T, { texte: 'thank you! 🐕', replyToId: '111' }, fauxX);
  ok(rep.ok && rep.id === '333' && rep.url === 'https://x.com/Foo_Coin/status/333', 'repond : ok, url avec le handle du jeton');
  ok(/"in_reply_to_tweet_id":"111"/.test(capt.body) && /thank you/.test(capt.body), 'le corps est bien une REPONSE au bon tweet');
  ok((await S.repond(T, { texte: 'x', replyToId: 'not-a-number' }, fauxX)).ok === false, 'une cible de reponse invalide est refusee');
  ok((await S.repond(T, { texte: '', replyToId: '111' }, fauxX)).ok === false, 'une reponse vide est refusee');
  ok((await S.mentions('0x' + '9'.repeat(40), {}, fauxX)).length === 0, 'un jeton sans compte relie : aucune mention');

  console.log('\n-- 6. oublie --');
  ok(S.oublie(T).ok && !S.aDesCreds(T), 'oublie retire le compte');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
