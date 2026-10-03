'use strict';
/* ==================================================================
 * LA LIAISON DIRECTE AU NAVIGATEUR (2 octobre 2026)
 * ==================================================================
 * « Rapprocher les serveurs des joueurs — juste le navigateur. » Le navigateur part à
 * Amsterdam, le serveur du jeu reste en Californie avec ses données. Si les images
 * passaient encore par le serveur du jeu, chacune traverserait l'Atlantique DEUX fois
 * (Amsterdam → Californie → l'Europe du joueur) : pire qu'avant. La page parle donc au
 * navigateur directement, pour les images et les gestes.
 *
 * Qui décide reste le serveur du jeu : il lit la session du joueur et lui remet un TICKET,
 * signé avec NAVIGATEUR_SECRET (déjà partagé par les deux services), valable DUREE_MS. Le
 * navigateur vérifie la signature et l'échéance, et n'agit QUE pour l'adresse écrite dans le
 * ticket — jamais pour une adresse venue du corps de la requête. Le jeton de session du
 * joueur ne quitte jamais le serveur du jeu.
 *
 * Ce module est copié dans l'image du navigateur (Dockerfile.navigateur) : les deux côtés
 * signent et vérifient avec le même code, et filtrent les gestes avec la même liste.
 * ================================================================== */
const crypto = require('crypto');

const DUREE_MS = 15 * 60 * 1000;
const ACTIONS = ['goto', 'clic', 'defile', 'tape', 'touche', 'retour', 'avance', 'recharge', 'capture', 'copie'];
/* 03/10 : « Ctrl+A pour tout selectionner et copier ne fonctionne pas ». Les touches, avec leurs
   combinaisons : Control (le Cmd d'un Mac devient Control, le navigateur distant est sous Linux),
   Shift pour etendre une selection. Une liste fermee : jamais une combinaison du navigateur
   lui-meme (Ctrl+T, Ctrl+W, Ctrl+L, F12…). */
const TOUCHE_BASE = /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End)$/;
function toucheOk(k) {
  const t = String(k || '');
  if (/^Control\+[acvxzy]$/.test(t)) return true;
  if (/^(Control\+)?(Shift\+)?(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|Backspace|Delete|Tab)$/.test(t)) return true;
  return TOUCHE_BASE.test(t);
}
/* Les gestes du clavier vont vite : une frappe ne coute ni chargement ni capture. */
const CLAVIER = new Set(['tape', 'touche', 'copie']);

function mac(secret, addr, exp) {
  /* Préfixe propre aux tickets : une autre signature faite avec le même secret ne vaut pas ticket. */
  return crypto.createHmac('sha256', String(secret)).update('navigateur-ticket|' + addr + '|' + exp).digest('hex');
}

/** Le ticket du joueur `addr` (adresse de SESSION). */
function signe(secret, addr, maintenant) {
  const a = String(addr || '').toLowerCase();
  if (!secret || !/^0x[0-9a-f]{40}$/.test(a)) return null;
  const exp = (maintenant || Date.now()) + DUREE_MS;
  return { ticket: a + '.' + exp + '.' + mac(secret, a, exp), exp, dureeMs: DUREE_MS };
}

/** L'adresse que le ticket autorise, ou null (forme, signature, échéance). */
function verifie(secret, ticket, maintenant) {
  if (!secret) return null;
  const m = /^(0x[0-9a-f]{40})\.(\d{13})\.([0-9a-f]{64})$/.exec(String(ticket || '').trim());
  if (!m) return null;
  const exp = Number(m[2]), t = maintenant || Date.now();
  /* Échu, ou daté trop loin dans l'avenir (un ticket ne vit jamais plus de DUREE_MS). */
  if (!(exp > t) || exp - t > DUREE_MS + 60000) return null;
  const attendu = Buffer.from(mac(secret, m[1], exp), 'hex'), recu = Buffer.from(m[3], 'hex');
  return attendu.length === recu.length && crypto.timingSafeEqual(attendu, recu) ? m[1] : null;
}

/** Seuls les champs d'un geste passent ; le joueur n'en fait jamais partie. null : action inconnue. */
function champs(q) {
  q = q || {};
  const a = String(q.action || '');
  if (!ACTIONS.includes(a)) return null;
  const o = { action: a, ecran: q.ecran === 'telephone' ? 'telephone' : 'bureau' };
  if (a === 'goto') o.url = String(q.url || '').slice(0, 2000);
  if (a === 'clic') { o.x = Number(q.x); o.y = Number(q.y); }
  if (a === 'defile') o.dy = Number(q.dy);
  if (a === 'tape') o.texte = String(q.texte || '').slice(0, 500);
  if (a === 'touche') o.touche = String(q.touche || '').slice(0, 32);
  if (q.flux === true) o.flux = true;
  return o;
}

module.exports = { signe, verifie, champs, toucheOk, ACTIONS, CLAVIER, DUREE_MS };
