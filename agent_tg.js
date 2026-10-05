'use strict';
/* ==================================================================
 * LE BOT TELEGRAM D'UN JETON — poster/épingler dans SON groupe
 * ==================================================================
 *
 * Demande du propriétaire (05/10/2026) : « on devrait pouvoir connecter un bot
 * Telegram qui poste/parle dans notre groupe, ou épingle nos posts X ». En miroir
 * du compte X par jeton (agent_x) : le créateur relie, à SON jeton, un bot
 * Telegram (jeton BotFather) et l'id de son groupe. Le jeton du bot est un SECRET :
 * on le chiffre au repos (AES-256-GCM) sous une clé qui ne vit que dans l'hôte
 * (AGENT_TG_CLE, ou à défaut AGENT_X_CLE). Sans clé : on REFUSE de stocker
 * (fail-closed). L'id du groupe n'est pas un secret (on peut le montrer).
 *
 * L'agent poste dans le groupe (sendMessage) et peut épingler un message
 * (pinChatMessage) — par exemple son post X, pour le mettre en avant. Le bot doit
 * être administrateur du groupe pour épingler ; sinon Telegram refuse et on le dit.
 * fetch injectable : aucun essai ne sort de la machine.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.telegram.org';
const bas = (a) => String(a).toLowerCase();
const estAdresse = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
/* Un jeton BotFather : <digits>:<35+ base64url>. On valide la FORME, pas plus. */
const estBotToken = (t) => typeof t === 'string' && /^[0-9]{6,}:[A-Za-z0-9_-]{30,}$/.test(t);
/* Un id de chat : -100xx… (supergroupe/canal), -xx… (groupe), xx… (privé), ou @username. */
const estChatId = (c) => typeof c === 'string' && (/^-?[0-9]{1,20}$/.test(c) || /^@[A-Za-z0-9_]{4,}$/.test(c));

function cree(opts) {
  opts = opts || {};
  const fichier = opts.fichier || path.join(require('./config').DATA_DIR, 'agent_tg.json');
  const motCle = () => (opts.cle !== undefined ? opts.cle : (process.env.AGENT_TG_CLE || process.env.AGENT_X_CLE)) || '';
  let E = null;

  function cleBrute() { const m = motCle(); return m ? crypto.scryptSync(String(m), 'agent_tg.v1', 32) : null; }
  function chiffre(texte) {
    const k = cleBrute(); if (!k) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([c.update(String(texte), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }
  function dechiffre(o) {
    const k = cleBrute(); if (!k || !o) return null;
    try { const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(o.iv, 'base64')); d.setAuthTag(Buffer.from(o.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8'); } catch (e) { return null; }
  }

  function charge() {
    if (E) return E;
    let brut; try { brut = fs.readFileSync(fichier, 'utf8'); } catch (e) { if (e.code === 'ENOENT') { E = { c: {} }; return E; } throw e; }
    const j = JSON.parse(brut); if (!j || typeof j.c !== 'object') throw new Error('agent_tg illisible'); E = { c: j.c }; return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp'; const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }

  /** Relie un bot Telegram + un groupe a un jeton. { botToken, chatId, titre? }.
   *  Le jeton du bot est chiffre ; l id du groupe est garde en clair (pas un secret). */
  function connecte(token, o) {
    o = o || {};
    if (!estAdresse(token)) return { ok: false, code: 400, raison: 'token must be a 0x address' };
    if (!estBotToken(o.botToken)) return { ok: false, code: 400, raison: 'that does not look like a Telegram bot token (from BotFather)' };
    if (!estChatId(String(o.chatId || ''))) return { ok: false, code: 400, raison: 'chatId must be a group id (like -100123...) or @username' };
    if (!cleBrute()) return { ok: false, code: 503, raison: 'AGENT_TG_CLE (or AGENT_X_CLE) is not set on the host — refusing to store the bot token in the clear' };
    const S = charge();
    S.c[bas(token)] = { bot: chiffre(o.botToken), chatId: String(o.chatId), titre: o.titre ? String(o.titre).slice(0, 80) : null, cree: Date.now() };
    sauve();
    return { ok: true, chatId: S.c[bas(token)].chatId, titre: S.c[bas(token)].titre };
  }
  function oublie(token) { const S = charge(); if (!S.c[bas(token)]) return { ok: false, code: 404, raison: 'no Telegram linked' }; delete S.c[bas(token)]; sauve(); return { ok: true }; }
  const aDesCreds = (token) => !!charge().c[bas(token)];
  /** Vue PUBLIQUE : le groupe, jamais le jeton du bot. */
  const chatDe = (token) => { const c = charge().c[bas(token)]; return c ? { chatId: c.chatId, titre: c.titre || null } : null; };
  function majTitre(token, titre) { const S = charge(), c = S.c[bas(token)]; if (c) { c.titre = String(titre || '').slice(0, 80) || null; sauve(); } }

  function clesDe(token) { const c = charge().c[bas(token)]; if (!c) return null; const bot = dechiffre(c.bot); if (!bot) return null; return { bot, chatId: c.chatId }; }

  async function appel(token, methode, corps, f) {
    const cles = clesDe(token); if (!cles) throw new Error('no usable Telegram bot');
    const r = await (f || fetch)(API + '/bot' + cles.bot + '/' + methode, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error('Telegram ' + methode + ': ' + (j.description || ('HTTP ' + r.status)).slice(0, 140));
    return j.result;
  }

  /** Les infos du groupe (titre/username/type), via getChat. Confirme que le bot y a accès. */
  async function chatInfo(token, f) {
    const cles = clesDe(token); if (!cles) return null;
    try { const res = await appel(token, 'getChat', { chat_id: cles.chatId }, f);
      return { titre: res.title || null, username: res.username || null, type: res.type || null }; }
    catch (e) { return { erreur: String((e && e.message) || e).slice(0, 140) }; }
  }
  /** Poste un message dans le groupe. { texte, lien? }. Rend { ok, messageId } ou { ok:false, raison }. */
  async function poste(token, o, f) {
    o = o || {}; const cles = clesDe(token);
    if (!cles) return { ok: false, raison: 'no Telegram bot linked for this token' };
    const texte = String(o.texte || '').trim() + (o.lien ? '\n' + String(o.lien) : '');
    if (!texte.trim()) return { ok: false, raison: 'empty message' };
    try { const res = await appel(token, 'sendMessage', { chat_id: cles.chatId, text: texte, disable_web_page_preview: !o.lien }, f);
      return { ok: true, messageId: res.message_id }; }
    catch (e) { return { ok: false, raison: String((e && e.message) || e).slice(0, 140) }; }
  }
  /** Épingle un message du groupe (le bot doit être admin). */
  async function pinne(token, messageId, f) {
    if (!clesDe(token)) return { ok: false, raison: 'no Telegram bot linked for this token' };
    if (!(Number(messageId) > 0)) return { ok: false, raison: 'bad message id' };
    try { await appel(token, 'pinChatMessage', { chat_id: clesDe(token).chatId, message_id: Number(messageId), disable_notification: true }, f);
      return { ok: true }; }
    catch (e) { return { ok: false, raison: String((e && e.message) || e).slice(0, 140) }; }
  }

  return { connecte, oublie, aDesCreds, chatDe, majTitre, chatInfo, poste, pinne };
}

module.exports = { cree, API, estBotToken, estChatId };
