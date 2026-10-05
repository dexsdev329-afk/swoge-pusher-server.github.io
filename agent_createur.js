'use strict';
/* ==================================================================
 * LE CRÉATEUR SE SERT LUI-MÊME — attache son agent sans clé admin
 * ==================================================================
 *
 * Demande du propriétaire (05/10/2026) : « post la version fonctionnelle sur
 * le launchpad, je vais tester en mode utilisateur directement ». Jusqu'ici
 * /agent/attach était réservé au propriétaire (x-admin-key), le temps de la
 * démo. Pour qu'un créateur configure l'agent de SON jeton depuis le
 * launchpad, il faut une preuve qu'il EST bien le créateur — sans jamais lui
 * donner la clé admin, et sans croire une adresse sur parole.
 *
 * LA PREUVE, EN DEUX TEMPS, TOUJOURS CÔTÉ SERVEUR :
 *
 *   1. Le portefeuille SIGNE un message lisible (personal_sign). Le serveur
 *      récupère l'adresse signataire — personne ne peut signer à la place d'un
 *      autre. Le message porte l'adresse du jeton et un horodatage : une
 *      signature ne vaut que pour CE jeton et dans une fenêtre courte.
 *   2. Le serveur lit, SUR LA CHAÎNE, qui a créé ce jeton — `instant(token).creator`
 *      sur le launchpad (le même champ que l'événement LaunchedInstant). On
 *      n'attache que si le signataire EST ce créateur. Cacher un bouton n'est
 *      pas un contrôle d'accès ; cette double vérification l'est.
 *
 * Ce fichier ne touche ni ethers ni le RPC directement : il reçoit
 * `recupere(message, signature) → adresse` et `createurOnchain(token) → adresse|null`.
 * Ainsi l'essai tourne hors-ligne, sans réseau, et le serveur injecte les vrais.
 * Fail-closed : la moindre anomalie refuse (403/400), jamais « dans le doute, oui ».
 * ================================================================== */

const estAdresse = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const bas = (a) => String(a).toLowerCase();

/* La fenêtre pendant laquelle une signature est acceptée. Assez large pour le
   décalage d'horloge d'un navigateur, assez courte pour qu'une signature volée
   ne serve pas des jours. L'attache est idempotente (fusion, créateur seul),
   donc un rejeu dans la fenêtre ne peut rien faire d'autre que reconfigurer
   l'agent de son PROPRE jeton — mais on borne quand même. */
const FENETRE_MS = 15 * 60 * 1000;

/* Les gestes que le créateur peut signer. Le geste entre DANS le message signé :
   une signature pour « configure » ne vaut pas pour « unlink-x ». Borne le rejeu
   (constat de l'audit, 05/10) : une signature captée ne sert qu'à CE geste, sur
   SON propre jeton, et dans la fenêtre. */
const GESTES = ['configure', 'pause', 'link-x', 'unlink-x', 'link-tg', 'unlink-tg', 'fuel'];

/** Le message EXACT que le portefeuille doit signer. Déterministe : la page et
 *  le serveur le reconstruisent à l'identique à partir du jeton, du geste et de
 *  l'instant. Lisible par un humain dans la fenêtre de signature de son portefeuille.
 *  `action` par défaut 'configure' (rétro-compat de l'appel à un argument). */
function message(token, ts, action) {
  const geste = GESTES.includes(action) ? action : 'configure';
  return 'SWOGE AI Agent\n'
    + 'Action: ' + geste + '\n'
    + 'I am the on-chain creator of token ' + bas(token) + '\n'
    + 'and I authorize this action on its AI agent on swoge.\n'
    + 'This signature moves no funds and grants no spending power.\n'
    + 'Timestamp: ' + Number(ts);
}

/** Vérifie la preuve de création et rend le créateur (et le pool) à utiliser.
 *  deps.recupere(message, signature) → adresse signataire (ethers verifyMessage)
 *  deps.createurOnchain(token)       → le créateur lu sur la chaîne : soit une adresse,
 *                                      soit { creator, pool }, soit null si jamais lancé.
 *  deps.maintenant()                 → horloge (ms)
 *  Rend { ok, createur, pool } ou { ok:false, code, raison }. Le pool, comme le
 *  créateur, vient TOUJOURS de la chaîne — jamais d'une adresse prise dans la requête. */
async function verifie(o, deps) {
  o = o || {}; deps = deps || {};
  const maintenant = deps.maintenant || (() => Date.now());
  if (!estAdresse(o.token)) return { ok: false, code: 400, raison: 'token must be a 0x address' };
  const action = GESTES.includes(o.action) ? o.action : 'configure';
  const ts = Number(o.ts);
  if (!Number.isFinite(ts)) return { ok: false, code: 400, raison: 'missing or invalid timestamp' };
  const ecart = maintenant() - ts;
  /* Ni trop vieux, ni venu du futur (petite marge d'horloge dans les deux sens). */
  if (ecart > FENETRE_MS || ecart < -FENETRE_MS) return { ok: false, code: 400, raison: 'signature expired — sign again' };
  if (typeof o.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(o.signature)) return { ok: false, code: 400, raison: 'missing or malformed signature' };
  /* Rejeu : une signature deja utilisee ne resert pas (jeu de signatures vues, injecte). */
  if (deps.dejaVu && deps.dejaVu(o.signature)) return { ok: false, code: 409, raison: 'this signature was already used — sign again' };

  let signataire;
  try { signataire = deps.recupere(message(o.token, ts, action), o.signature); }
  catch (e) { return { ok: false, code: 400, raison: 'could not recover signer from signature' }; }
  if (!estAdresse(signataire)) return { ok: false, code: 400, raison: 'could not recover signer from signature' };

  let lu;
  try { lu = await deps.createurOnchain(o.token); }
  catch (e) { return { ok: false, code: 503, raison: 'could not read the token creator on-chain — try again' }; }
  const createur = (lu && typeof lu === 'object') ? lu.creator : lu;
  const pool = (lu && typeof lu === 'object' && estAdresse(lu.pool)) ? bas(lu.pool) : null;
  if (!estAdresse(createur)) return { ok: false, code: 404, raison: 'this token was not launched by a SWOGE launchpad (no on-chain creator)' };

  if (bas(signataire) !== bas(createur)) return { ok: false, code: 403, raison: 'the connected wallet is not the creator of this token' };
  return { ok: true, createur: bas(createur), pool };
}

module.exports = { message, verifie, FENETRE_MS, GESTES };
