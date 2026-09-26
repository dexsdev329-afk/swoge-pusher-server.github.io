'use strict';
/* ==================================================================
 * STUDIO — LA REPRISE D'UNE RÉPONSE APRÈS UN RECHARGEMENT
 * ==================================================================
 *
 * Signalé par le propriétaire le 26 septembre 2026 : « si l'utilisateur
 * actualise, il perd toutes ses données du chat ». Le fil était gardé dans le
 * navigateur, mais une réponse EN COURS ne l'était nulle part : le serveur la
 * finissait et la FACTURAIT, la page rechargée ne la montrait jamais. Le
 * joueur payait une réponse qu'il ne voyait pas.
 *
 * Chaque demande porte un identifiant tiré par la page (`rid`). Le serveur
 * garde, par ADRESSE DE SESSION et par `rid`, l'état de la réponse — en cours
 * (avec le texte déjà reçu), finie (le résultat complet, facture comprise) ou
 * ratée — pendant GARDE_MS. La page rechargée la redemande. Une autre adresse
 * ne lit rien : la clé est l'adresse de la session, jamais une adresse reçue.
 * En mémoire seulement : un redémarrage du serveur les oublie (la page le dit).
 * ================================================================== */

const GARDE_MS = 60 * 60 * 1000;
const MAX = 5000;
const TABLE = new Map();

const ridOk = (rid) => typeof rid === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(rid);
const cle = (addr, rid) => String(addr).toLowerCase() + '|' + rid;

function menage(t) {
  for (const [k, v] of TABLE) if (t - v.t > GARDE_MS) TABLE.delete(k);
  while (TABLE.size > MAX) TABLE.delete(TABLE.keys().next().value);
}

/** Pose ou complète l'état d'une demande. Sans `rid` valide, ne fait rien. */
function note(addr, rid, patch, maintenant) {
  if (!addr || !ridOk(rid)) return null;
  const t = maintenant || Date.now();
  const k = cle(addr, rid);
  const v = Object.assign(TABLE.get(k) || { t }, patch, { t });
  TABLE.delete(k); TABLE.set(k, v);          /* la plus récente en dernier */
  menage(t);
  return v;
}

/** Ajoute du texte reçu à une réponse en cours. */
function ajoute(addr, rid, texte) {
  if (!addr || !ridOk(rid)) return;
  const v = TABLE.get(cle(addr, rid));
  if (v && v.status === 'pending') v.texte = (v.texte || '') + String(texte || '');
}

function lit(addr, rid, maintenant) {
  if (!addr || !ridOk(rid)) return null;
  const v = TABLE.get(cle(addr, rid));
  if (!v || (maintenant || Date.now()) - v.t > GARDE_MS) return null;
  return v;
}

module.exports = { note, ajoute, lit, ridOk, GARDE_MS, TABLE };
