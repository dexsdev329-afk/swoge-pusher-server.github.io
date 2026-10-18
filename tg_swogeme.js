'use strict';
/* ==================================================================
 * « SWOGE ME » — LA PHOTO DE PROFIL D'UN NOUVEAU MEMBRE, EN STYLE SWOGE
 * ==================================================================
 *
 * Demande du proprietaire (18/10/2026) : « a chaque fois qu un nouvel
 * utilisateur arrive sur t.me/swoleswoge, telecharger sa photo de profil et la
 * transformer en Swoge style ». Decide avec lui le meme jour : PAS
 * automatiquement — transformer et publier la photo d'une vraie personne sans
 * son accord pose un probleme de droit a l'image, et ferait fuir les nouveaux.
 * Le bot accueille avec un bouton « 🐶 Swoge me » ; c'est la PERSONNE qui clique,
 * et UNE transformation par personne, pour toujours.
 *
 *   1. Un message de service `new_chat_members` dans un groupe autorise : un
 *      accueil, un bouton par nouveau membre (bots exclus, trois au plus).
 *   2. Le clic (`callback_query`) : seul le membre vise peut s'en servir. Sa
 *      photo de profil est lue par l'API Bot (getUserProfilePhotos + getFile) —
 *      celle que SES reglages de confidentialite montrent ; aucune, on le lui dit
 *      et rien n'est consomme.
 *   3. La retouche passe par OpenAI (studio_openai.images, /v1/images/edits),
 *      une a la fois pour tout le serveur, puis la photo part dans le groupe en
 *      reponse a l'accueil. Le droit n'est pris qu'a la LIVRAISON : une panne ne
 *      le mange pas (deux essais au plus par personne).
 *
 * DANS LE GROUPE, RIEN QUE LES IMAGES (proprietaire, 18/10 : « met pas toutes les notifs, juste
 * pour les images OpenAI ») : l'accueil (il porte le bouton) et les portraits. Tout le reste —
 * pas de photo, portrait rate, plafond, deja fait — est une fenetre du clic (answerCallbackQuery),
 * que seul celui qui a clique voit. La photo est donc lue AVANT de repondre au clic.
 *
 * Ce qui borne la depense : TG_SWOGEME_JOUR portraits par jour UTC pour toute
 * la maison (20). Le cout reel de chaque portrait (usage OpenAI, grille de
 * studio_media) est ecrit au journal : c'est lui qui dira si 20 est trop.
 * On ne garde AUCUNE photo : ni l'originale ni le portrait ne sont ecrits sur
 * le disque ; seuls l'identifiant Telegram, l'heure et le cout le sont.
 * Le texte montre aux membres est en anglais.
 * ================================================================== */
const fs = require('fs');
const path = require('path');

const MAX_PAR_ACCUEIL = 3;
const ESSAIS_MAX = 2;
const PHOTO_MAX_OCTETS = 5 * 1024 * 1024;
const ACCUEILLIS_MAX = 5000;
const JOUR = () => Math.max(0, Number(process.env.TG_SWOGEME_JOUR || 20));
/* Le seul groupe ou le bot accueille : @swoleswoge (« juste swoleswoge », proprietaire, 18/10). */
const GROUPES = () => ['swoleswoge'];

/* Le portrait : le personnage SWOGE (le meme que les posts X, x_post.js PERSONNAGE), en gardant de
   la photo ce qui fait qu'on s'y reconnait sans montrer de visage humain. */
const PROMPT = 'Turn the subject of this profile picture into a SWOGE character: the famous \'buff Doge\' meme '
  + 'character, a Shiba Inu head with a calm, confident expression on an extremely muscular bodybuilder torso, cream '
  + 'and tan fur, and furry dog paws with paw pads, never human hands or fingers. Keep what makes the picture '
  + 'recognisable: the pose, the framing, the clothes and their colours, accessories (glasses, hat, chain) and the '
  + 'background mood. Keep the subject\'s hair colour as fur accents. If the picture shows no person (a logo, an '
  + 'object, an animal, a landscape), put the SWOGE character into that same scene. Bold, clean, high-quality '
  + 'cartoon render. No text, no letters, no watermark. No human face anywhere.';

