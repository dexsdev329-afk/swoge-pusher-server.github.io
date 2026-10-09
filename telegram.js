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

/* ------------------------------------------------------- LE CARNET D'ENVOI
 *
 * « Je ne vois toujours rien dans le canal » a occupe trois allers-retours,
 * et chacun a corrige une cause plausible sans jamais VOIR ce qui se passait
 * au bout du fil : d'abord le seuil de rarete, puis le format d'image refuse
 * par sendPhoto. Deux corrections justes, un symptome inchange — parce que
 * les deux fois j'ai raisonne sur le code au lieu de regarder la reponse de
 * Telegram.
 *
 * Toutes les pannes possibles laissent pourtant une trace differente : jeton
 * absent, canal introuvable, image refusee, cadence depassee, reseau coupe.
 * Cette trace existait deja — elle partait dans console.warn, c'est-a-dire
 * dans les journaux d'un hebergeur que personne ne lit a trois heures du
 * matin depuis un telephone.
 *
 * On garde donc les trente derniers envois EN MEMOIRE, et une route
 * d'administration les rend. Un seul appel et la question est tranchee, au
 * lieu d'une nouvelle hypothese. La memoire suffit : ce carnet sert a
 * diagnostiquer maintenant, pas a archiver.
 *
 * Il contient des noms de joueurs et des montants — d'ou la route protegee,
 * jamais /health.
 */
const CARNET_MAX = 30;
const carnet = [];
let envoyes = 0, refuses = 0;
function note(route, ok, code, desc, apercu) {
  if (ok) envoyes++; else refuses++;
  carnet.push({ a: new Date().toISOString(), route, ok, code: code || null,
                desc: desc || null, apercu: String(apercu || '').replace(/<[^>]*>/g, '').slice(0, 90) });
  if (carnet.length > CARNET_MAX) carnet.shift();
}
/** Les derniers envois, du plus recent au plus ancien, + les compteurs. */
function journal() {
  return { actif: enabled(), envoyes, refuses, derniers: [...carnet].reverse() };
}

function notify(text) {
  if (!enabled()) {
    console.warn('[tg] skipped (TG_BOT_TOKEN/TG_CHAT_ID not set):', text.slice(0, 40));
    return note('sendMessage', false, 'config', 'TG_BOT_TOKEN ou TG_CHAT_ID absent', text);
  }
  chain = chain.then(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) console.warn(`[tg] Telegram refused: ${j.error_code} ${j.description}`);
      note('sendMessage', !!j.ok, j.error_code, j.description, text);
    } catch (e) { console.warn('[tg] send failed:', e.message); note('sendMessage', false, 'reseau', e.message, text); }
    await new Promise((r) => setTimeout(r, 400)); // stay under the rate limit
  }).catch(() => {});
}

function notifyPhoto(photo, caption) {
  if (!photo) return notify(caption);         // no image → plain text
  if (!enabled()) {
    console.warn('[tg] skipped photo (TG token/chat not set)');
    return note('sendPhoto', false, 'config', 'TG_BOT_TOKEN ou TG_CHAT_ID absent', caption);
  }
  chain = chain.then(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.TG_CHAT_ID, photo, caption, parse_mode: 'HTML' }),
      });
      const j = await res.json().catch(() => ({}));
      note('sendPhoto', !!j.ok, j.error_code, j.description, photo);
      if (!j.ok) { console.warn(`[tg] photo refused: ${j.error_code} ${j.description} — falling back to text`); notify(caption); }
    } catch (e) {
      /* Le reseau a lache : on retombe sur le texte, comme pour un refus.
         Sans ca, une image injoignable emportait le signal avec elle — et
         c'est justement quand le reseau va mal qu'on veut lire l'annonce. */
      console.warn('[tg] photo failed:', e.message, '— falling back to text');
      note('sendPhoto', false, 'reseau', e.message, photo);
      notify(caption);
    }
    await new Promise((r) => setTimeout(r, 400));
  }).catch(() => {});
}

/** Une video par son adresse (sendVideo) ; refusee ou injoignable, le texte part avec le lien. */
function notifyVideo(video, caption) {
  if (!video) return notify(caption);
  if (!enabled()) return note('sendVideo', false, 'config', 'TG_BOT_TOKEN ou TG_CHAT_ID absent', caption);
  chain = chain.then(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendVideo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.TG_CHAT_ID, video, caption, parse_mode: 'HTML', supports_streaming: true }),
      });
      const j = await res.json().catch(() => ({}));
      note('sendVideo', !!j.ok, j.error_code, j.description, video);
      if (!j.ok) notify(caption + '\n' + video);
    } catch (e) { note('sendVideo', false, 'reseau', e.message, video); notify(caption + '\n' + video); }
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
/* ---- CE QUE TELEGRAM DIT D'UN CHAT, GARDE SEULEMENT S'IL EST DEFINITIF ----
 * Relecture du 09/10 : un getChat en 429 ou 5xx etait garde comme « public »
 * pour toute la vie du processus — plus une sauvegarde ni une alerte jusqu'au
 * redeploiement. On ne garde que les reponses definitives : ok, ou 400/403
 * (chat introuvable, bot exclu). */
