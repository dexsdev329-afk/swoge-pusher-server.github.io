'use strict';
/*
 * Fire-and-forget Telegram notifications (deposits / big wins / stakes).
 * Uses Node 18's global fetch. Sends are serialized with a small gap so we
 * never trip Telegram's rate limit, and every failure is swallowed — a bad
 * token or network blip must never crash or slow the game.
 */
const cfg = require('./config');

let chain = Promise.resolve();
const enabled = () => !!(cfg.TG_BOT_TOKEN && cfg.TG_CHAT_ID);

function notify(text) {
  if (!enabled()) { console.warn('[tg] skipped (TG_BOT_TOKEN/TG_CHAT_ID not set):', text.slice(0, 40)); return; }
  chain = chain.then(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) console.warn(`[tg] Telegram refused: ${j.error_code} ${j.description}`);
    } catch (e) { console.warn('[tg] send failed:', e.message); }
    await new Promise((r) => setTimeout(r, 400)); // stay under the rate limit
  }).catch(() => {});
}

function notifyPhoto(photo, caption) {
  if (!photo) return notify(caption);         // no image → plain text
  if (!enabled()) { console.warn('[tg] skipped photo (TG token/chat not set)'); return; }
  chain = chain.then(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.TG_CHAT_ID, photo, caption, parse_mode: 'HTML' }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) { console.warn(`[tg] photo refused: ${j.error_code} ${j.description} — falling back to text`); notify(caption); }
    } catch (e) { console.warn('[tg] photo failed:', e.message); }
    await new Promise((r) => setTimeout(r, 400));
  }).catch(() => {});
}

/**
 * Envoie un FICHIER. C'est ce qui permet a une sauvegarde de quitter la
 * machine sans aucune infrastructure : le canal prive du proprietaire devient
 * l'endroit ou vivent les copies, horodatees et telechargeables depuis un
 * telephone.
 *
 * ---- pourquoi une adresse de canal separee ----
 *
 * L'etat porte les adresses et les soldes de tous les joueurs. Il n'a rien a
 * faire dans le canal public des annonces de gains. Sans TG_BACKUP_CHAT_ID,
 * on n'envoie RIEN plutot que de risquer une fuite : une sauvegarde publiee
 * par erreur ne se rattrape pas.
 *
 * @returns {Promise<boolean>} vrai si Telegram l'a accepte
 */
const _publics = new Map();
/**
 * Ce canal est-il joignable par n'importe qui ?
 *
 * On ne se fie pas a « il est prive », on le DEMANDE a Telegram. Un canal qui
 * porte un nom d'utilisateur est atteignable par t.me/<nom> : n'importe qui
 * peut y entrer et lire ce qui s'y trouve. Une sauvegarde publiee la
 * exposerait l'adresse et le solde de chaque joueur, et ne se rattraperait
 * pas.
 */
async function chatEstPublic(chatId) {
  if (_publics.has(chatId)) return _publics.get(chatId);
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const j = await r.json();
    /* Si Telegram ne repond pas clairement, on considere que c'est public :
       en cas de doute sur une fuite, on s'abstient. */
    const pub = !j.ok || !!(j.result && j.result.username);
    _publics.set(chatId, pub);
    if (pub) console.warn(`[tg] canal ${chatId} joignable publiquement (@${j.result && j.result.username || '?'}) — aucune sauvegarde n y sera envoyee`);
    return pub;
  } catch (e) { return true; }
}

async function sendDocument(buffer, nom, legende, chatId) {
  /* A defaut de canal dedie, celui des notifications — a condition qu'il ne
     soit pas public. */
  const cible = chatId || cfg.TG_BACKUP_CHAT_ID || cfg.TG_CHAT_ID;
  if (!cfg.TG_BOT_TOKEN || !cible) {
    console.warn('[tg] document non envoye : TG_BOT_TOKEN ou canal manquant');
    return false;
  }
  if (await chatEstPublic(cible)) {
    console.warn('[tg] document NON ENVOYE : ce canal est public. Posez TG_BACKUP_CHAT_ID sur un canal prive.');
    return false;
  }
  try {
    const form = new FormData();
    form.append('chat_id', String(cible));
    if (legende) { form.append('caption', legende); form.append('parse_mode', 'HTML'); }
    form.append('document', new Blob([buffer], { type: 'application/gzip' }), nom);
    const res = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendDocument`,
                            { method: 'POST', body: form });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) { console.warn(`[tg] document refuse : ${j.error_code} ${j.description}`); return false; }
    return true;
  } catch (e) { console.warn('[tg] document echoue :', e.message); return false; }
}

module.exports = { notify, notifyPhoto, sendDocument, chatEstPublic, enabled };
