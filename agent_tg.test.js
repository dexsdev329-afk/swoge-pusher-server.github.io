'use strict';
/* LE BOT TELEGRAM D'UN JETON (agent_tg.js, 05/10/2026).
 *
 * Intention (miroir de agent_x) : le jeton du bot est chiffre au repos ; sans clé
 * on REFUSE de stocker ; l'id du groupe est public mais jamais le jeton du bot ;
 * l'agent poste (sendMessage) et épingle (pinChatMessage) ; sans bot relié, ou sur
 * un refus de Telegram, on le dit proprement. fetch injectable : rien ne sort. */

const fs = require('fs'), os = require('os'), path = require('path');
const TG = require('./agent_tg');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T = '0x' + '1'.repeat(40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tg-'));
const BOT = '7654321:AAFhqwertyuiopasdfghjklzxcvbnm12345';
const CHAT = '-1001234567890';

(async () => {
  console.log('-- 1. fail-closed : sans cle de chiffrement, on refuse de stocker --');
  let S = TG.cree({ fichier: path.join(dir, 'a.json'), cle: '' });
  let r = S.connecte(T, { botToken: BOT, chatId: CHAT });
  ok(!r.ok && r.code === 503 && /AGENT_TG_CLE/.test(r.raison), 'pas de cle : 503, aucun secret ecrit');

  S = TG.cree({ fichier: path.join(dir, 'b.json'), cle: 'host-secret' });

  console.log('\n-- 2. formes refusees avant tout stockage --');
  ok(!S.connecte(T, { botToken: 'pas-un-bot', chatId: CHAT }).ok, 'un jeton de bot mal forme : refuse');
  ok(!S.connecte(T, { botToken: BOT, chatId: 'nope' }).ok, 'un chatId mal forme : refuse');

  console.log('\n-- 3. connecte : jeton du bot chiffre, groupe public --');
  r = S.connecte(T, { botToken: BOT, chatId: CHAT, titre: 'SWOGE Fam' });
  ok(r.ok && r.chatId === CHAT, 'relie : chatId rendu');
  ok(S.aDesCreds(T) && S.chatDe(T).chatId === CHAT && S.chatDe(T).titre === 'SWOGE Fam', 'aDesCreds + chatDe public (titre + chatId)');
  const brut = fs.readFileSync(path.join(dir, 'b.json'), 'utf8');
  ok(brut.indexOf(BOT) === -1, 'le jeton du bot n apparait PAS en clair sur le disque');

  console.log('\n-- 4. poste dans le groupe + epingle --');
  let vus = [];
  const faux = async (u, o) => { vus.push({ u: String(u), body: JSON.parse(o.body) });
    if (/sendMessage/.test(String(u))) return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 55 } }) };
    if (/pinChatMessage/.test(String(u))) return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    if (/getChat/.test(String(u))) return { ok: true, status: 200, json: async () => ({ ok: true, result: { title: 'SWOGE Fam', username: 'swogefam', type: 'supergroup' } }) };
    return { ok: false, status: 404, json: async () => ({ ok: false, description: 'nope' }) };
  };
  let p = await S.poste(T, { texte: 'gm fam 🐕', lien: 'https://x.com/i/status/777' }, faux);
  ok(p.ok && p.messageId === 55, 'poste : message_id rendu');
  ok(/\/bot7654321:/.test(vus[0].u) && /sendMessage/.test(vus[0].u) && vus[0].body.chat_id === CHAT && /gm fam/.test(vus[0].body.text) && /x\.com/.test(vus[0].body.text),
     'appel sendMessage au bon bot/chat, texte + lien X dans le corps');
  const pin = await S.pinne(T, 55, faux);
  ok(pin.ok && /pinChatMessage/.test(vus[1].u) && vus[1].body.message_id === 55, 'epingle le bon message');
  const info = await S.chatInfo(T, faux);
  ok(info && info.titre === 'SWOGE Fam' && info.type === 'supergroup', 'chatInfo rend le titre et le type du groupe');

  console.log('\n-- 5. refus propres --');
  p = await S.poste('0x' + '9'.repeat(40), { texte: 'x' }, faux);
  ok(!p.ok && /no Telegram bot/.test(p.raison), 'jeton sans bot relie : pas de post, raison claire');
  const refus = await S.poste(T, { texte: 'x' }, async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: 'bot was blocked' }) }));
  ok(!refus.ok && /bot was blocked|403/.test(refus.raison), 'un refus de Telegram remonte proprement');
  ok(!(await S.pinne(T, 0, faux)).ok, 'un message id invalide a epingler : refuse');

  console.log('\n-- 6. une mauvaise cle ne dechiffre pas (donc ne poste pas) --');
  const mauvaise = TG.cree({ fichier: path.join(dir, 'b.json'), cle: 'autre-cle' });
  ok(!(await mauvaise.poste(T, { texte: 'hi' }, faux)).ok, 'cle differente : creds illisibles, on ne poste pas');

  console.log('\n-- 7. oublie --');
  ok(S.oublie(T).ok && !S.aDesCreds(T), 'oublie retire le bot');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