const _chats = new Map();
async function infoChat(chatId) {
  if (_chats.has(chatId)) return _chats.get(chatId);
  const r = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(chatId)}`);
  const j = await r.json();
  if (j && (j.ok || j.error_code === 400 || j.error_code === 403)) _chats.set(chatId, j);
  return j || { ok: false };
}
async function chatEstPublic(chatId) {
  if (_publics.has(chatId)) return _publics.get(chatId);
  try {
    const j = await infoChat(chatId);
    /* Si Telegram ne repond pas clairement, on considere que c'est public :
       en cas de doute sur une fuite, on s'abstient.
       ---- UNE CONVERSATION PRIVEE AVEC LE BOT N'EST PAS PUBLIQUE (09/10) ----
       getChat rend aussi le @nom d'une PERSONNE (« for private chats,
       supergroups and channels if available », Bot API) : un proprietaire qui
       a un @nom voyait son chat prive juge public. Seul un groupe ou un canal
       a @nom est joignable par tous. */
    const res = j && j.result;
    const pub = !j.ok || !!(res && res.username && res.type !== 'private');
    if (j.ok || j.error_code === 400 || j.error_code === 403) _publics.set(chatId, pub);
    if (pub) console.warn(`[tg] canal ${chatId} joignable publiquement (@${res && res.username || '?'}) — aucune sauvegarde n y sera envoyee`);
    return pub;
  } catch (e) { return true; }
}
/** Est-ce une conversation PRIVEE (une seule personne) ? Pour les alertes
 *  d'exploitation : ni groupe ni canal, meme sans @nom (relecture du 09/10). */
async function chatEstPrive(chatId) {
  try { const j = await infoChat(chatId); return !!(j.ok && j.result && j.result.type === 'private'); }
  catch (e) { return false; }
}

/* ---- UN MESSAGE AU SEUL PROPRIETAIRE (09/10/2026) ----
 * Les alertes d'exploitation (credit d'API bas) n'ont rien a faire dans le
 * canal public : TG_BACKUP_CHAT_ID SEULEMENT — celui que donne `/id` en prive
 * a @SwogeBot —, sans repli sur TG_CHAT_ID, et seulement si Telegram confirme
 * une conversation PRIVEE (type « private » : ni groupe ni canal, meme sans
 * @nom). Dans le doute, rien ne part, et le carnet le dit (route « prive »).
 * Meme file que `notify` (400 ms). Rend une promesse : vrai si Telegram a pris
 * le message. */
function notifyPrive(text) {
  const cible = cfg.TG_BACKUP_CHAT_ID;
  if (!cfg.TG_BOT_TOKEN || !cible) {
    note('prive', false, 'config', 'TG_BOT_TOKEN ou TG_BACKUP_CHAT_ID absent', text);
    return Promise.resolve(false);
  }
  if (cfg.TG_CHAT_ID && String(cible) === String(cfg.TG_CHAT_ID)) {
    note('prive', false, 'public', 'TG_BACKUP_CHAT_ID est le canal public TG_CHAT_ID', text);
    return Promise.resolve(false);
  }
  let rendu;
  const fini = new Promise((r) => { rendu = r; });
  chain = chain.then(async () => {
    let ok = false;
    try {
      if (!(await chatEstPrive(cible))) {
        note('prive', false, 'public', 'TG_BACKUP_CHAT_ID n est pas une conversation privee : rien envoye', text);
      } else {
        const res = await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: cible, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        });
        const j = await res.json().catch(() => ({}));
        ok = !!j.ok;
        if (!ok) console.warn(`[tg] message prive refuse : ${j.error_code} ${j.description}`);
        note('prive', ok, j.error_code, j.description, text);
      }
    } catch (e) { note('prive', false, 'reseau', e.message, text); }
    rendu(ok);
    await new Promise((r) => setTimeout(r, 400));
  }).catch(() => { rendu(false); });
  return fini;
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

module.exports = { notify, notifyPrive, notifyPhoto, notifyVideo, sendDocument, chatEstPublic, chatEstPrive, enabled, journal };
