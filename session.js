'use strict';
/*
 * Sessions : signer une fois, rester connecte.
 *
 * Jusqu'ici chaque page refaisait tout le chemin — telecharger le SDK du
 * portefeuille, reveiller la session chez le fournisseur, reconstruire le
 * signataire, puis SIGNER un message. Deux allers-retours reseau et une
 * signature a chaque changement de page. Sur telephone, un hoquet suffisait a
 * deconnecter le joueur, sans message ni nouvelle tentative.
 *
 * Desormais la signature vaut un JETON. Le serveur le remet a la connexion, la
 * page le range, et la page suivante le presente : plus de SDK a charger, plus
 * de signature, une seule verification locale.
 *
 * Forme du jeton :  v1.<adresse>.<expiration>.<empreinte>
 * L'empreinte est un HMAC-SHA256 du reste, avec un secret que seul le serveur
 * connait. Personne ne peut donc en fabriquer un, ni repousser sa date.
 *
 * Ce qu'il faut savoir avant de s'en servir : c'est un jeton PORTEUR. Qui le
 * vole prend le compte, exactement comme le cookie de n'importe quel site.
 * D'ou une duree limitee, et une revocation possible en changeant le secret.
 */
const crypto = require('crypto');

const VERSION = 'v1';

/** Comparaison a temps constant : un `===` fuit la longueur du prefixe commun. */
function memeEmpreinte(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function empreinte(secret, corps) {
  return crypto.createHmac('sha256', secret).update(corps).digest('base64url');
}

/**
 * Fabrique un jeton pour `addr`, valable `ttlSec` secondes.
 */
function emettre(secret, addr, ttlSec) {
  if (!secret) throw new Error('secret de session manquant');
  const a = String(addr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('adresse invalide');
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSec) || 0);
  const corps = `${VERSION}.${a}.${exp}`;
  return `${corps}.${empreinte(secret, corps)}`;
}

/**
 * Relit un jeton. Retourne l'adresse, ou null si quoi que ce soit cloche —
 * forme, version, empreinte, date. Jamais d'exception : un jeton casse est un
 * cas ordinaire, pas une panne.
 */
function lire(secret, jeton) {
  if (!secret || typeof jeton !== 'string') return null;
  const bouts = jeton.split('.');
  if (bouts.length !== 4) return null;
  const [v, a, exp, sig] = bouts;
  if (v !== VERSION) return null;
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  if (!/^\d+$/.test(exp)) return null;
  if (Number(exp) * 1000 <= Date.now()) return null;          // perime
  if (!memeEmpreinte(sig, empreinte(secret, `${v}.${a}.${exp}`))) return null;
  return a;
}

/** Ce qu'il reste a vivre, en secondes (0 si mort). Sert a renouveler a temps. */
function restant(jeton) {
  if (typeof jeton !== 'string') return 0;
  const bouts = jeton.split('.');
  if (bouts.length !== 4 || !/^\d+$/.test(bouts[2])) return 0;
  return Math.max(0, Number(bouts[2]) - Math.floor(Date.now() / 1000));
}

module.exports = { VERSION, emettre, lire, restant };