const TEXTES = {
  accueil: (noms) => 'Welcome to the pack, ' + noms + '! 🐶💪\nTap below to turn your profile photo into a SWOGE portrait — it gets posted here. One per person.',
  bouton: (nom) => '🐶 Swoge me' + (nom ? ' — ' + nom : ''),
  pasPourToi: 'This button is for the new member 🙂',
  dejaFait: 'You already got your SWOGE portrait 🐶',
  enCours: 'Working on it — your portrait appears here in about a minute ⏳ (nothing after 5 minutes? tap again)',
  file: 'In the queue — your portrait is coming ⏳ (nothing after 5 minutes? tap again)',
  sansPhoto: 'I can\'t see a profile photo. Set one visible to Everyone (Settings → Privacy → Profile photos), then tap again.',
  epuiseLecture: 'I couldn\'t read your profile photo right now — tap again in a minute.',
  plein: 'Today\'s SWOGE portraits are all done — tap again tomorrow!',
  eteint: 'SWOGE portraits are off right now.',
  epuise: 'The portrait didn\'t come out twice — sorry, it won\'t retry.',
  legende: (nom) => '🐶 ' + nom + ' just got SWOGED! Welcome to the pack 💪',
};

const nomDe = (u) => String((u && (u.first_name || u.username)) || 'friend').replace(/\s+/g, ' ').slice(0, 40);
const jourUtc = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * deps = { jeton() -> TG_BOT_TOKEN, dossier, prendre (fetch), retouche({ image, prompt }) -> { url (data-URL), coutUsd },
 *          actif() -> bool (OpenAI pret), maintenant() }
 */
