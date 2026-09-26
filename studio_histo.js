'use strict';
/* ==================================================================
 * SWOLEMIND — L'HISTORIQUE DES CHATS, ATTACHE AU PORTEFEUILLE
 * ==================================================================
 *
 * Demande du propriétaire, le 26 septembre 2026 : « l'historique synchronisé
 * entre appareils, attaché au wallet, pas seulement dans le navigateur ».
 *
 * ---- OÙ ÇA VIT ----
 *
 * Un fichier par adresse, `DATA_DIR/chats/<adresse>.json`, sur le volume de
 * Railway. JAMAIS dans `state.json` : ce fichier-là porte l'argent des
 * joueurs, et un historique de chat n'a rien à y faire — ni sa taille, ni son
 * rythme d'écriture. Écriture atomique (temporaire, fsync, rename), comme
 * `store.js` : une coupure laisse l'ancien fichier intact. Un fichier présent
 * mais illisible n'est JAMAIS écrasé par un vide : on refuse et on le dit.
 *
 * ---- QUI LIT, QUI ÉCRIT ----
 *
 * L'adresse vient de la session signée (`sessionJoueur.lire`), jamais du
 * corps de la requête : un joueur ne lit et n'écrit que SON historique.
 *
 * ---- LA FUSION ----
 *
 * Chaque conversation porte `maj` (l'horloge de l'appareil qui l'a changée) :
 * la plus récente gagne, une plus ancienne est refusée et le serveur rend sa
 * copie. Le tri « qu'est-ce qui a changé depuis ma dernière visite » se fait
 * sur `recu`, l'horloge du SERVEUR : deux appareils mal réglés ne se ratent
 * pas. Une suppression laisse une pierre tombale 30 jours, pour atteindre les
 * autres appareils ; après, elle disparaît.
 *
 * Les octets d'une pièce jointe (`data`) ne sont jamais gardés : seule la
 * vignette voyage. Aucune logique d'argent ici.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const MAX_CONVS = 100;
const CONV_MAX_OCTETS = 400 * 1024;
const TOTAL_MAX_OCTETS = 4 * 1024 * 1024;
const TOMBE_MS = 30 * 864e5;
const ECRITURES_PAR_MINUTE = 120;
const AVANCE_MAX_MS = 5 * 60e3;       /* une horloge d'appareil en avance de plus : ramenee a celle du serveur */

const adresseOk = (a) => /^0x[0-9a-f]{40}$/.test(String(a || ''));
const idOk = (x) => /^[\w-]{1,40}$/.test(String(x || ''));

