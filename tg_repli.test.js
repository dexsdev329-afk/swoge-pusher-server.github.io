'use strict';
/*
 * telegram.js : le repli « texte seul » que les annonces supposent (relecture
 * du 12/10/2026). Les annonces de communaute partent par notifyPhoto(url ou
 * null, legende) : sans image sur le volume, l URL est null ; une URL refusee
 * par Telegram (404, format) ou injoignable doit laisser partir le TEXTE.
 * Aucune suite ne l essayait : `if (!photo) return;` ou un refus sans repli
 * laissaient tout vert (mutants T01, T02). fetch est espionne, aucune requete
 * ne sort.
 */
process.env.TG_BOT_TOKEN = 'jeton-de-test';
process.env.TG_CHAT_ID = '-100999';
const envois = [];
let mode = 'ok';
global.fetch = async (url, opt) => {
  const route = String(url).split('/').pop();
  const b = JSON.parse(opt.body);
  envois.push({ route, texte: b.text || b.caption, photo: b.photo || null });
  if (route === 'sendPhoto' && mode === 'refus') return { json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' }) };
  if (route === 'sendPhoto' && mode === 'reseau') throw new Error('ECONNRESET');
  return { json: async () => ({ ok: true }) };
};
const tg = require('./telegram');
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
/* la file de telegram.js espace les envois de 400 ms : on attend le message, pas une duree fixe */
async function attendsTexte(texte, max = 8000) {
  const fin = Date.now() + max;
  while (Date.now() < fin) { if (envois.some((e) => e.route === 'sendMessage' && e.texte === texte)) return true; await attendre(50); }
  return false;
}
let n = 0, rates = 0;
const ok = (c, m) => { if (c) n++; else { rates++; console.log('  RATE ' + m); } };

(async () => {
  tg.notifyPhoto(null, 'A sans image');
  ok(await attendsTexte('A sans image'), 'notifyPhoto(null) : part en texte seul : ' + JSON.stringify(envois));
  ok(!envois.some((e) => e.route === 'sendPhoto' && e.texte === 'A sans image'), 'notifyPhoto(null) : aucun sendPhoto tente');

  mode = 'refus';
  tg.notifyPhoto('https://x.exemple/communaute/image/nouveau-v1.png', 'B refusee');
  ok(await attendsTexte('B refusee'), 'photo refusee par Telegram : la legende part quand meme en texte : ' + JSON.stringify(envois));
  ok(envois.some((e) => e.route === 'sendPhoto' && e.texte === 'B refusee'), 'photo refusee : la photo a bien ete tentee d abord');

  mode = 'reseau';
  tg.notifyPhoto('https://x.exemple/communaute/image/paper-v1.png', 'C injoignable');
  ok(await attendsTexte('C injoignable'), 'photo injoignable (reseau) : le texte part quand meme');

  mode = 'ok';
  tg.notifyPhoto('https://x.exemple/communaute/image/believer-v1.png', 'D acceptee');
  for (let fin = Date.now() + 8000; Date.now() < fin && !envois.some((e) => e.texte === 'D acceptee');) await attendre(50);
  await attendre(900);                                   // un doublon texte eventuel aurait eu le temps de partir
  ok(envois.filter((e) => e.texte === 'D acceptee').length === 1 && envois.some((e) => e.route === 'sendPhoto' && e.texte === 'D acceptee'),
     'photo acceptee : UN envoi, la photo, pas de doublon texte');

  if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
  console.log(`tg_repli.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
