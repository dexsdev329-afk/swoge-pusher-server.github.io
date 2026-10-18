'use strict';
/*
 * « SWOGE ME » (18/10/2026), contre un faux Telegram et une fausse retouche :
 *   1. un nouveau membre de @swoleswoge recoit un accueil avec SON bouton ; un bot,
 *      un autre groupe, un membre deja accueilli : rien ;
 *   2. seul le membre vise peut cliquer ; sans photo visible, on le lui dit et
 *      rien n'est consomme ;
 *   3. le portrait part dans le groupe, en reponse a l'accueil, et UNE seule fois
 *      par personne ; une panne ne prend pas le droit, deux pannes l'epuisent ;
 *   4. le plafond du jour compte les portraits en route ; TG_SWOGEME=0 eteint ;
 *   5. aucune photo n'est ecrite sur le disque, seulement l'identifiant, l'heure et le cout.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

delete process.env.TG_SWOGEME; delete process.env.TG_SWOGEME_CHATS;
process.env.TG_SWOGEME_JOUR = '2';
const S = require('./tg_swogeme');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
function monde(o) {
  const opt = o || {};
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'swogeme-'));
  const appels = [];
  const photos = opt.photos || { 11: true, 12: true, 13: true, 14: true };
  const prendre = async (url, init) => {
    const m = /\/bot[^/]+\/(\w+)$/.exec(url);
    if (/\/file\/bot/.test(url)) { appels.push({ methode: 'fichier', url }); return { ok: true, arrayBuffer: async () => JPEG }; }
    const methode = m && m[1];
    const corps = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const forme = init && init.body && typeof init.body.get === 'function' ? init.body : null;
    appels.push({ methode, corps, forme });
    const rep = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
    if (methode === 'getUserProfilePhotos') return rep({ total_count: photos[corps.user_id] ? 1 : 0, photos: photos[corps.user_id] ? [[{ file_id: 'petite', width: 160, height: 160 }, { file_id: 'grande-' + corps.user_id, width: 640, height: 640 }]] : [] });
    if (methode === 'getFile') return rep({ file_id: corps.file_id, file_path: 'photos/' + corps.file_id + '.jpg', file_size: JPEG.length });
    if (methode === 'sendPhoto' && opt.sendPhotoCasse) return { ok: true, json: async () => ({ ok: false, description: 'Bad Request' }) };
    return rep(true);
  };
  const retouches = [];
  const retouche = async ({ image, prompt }) => {
    retouches.push({ image, prompt });
    if (opt.retoucheCasse) throw new Error('OpenAI 500');
    return { url: 'data:image/png;base64,' + Buffer.from('portrait').toString('base64'), coutUsd: 0.053 };
  };
  const X = S.cree({ jeton: () => 'JETON', dossier, prendre, retouche, actif: () => opt.actif !== false, attendre: true, maintenant: () => opt.t || Date.parse('2026-10-18T12:00:00Z') });
  return { X, appels, retouches, dossier };
}
const groupe = { id: -1001, type: 'supergroup', username: 'swoleswoge' };
const membre = (id, nom) => ({ id, is_bot: false, first_name: nom || 'Ana' });
const clicDe = (uid, deQui, msgId) => ({ id: 'cb' + Math.random(), data: 'swogeme:' + uid, from: membre(deQui), message: { message_id: msgId || 500, chat: groupe } });

(async () => {
  console.log('-- 1. l accueil');
  let M = monde();
  let r = await M.X.message({ chat: groupe, new_chat_members: [membre(11, 'Ana'), { id: 99, is_bot: true, first_name: 'Bot' }] });
  eq(r && r.accueil, 1, 'un accueil, le bot ignore');
  const acc = M.appels.find((a) => a.methode === 'sendMessage');
  ok(acc && /Welcome to the pack, Ana/.test(acc.corps.text) && /One per person/.test(acc.corps.text) && /posted here/.test(acc.corps.text), 'texte anglais : bienvenue, publie ici, une par personne');
  const bouton = acc.corps.reply_markup.inline_keyboard[0][0];
  ok(bouton.callback_data === 'swogeme:11' && /Swoge me/.test(bouton.text), 'son bouton, a son identifiant');
  eq(await M.X.message({ chat: groupe, new_chat_members: [membre(11)] }), null, 'deja accueilli : pas un second accueil');
  eq(await M.X.message({ chat: { id: -2, type: 'supergroup', username: 'autre' }, new_chat_members: [membre(12)] }), null, 'un autre groupe : rien');
  eq(await M.X.message({ chat: { id: 5, type: 'private' }, new_chat_members: [membre(12)] }), null, 'un prive : rien');
  r = await M.X.message({ chat: groupe, new_chat_members: [membre(21, 'A'), membre(22, 'B'), membre(23, 'C'), membre(24, 'D')] });
  eq(r.accueil, 3, 'trois boutons au plus par accueil');
  ok(M.appels.filter((a) => a.methode === 'sendMessage').pop().corps.reply_markup.inline_keyboard.every((l) => / — /.test(l[0].text)), 'plusieurs : chaque bouton porte son nom');

  console.log('-- 2. le clic');
  M = monde({ photos: { 11: true } });
  eq(await M.X.clic(clicDe(11, 12)), 'pas pour toi', 'un autre membre ne peut pas cliquer');
  eq(M.retouches.length, 0, 'et rien n est fabrique');
  eq(await M.X.clic(clicDe(13, 13)), 'sans photo', 'sans photo visible : on le dit');
  ok(/Privacy/.test(M.appels.filter((a) => a.methode === 'sendMessage').pop().corps.text), 'avec le chemin du reglage');
  ok(!M.X.lis().faits[13] && !M.X.lis().essais[13], 'et rien n est consomme');

  console.log('-- 3. le portrait');
  eq(await M.X.clic(clicDe(11, 11, 777)), 'livre', 'Ana clique : portrait livre');
  const rt = M.retouches[0];
  ok(rt && /^data:image\/jpeg;base64,/.test(rt.image), 'la retouche recoit SA photo (la plus grande)');
  ok(M.appels.some((a) => a.methode === 'getFile' && a.corps.file_id === 'grande-11'), 'la plus grande taille est lue');
  ok(/furry dog paws/.test(rt.prompt) && /No human face/.test(rt.prompt) && /No text/.test(rt.prompt), 'le prompt : pattes, aucun visage humain, aucun texte');
  const ph = M.appels.find((a) => a.methode === 'sendPhoto');
  ok(ph && ph.forme.get('chat_id') === String(groupe.id) && /Ana just got SWOGED/.test(ph.forme.get('caption')), 'la photo part dans le groupe, legende anglaise');
  eq(JSON.parse(ph.forme.get('reply_parameters')).message_id, 777, 'en reponse a l accueil');
  const f = M.X.lis().faits[11];
  ok(f && f.coutUsd === 0.053 && f.chat === groupe.id, 'le journal garde l heure, le groupe et le cout reel');
  eq(await M.X.clic(clicDe(11, 11)), 'deja fait', 'une seule fois par personne');
  const surDisque = fs.readdirSync(M.dossier);
  ok(surDisque.length === 1 && surDisque[0] === 'tg_swogeme.json' && !/base64|ffd8/.test(fs.readFileSync(path.join(M.dossier, surDisque[0]), 'utf8')), 'aucune photo sur le disque, seulement le journal');

  M = monde({ retoucheCasse: true });
  eq(await M.X.clic(clicDe(12, 12)), 'rate', 'une panne d OpenAI');
  ok(!M.X.lis().faits[12] && M.X.lis().essais[12] === 1, 'le droit n est pas pris, l essai est compte');
  ok(/tap the button again/.test(M.appels.filter((a) => a.methode === 'sendMessage').pop().corps.text), 'on lui dit de recliquer');
  eq(await M.X.clic(clicDe(12, 12)), 'rate', 'deuxieme panne');
  eq(await M.X.clic(clicDe(12, 12)), 'epuise', 'apres deux essais : plus de nouvel essai (la depense reste bornee)');
  M = monde({ sendPhotoCasse: true });
  eq(await M.X.clic(clicDe(12, 12)), 'rate', 'Telegram refuse la photo : rate, droit garde');

  console.log('-- 4. le plafond et l interrupteur');
  M = monde();
  eq(await M.X.clic(clicDe(11, 11)), 'livre', '1/2');
  eq(await M.X.clic(clicDe(12, 12)), 'livre', '2/2');
  eq(await M.X.clic(clicDe(14, 14)), 'plein', 'le troisieme du jour : plein (TG_SWOGEME_JOUR=2)');
  ok(!M.X.lis().essais[14], 'plein ne consomme rien');
  const M2 = monde({ t: Date.parse('2026-10-19T08:00:00Z') });
  fs.copyFileSync(path.join(M.dossier, 'tg_swogeme.json'), path.join(M2.dossier, 'tg_swogeme.json'));
  eq(await M2.X.clic(clicDe(14, 14)), 'livre', 'le lendemain UTC, le plafond est neuf');
  /* Deux clics en meme temps : le second attend dans la file, et le plafond compte celui en route. */
  process.env.TG_SWOGEME_JOUR = '1';
  const M3 = monde();
  const X3 = S.cree({ jeton: () => 'J', dossier: M3.dossier, prendre: async (u, i) => ({ ok: true, json: async () => ({ ok: true, result: /getUserProfilePhotos/.test(u) ? { photos: [] } : true }) }), retouche: async () => ({}), actif: () => true, maintenant: Date.now });
  const a = X3.clic(clicDe(31, 31)), b = X3.clic(clicDe(32, 32));
  const ra = await a, rb = await b;
  ok(ra === 'lance' && rb === 'plein', 'deux clics simultanes, plafond 1 : le second est refuse [' + ra + ', ' + rb + ']');
  process.env.TG_SWOGEME_JOUR = '2';
  process.env.TG_SWOGEME = '0';
  M = monde();
  eq(await M.X.message({ chat: groupe, new_chat_members: [membre(11)] }), null, 'TG_SWOGEME=0 : aucun accueil');
  eq(await M.X.clic(clicDe(11, 11)), 'eteint', 'et le bouton dit que c est eteint');
  delete process.env.TG_SWOGEME;
  M = monde({ actif: false });
  eq(await M.X.clic(clicDe(11, 11)), 'eteint', 'sans OpenAI : eteint, rien ne part');
  process.env.TG_SWOGEME_CHATS = '@MonGroupe,-1009';
  M = monde();
  eq((await M.X.message({ chat: { id: -1009, type: 'group' }, new_chat_members: [membre(41)] })).accueil, 1, 'TG_SWOGEME_CHATS : un groupe ajoute par identifiant');
  eq((await M.X.message({ chat: { id: -3, type: 'supergroup', username: 'mongroupe' }, new_chat_members: [membre(42)] })).accueil, 1, 'et par nom (@, casse ignores)');

  console.log(rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK');
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