function cree(deps) {
  const d = deps || {};
  const prendre = d.prendre || fetch;
  const maintenant = d.maintenant || Date.now;
  const FICHIER = path.join(d.dossier || '.', 'tg_swogeme.json');
  const MESURE = { accueils: 0, clics: 0, portraits: 0, sansPhoto: 0, pleins: 0, echecs: 0, coutUsd: 0 };
  let file = Promise.resolve();
  const enVol = new Set();

  function lis() {
    let e = {};
    try { e = JSON.parse(fs.readFileSync(FICHIER, 'utf8')) || {}; } catch (x) { e = {}; }
    e.faits = e.faits || {}; e.essais = e.essais || {}; e.accueillis = e.accueillis || []; e.jour = e.jour || { date: '', n: 0 };
    return e;
  }
  function ecris(e) {
    if (e.accueillis.length > ACCUEILLIS_MAX) e.accueillis = e.accueillis.slice(-ACCUEILLIS_MAX);
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(FICHIER + '.tmp', JSON.stringify(e)); fs.renameSync(FICHIER + '.tmp', FICHIER);
  }
  const api = async (methode, corps) => {
    const r = await prendre('https://api.telegram.org/bot' + d.jeton() + '/' + methode, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(methode + ' : ' + String(j.description || r.status).slice(0, 120));
    return j.result;
  };
  const allume = () => process.env.TG_SWOGEME !== '0' && !!(d.jeton && d.jeton());
  const groupeOk = (chat) => !!chat && (chat.type === 'group' || chat.type === 'supergroup')
    && GROUPES().some((g) => g === String(chat.username || '').toLowerCase() || g === String(chat.id));

  /** Un message : un accueil s'il annonce des nouveaux membres (humains) d'un groupe autorise. */
  async function message(m) {
    if (!allume() || !m || !Array.isArray(m.new_chat_members) || !groupeOk(m.chat)) return null;
    const e = lis();
    const nouveaux = m.new_chat_members.filter((u) => u && !u.is_bot && !e.accueillis.includes(u.id)).slice(0, MAX_PAR_ACCUEIL);
    if (!nouveaux.length) return null;
    nouveaux.forEach((u) => e.accueillis.push(u.id));
    ecris(e);
    const plusieurs = nouveaux.length > 1;
    await api('sendMessage', { chat_id: m.chat.id, text: TEXTES.accueil(nouveaux.map(nomDe).join(', ')),
      reply_markup: { inline_keyboard: nouveaux.filter((u) => !e.faits[u.id]).map((u) => [{ text: TEXTES.bouton(plusieurs ? nomDe(u) : ''), callback_data: 'swogeme:' + u.id }]) } });
    MESURE.accueils++;
    return { accueil: nouveaux.length };
  }

  /** La photo de profil la plus grande, en data-URL, ou null s'il n'y en a pas de visible. */
  async function photoDe(userId) {
    const ph = await api('getUserProfilePhotos', { user_id: userId, limit: 1 });
    const tailles = ph && ph.photos && ph.photos[0];
    if (!tailles || !tailles.length) return null;
    const grande = tailles.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    const f = await api('getFile', { file_id: grande.file_id });
    if (!f || !f.file_path || (f.file_size && f.file_size > PHOTO_MAX_OCTETS)) return null;
    const r = await prendre('https://api.telegram.org/file/bot' + d.jeton() + '/' + f.file_path, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('telechargement ' + r.status);
    const b = Buffer.from(await r.arrayBuffer());
    if (!b.length || b.length > PHOTO_MAX_OCTETS) return null;
    const type = b[0] === 0x89 ? 'image/png' : 'image/jpeg';
    return 'data:' + type + ';base64,' + b.toString('base64');
  }

  async function envoiePhoto(chatId, dataUrl, legende, repondA) {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('portrait illisible');
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('caption', legende);
    if (repondA) fd.append('reply_parameters', JSON.stringify({ message_id: repondA, allow_sending_without_reply: true }));
    fd.append('photo', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'swoge.' + (m[1].split('/')[1] || 'png'));
    const r = await prendre('https://api.telegram.org/bot' + d.jeton() + '/sendPhoto', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error('sendPhoto : ' + String(j.description || r.status).slice(0, 120));
  }

  /* Le portrait lui-meme, dans la file (un a la fois pour tout le serveur). */
  async function fabrique(q, uid, photo) {
    const t = maintenant();
    try {
      const r = await d.retouche({ image: photo, prompt: PROMPT });
      if (!r || !r.url) throw new Error('aucune image rendue');
      await envoiePhoto(q.message.chat.id, r.url, TEXTES.legende(nomDe(q.from)), q.message.message_id);
      const e = lis();
      e.faits[uid] = { t, chat: q.message.chat.id, coutUsd: r.coutUsd == null ? null : Number(r.coutUsd) };
      if (e.jour.date !== jourUtc(t)) e.jour = { date: jourUtc(t), n: 0 };
      e.jour.n++;
      ecris(e);
      MESURE.portraits++; if (r.coutUsd != null) MESURE.coutUsd += Number(r.coutUsd);
      return 'livre';
    } catch (x) {
      MESURE.echecs++;
      console.error('[swogeme] portrait rate (' + uid + ') : ' + String(x && x.message || x).slice(0, 160));
      /* Rien dans le groupe : le bouton reste, la fenetre du clic avait dit de recliquer. */
      const e = lis(); e.essais[uid] = (e.essais[uid] || 0) + 1; ecris(e);
      return 'rate';
    } finally {
      enVol.delete(uid);
    }
  }

  /** Un clic sur « Swoge me ». Rend ce qui a ete decide (pour les essais) ; la reponse part toujours. */
  async function clic(q) {
    if (!q || typeof q.data !== 'string' || !/^swogeme:\d+$/.test(q.data)) return null;
    MESURE.clics++;
    const repond = (texte, alerte) => api('answerCallbackQuery', { callback_query_id: q.id, text: texte, show_alert: !!alerte }).catch(() => {});
    const uid = Number(q.data.slice(8));
    if (!allume() || !d.actif || !d.actif()) { await repond(TEXTES.eteint, true); return 'eteint'; }
    if (!q.from || q.from.id !== uid) { await repond(TEXTES.pasPourToi); return 'pas pour toi'; }
    if (!q.message || !groupeOk(q.message.chat)) { await repond(TEXTES.eteint, true); return 'hors groupe'; }
    const e = lis();
    if (e.faits[uid]) { await repond(TEXTES.dejaFait); return 'deja fait'; }
    if ((e.essais[uid] || 0) >= ESSAIS_MAX) { await repond(TEXTES.epuise, true); return 'epuise'; }
    if (enVol.has(uid)) { await repond(TEXTES.enCours); return 'en cours'; }
    const t = maintenant();
    const faitsJour = e.jour.date === jourUtc(t) ? e.jour.n : 0;
    /* Les portraits deja en route comptent : sinon vingt clics simultanes passeraient tous. */
    if (faitsJour + enVol.size >= JOUR()) { MESURE.pleins++; await repond(TEXTES.plein, true); return 'plein'; }
    const attente = enVol.size > 0;
    enVol.add(uid);
    let photo;
    try { photo = await photoDe(uid); }
    catch (x) { enVol.delete(uid); console.error('[swogeme] photo illisible (' + uid + ') : ' + String(x && x.message || x).slice(0, 120)); await repond(TEXTES.epuiseLecture, true); return 'photo illisible'; }
    if (!photo) { enVol.delete(uid); MESURE.sansPhoto++; await repond(TEXTES.sansPhoto, true); return 'sans photo'; }
    await repond(attente ? TEXTES.file : TEXTES.enCours);
    const travail = file.then(() => fabrique(q, uid, photo));
    file = travail.catch(() => {});
    return d.attendre ? travail : 'lance';
  }

  return { message, clic, MESURE, lis, PROMPT, TEXTES };
}

module.exports = { cree, PROMPT, TEXTES, GROUPES, ESSAIS_MAX, MAX_PAR_ACCUEIL };