function cree(opts) {
  const dir = (opts && opts.dir) || path.join(require('./config').DATA_DIR, 'chats');
  const maintenant = (opts && opts.maintenant) || (() => Date.now());
  const rythme = new Map();

  const fichier = (addr) => path.join(dir, addr + '.json');

  /** L'historique d'une adresse. Absent : vide. Illisible : on JETTE — jamais un vide qui écraserait. */
  function lis(addr) {
    let brut;
    try { brut = fs.readFileSync(fichier(addr), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return { convs: {} }; throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.convs !== 'object') throw new Error('historique illisible : ' + addr);
    return j;
  }
  function ecris(addr, h) {
    fs.mkdirSync(dir, { recursive: true });
    const f = fichier(addr), tmp = f + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(h)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
  }

  function rythmeOk(addr) {
    const t = maintenant(), l = (rythme.get(addr) || []).filter((x) => t - x < 60000);
    if (l.length >= ECRITURES_PAR_MINUTE) { rythme.set(addr, l); return false; }
    l.push(t); rythme.set(addr, l); return true;
  }

  /** Une conversation reçue, nettoyée : rôles connus, pas d'octets de pièce jointe. */
  function nettoie(id, c) {
    if (!idOk(id) || !c || typeof c !== 'object' || !Array.isArray(c.messages)) return null;
    const maj = Math.min(Number(c.maj) || 0, maintenant() + AVANCE_MAX_MS);
    if (!(maj > 0)) return null;
    const messages = [];
    for (const m of c.messages.slice(-400)) {
      if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
      const x = Object.assign({}, m);
      if (Array.isArray(x.pieces)) x.pieces = x.pieces.slice(0, 5).map((p) => ({
        genre: p && p.genre === 'pdf' ? 'pdf' : 'image', nom: String((p && p.nom) || '').slice(0, 80),
        apercu: p && typeof p.apercu === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p.apercu) && p.apercu.length < 40000 ? p.apercu : undefined }));
      messages.push(x);
    }
    return { id, titre: String(c.titre || '').slice(0, 80), maj, messages };
  }

  /** Ce qui a changé depuis `depuis` (horloge du serveur), pierres tombales comprises. */
  function depuis(addr, t) {
    if (!adresseOk(addr)) return { ok: false, code: 401 };
    const h = lis(addr), d = Number(t) || 0;
    const convs = Object.values(h.convs).filter((c) => (c.recu || 0) > d)
      .sort((a, b) => b.maj - a.maj)
      .map((c) => { const o = Object.assign({}, c); delete o.recu; return o; });
    return { ok: true, convs, maintenant: maintenant() };
  }

  function range(addr, h) {
    const t = maintenant();
    for (const id in h.convs) if (h.convs[id].supprime && t - h.convs[id].recu > TOMBE_MS) delete h.convs[id];
    /* Au-delà de MAX_CONVS, les plus anciennes partent (en pierres tombales :
       les autres appareils l'apprennent aussi). */
    const vivantes = Object.values(h.convs).filter((c) => !c.supprime).sort((a, b) => b.maj - a.maj);
    for (const c of vivantes.slice(MAX_CONVS)) h.convs[c.id] = { id: c.id, supprime: true, maj: c.maj, recu: t };
    if (Buffer.byteLength(JSON.stringify(h)) > TOTAL_MAX_OCTETS) return false;
    ecris(addr, h);
    return true;
  }

  /** Écrit une conversation. Une copie plus ancienne que celle du serveur est refusée (409) avec la sienne. */
  function pose(addr, id, c) {
    if (!adresseOk(addr)) return { ok: false, code: 401 };
    const n = nettoie(id, c);
    if (!n) return { ok: false, code: 400, raison: 'unreadable chat' };
    if (Buffer.byteLength(JSON.stringify(n)) > CONV_MAX_OCTETS) return { ok: false, code: 413, raison: 'this chat is too long to sync' };
    if (!rythmeOk(addr)) return { ok: false, code: 429, raison: 'too many saves — wait a minute' };
    const h = lis(addr), la = h.convs[id];
    if (la && la.maj > n.maj) { const o = Object.assign({}, la); delete o.recu; return { ok: false, code: 409, conv: o }; }
    h.convs[id] = Object.assign(n, { recu: maintenant() });
    if (!range(addr, h)) return { ok: false, code: 413, raison: 'your chat history is full — delete old chats' };
    return { ok: true };
  }

  /** Supprime : une pierre tombale, que les autres appareils liront. */
  function supprime(addr, id, maj) {
    if (!adresseOk(addr)) return { ok: false, code: 401 };
    if (!idOk(id)) return { ok: false, code: 400, raison: 'unreadable chat' };
    if (!rythmeOk(addr)) return { ok: false, code: 429, raison: 'too many saves — wait a minute' };
    const h = lis(addr);
    const t = Math.min(Number(maj) || maintenant(), maintenant() + AVANCE_MAX_MS);
    if (h.convs[id] && !h.convs[id].supprime && h.convs[id].maj > t) return { ok: false, code: 409, conv: (({ recu, ...o }) => o)(h.convs[id]) };
    h.convs[id] = { id, supprime: true, maj: t, recu: maintenant() };
    range(addr, h);
    return { ok: true };
  }

  return { depuis, pose, supprime, lis, nettoie };
}

module.exports = { cree, adresseOk, MAX_CONVS, CONV_MAX_OCTETS, TOTAL_MAX_OCTETS, TOMBE_MS, ECRITURES_PAR_MINUTE };
