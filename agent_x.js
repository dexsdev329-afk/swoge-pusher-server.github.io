'use strict';
/* ==================================================================
 * LE COMPTE X D'UN JETON — creds chiffrees par jeton, publication
 * ==================================================================
 *
 * Phase 1, etape 7b. L'agent d'un jeton poste sur le compte X DE CE JETON,
 * jamais sur le compte maison. Le createur relie le compte de son jeton ; on
 * stocke ses jetons d'acces OAuth 1.0a, CHIFFRES au repos (AES-256-GCM), sous
 * une cle qui ne vit que dans l'environnement de l'hote (AGENT_X_CLE) — jamais
 * dans le depot, jamais dans une reponse. Sans cette cle : on REFUSE de stocker
 * (fail-closed), pour ne jamais ecrire un secret en clair.
 *
 * La publication reutilise la plomberie de x_post : signeOAuth + enc, avec les
 * cles d'APP maison (X_CONSUMER_KEY/SECRET) et les jetons d'ACCES du jeton.
 * L'app identifie notre service ; les jetons d'acces identifient le compte qui
 * poste. fetch injectable : aucun essai ne sort de la machine.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xp = require('./x_post');

const API = 'https://api.x.com';
const bas = (a) => String(a).toLowerCase();
const estAdresse = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

function cree(opts) {
  opts = opts || {};
  const fichier = opts.fichier || path.join(require('./config').DATA_DIR, 'agent_x.json');
  /* La cle de chiffrement : l'hote la pose dans AGENT_X_CLE. Pas de cle → pas de stockage. */
  const motCle = () => (opts.cle !== undefined ? opts.cle : process.env.AGENT_X_CLE) || '';
  /* Les cles d'APP maison (qui identifient notre service X). */
  const appCles = () => opts.consumer || { ck: process.env.X_CONSUMER_KEY || '', cs: process.env.X_CONSUMER_SECRET || '' };
  let E = null;

  function cleBrute() {
    const m = motCle();
    return m ? crypto.scryptSync(String(m), 'agent_x.v1', 32) : null;
  }
  function chiffre(texte) {
    const k = cleBrute(); if (!k) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([c.update(String(texte), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }
  function dechiffre(o) {
    const k = cleBrute(); if (!k || !o) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(o.iv, 'base64'));
      d.setAuthTag(Buffer.from(o.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8');
    } catch (e) { return null; }   /* mauvaise cle, donnee alteree : on ne rend rien */
  }

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { comptes: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.comptes !== 'object') throw new Error('agent_x illisible');
    E = { comptes: j.comptes };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }

  /** Relie le compte X d'un jeton. Stocke les jetons d'acces CHIFFRES.
   *  { accessToken, accessSecret, handle }. Fail-closed sans cle de chiffrement. */
  function connecte(token, o) {
    o = o || {};
    if (!estAdresse(token)) return { ok: false, code: 400, raison: 'token must be a 0x address' };
    if (!o.accessToken || !o.accessSecret) return { ok: false, code: 400, raison: 'accessToken and accessSecret are required' };
    if (!cleBrute()) return { ok: false, code: 503, raison: 'AGENT_X_CLE is not set on the host — refusing to store X secrets in the clear' };
    const S = charge();
    S.comptes[bas(token)] = {
      at: chiffre(o.accessToken), as: chiffre(o.accessSecret),
      handle: String(o.handle || '').replace(/^@/, '').replace(/[^\w]/g, '').slice(0, 15) || null,
      cree: Date.now(),
    };
    sauve();
    return { ok: true, handle: S.comptes[bas(token)].handle };
  }

  function oublie(token) {
    const S = charge();
    if (!S.comptes[bas(token)]) return { ok: false, code: 404, raison: 'no X account linked' };
    delete S.comptes[bas(token)]; sauve();
    return { ok: true };
  }

  const aDesCreds = (token) => !!charge().comptes[bas(token)];
  /** Le handle (public) d'un jeton, ou null. JAMAIS les secrets. */
  const handleDe = (token) => { const c = charge().comptes[bas(token)]; return c ? (c.handle || null) : null; };

  /* Les cles completes {ck,cs,at,as} d'un jeton, dechiffrees. null si pas relie,
     pas de cle, ou donnee alteree. Interne : ne sort jamais de ce module. */
  function clesDe(token) {
    const c = charge().comptes[bas(token)]; if (!c) return null;
    const app = appCles();
    const at = dechiffre(c.at), as = dechiffre(c.as);
    if (!at || !as) return null;
    return { ck: app.ck, cs: app.cs, at, as };
  }

  /** Poste un tweet sur le compte X du jeton. { texte, mediaId? }.
   *  Rend { surX:true, id, url } ou { surX:false, raison }. fetch injectable. */
  async function poste(token, post, deps) {
    deps = deps || {};
    const f = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    const cles = clesDe(token);
    if (!cles) return { surX: false, raison: 'no usable X account for this token' };
    if (!cles.ck || !cles.cs) return { surX: false, raison: 'house X app keys (X_CONSUMER_KEY/SECRET) not configured' };
    if (!f) return { surX: false, raison: 'no fetch available' };
    const url = API + '/2/tweets';
    const s = xp.signeOAuth('POST', url, {}, cles);      /* corps JSON : rien dans la signature, comme x_post.appelX */
    const corps = { text: String((post && post.texte) || '') };
    if (post && post.mediaId) corps.media = { media_ids: [String(post.mediaId)] };
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: s.entete },
      body: JSON.stringify(corps), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = (j.detail || j.title || (j.errors && j.errors[0] && j.errors[0].message) || '').slice(0, 160);
      return { surX: false, raison: 'X HTTP ' + r.status + (detail ? ' — ' + detail : '') };
    }
    const id = j.data && j.data.id;
    if (!id) return { surX: false, raison: 'X tweets: response without id' };
    const h = handleDe(token) || 'i';
    return { surX: true, id: String(id), url: 'https://x.com/' + h + '/status/' + id };
  }

  /* Un appel X signe avec les cles DU JETON (pour televerser un media sur SON compte). */
  async function appel(token, chemin, corps, f) {
    const cles = clesDe(token); if (!cles) throw new Error('no usable X account');
    if (!cles.ck || !cles.cs) throw new Error('house X app keys not configured');
    const url = API + chemin;
    const s = xp.signeOAuth('POST', url, {}, cles);
    const r = await (f || fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: s.entete }, body: JSON.stringify(corps), signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('X ' + chemin + ' HTTP ' + r.status);
    return j;
  }
  /** Televerse une image sur le compte X du jeton. Rend l id media (string). */
  async function televerse(token, png, deps) {
    const j = await appel(token, '/2/media/upload', { media: png.toString('base64'), media_category: 'tweet_image' }, deps && deps.fetch);
    const id = (j.data && (j.data.id || j.data.media_key)) || j.id || j.media_id_string;
    if (!id) throw new Error('X media: no id');
    return String(id);
  }
  /** Televerse une video (en morceaux) sur le compte X du jeton. Rend l id media. */
  async function televerseVideo(token, mp4, deps) {
    const f = deps && deps.fetch, dors = (deps && deps.pause) || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const MORCEAU = 4 * 1024 * 1024;
    const i = await appel(token, '/2/media/upload/initialize', { media_type: 'video/mp4', total_bytes: mp4.length, media_category: 'tweet_video' }, f);
    const id = String((i.data && (i.data.id || i.data.media_key)) || i.id || i.media_id_string || '');
    if (!id) throw new Error('X media: initialize without id');
    for (let k = 0, m = 0; k < mp4.length; k += MORCEAU, m++) await appel(token, '/2/media/upload/' + id + '/append', { media: mp4.slice(k, k + MORCEAU).toString('base64'), segment_index: m }, f);
    const fin = await appel(token, '/2/media/upload/' + id + '/finalize', {}, f);
    let info = (fin.data || fin).processing_info;
    for (let tour = 0; info && (info.state === 'pending' || info.state === 'in_progress'); tour++) {
      if (tour >= 60) throw new Error('X media: video not ready');
      await dors(Math.min(30, Math.max(1, Number(info.check_after_secs) || 5)) * 1000);
      const cles = clesDe(token); const url = API + '/2/media/upload';
      const s = xp.signeOAuth('GET', url, { command: 'STATUS', media_id: id }, cles);
      const q = await (f || fetch)(url + '?command=STATUS&media_id=' + id, { headers: { authorization: s.entete }, signal: AbortSignal.timeout(30000) });
      info = ((await q.json().catch(() => ({}))).data || {}).processing_info;
    }
    if (info && info.state === 'failed') throw new Error('X media: video processing failed');
    return id;
  }

  return { connecte, oublie, aDesCreds, handleDe, poste, televerse, televerseVideo };
}

module.exports = { cree, API };
