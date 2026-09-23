'use strict';
/* LES COMMANDES DU BOT : /id repond en prive, jamais ailleurs, et le
   decalage avance pour ne pas relire. Contre un faux Telegram. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcmd-'));
process.env.TG_BOT_TOKEN = 'bot-factice';
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; console.log('  ok   ' + m); };

const c = require('./tg_commandes');

(async () => {
  ok(/123456789/.test(c.reponseA({ chat: { id: 123456789, type: 'private' }, text: '/id' })), '/id en prive : l identifiant est dans la reponse');
  ok(/TG_BACKUP_CHAT_ID/.test(c.reponseA({ chat: { id: 123456789, type: 'private' }, text: '/start' })), '/start aussi, et la reponse dit ou le mettre');
  ok(c.reponseA({ chat: { id: 123456789, type: 'private' }, text: '/id@SwogeBot' }), 'la forme /id@SwogeBot passe');
  eq(c.reponseA({ chat: { id: -1001, type: 'supergroup' }, text: '/id' }), null, 'dans un groupe : silence');
  eq(c.reponseA({ chat: { id: -1002, type: 'channel' }, text: '/id' }), null, 'dans un canal : silence');
  eq(c.reponseA({ chat: { id: 5, type: 'private' }, text: 'salut' }), null, 'un autre message : silence');

  const appels = [];
  let maj = [{ update_id: 10, message: { chat: { id: 777, type: 'private' }, text: '/id' } },
             { update_id: 11, message: { chat: { id: -100, type: 'supergroup' }, text: '/id' } },
             { update_id: 12, channel_post: { chat: { id: -200, type: 'channel' }, text: 'annonce' } }];
  const faux = async (url, o) => {
    appels.push({ u: String(url), corps: o && o.body ? JSON.parse(o.body) : null });
    if (/getUpdates/.test(url)) return { ok: true, json: async () => ({ ok: true, result: maj }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  let r = await c.tour({ prendre: faux });
  eq(r.messages, 3, 'trois mises a jour lues');
  eq(r.repondus, 1, 'une seule reponse : le /id prive');
  const env = appels.find((a) => /sendMessage/.test(a.u));
  eq(env.corps.chat_id, 777, 'envoyee au chat prive');
  ok(/777/.test(env.corps.text), 'avec son identifiant');
  ok(!/offset/.test(appels[0].u), 'premiere lecture sans decalage');
  maj = [];
  r = await c.tour({ prendre: faux });
  ok(/offset=13/.test(appels[appels.length - 1].u), 'la lecture suivante reprend apres la derniere mise a jour : rien n est relu');
  eq(r.repondus, 0, 'et ne repond a rien');
  console.log(`tg_commandes.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('  RATE ' + (e.message || e)); process.exit(1); });
