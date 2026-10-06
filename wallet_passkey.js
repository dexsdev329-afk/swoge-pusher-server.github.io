'use strict';
/* ==================================================================
 * LE VERROU BIOMÉTRIQUE DU PORTEFEUILLE (Face ID / Touch ID / passkey)
 * ==================================================================
 *
 * Demande du proprietaire (06/10) : « se connecter au wallet avec Face ID ».
 *
 * CE QUE C'EST, ET SURTOUT CE QUE CE N'EST PAS :
 *   C'est un VERROU DE CONFORT ET DE VIE PRIVEE, pas un controle de garde. Il
 *   cache l'ecran du portefeuille (soldes, gestes) derriere la biometrie de
 *   l'appareil, comme une appli bancaire. Il ne tient AUCUNE cle et ne garde
 *   AUCUN acces aux fonds : toute transaction passe toujours par la signature
 *   du portefeuille du joueur (Privy / extension), inchangee. Un verrou casse
 *   ne peut donc jamais faire perdre d'argent — au pire il se contourne (on
 *   voit un solde, deja public on-chain) ou il ne marche pas (on retombe sur
 *   la connexion e-mail). On ne touche ni au bundle Privy ni au chemin des cles.
 *
 * POURQUOI MAISON, ET PAS PRIVY :
 *   Privy ne documente les passkeys que pour ses SDK React/natifs ; en vanilla
 *   JS (ce que le wallet utilise) la ceremonie WebAuthn n'est pas fournie.
 *   Plutot que de reconstruire a l'aveugle une cle d'auth dans le fichier des
 *   cles, on fait un WebAuthn STANDARD, verifie ici avec @simplewebauthn/server
 *   (la bibliotheque de reference), testable, independant de Privy.
 *
 * CE FICHIER : la couche crypto/orchestration seulement. Il ne lit ni n'ecrit
 * le disque (le serveur injecte le stockage) et ne parle pas reseau. La
 * bibliotheque @simplewebauthn est ESM ; on la charge par `import()` dynamique
 * (le serveur est CommonJS, Node 18+). Un defi (challenge) est a usage unique
 * et expire en cinq minutes — il vit en memoire, c'est tout ce qu'il lui faut.
 * ================================================================== */

/* Chargement paresseux de la bibliotheque ESM. `_setLib` permet a l'essai de
   poser un faux, pour verifier NOTRE orchestration sans vraie crypto WebAuthn
   (la crypto elle-meme est couverte en amont par @simplewebauthn). */
let _lib = null;
async function lib() {
  if (_lib) return _lib;
  _lib = await import('@simplewebauthn/server');
  return _lib;
}
function _setLib(l) { _lib = l; }

const low = (a) => String(a || '').toLowerCase();

/* Les defis en cours : addr -> { defi, exp }. Usage unique (pris = efface),
   cinq minutes de vie. Un defi perdu n'est jamais un drame : on en redemande. */
const DEFI_TTL = 5 * 60 * 1000;
const DEFIS = new Map();
function poseDefi(addr, defi) { DEFIS.set(low(addr), { defi, exp: Date.now() + DEFI_TTL }); }
function prendDefi(addr) {
  const e = DEFIS.get(low(addr));
  DEFIS.delete(low(addr));
  return (e && e.exp > Date.now()) ? e.defi : null;
}

/* Les options d'INSCRIPTION (enregistrer un passkey sur cet appareil). La page
   passe ensuite ces options a navigator.credentials.create via le navigateur. */
async function optionsInscription({ addr, rpId, nom, existantes }) {
  const L = await lib();
  const o = await L.generateRegistrationOptions({
    rpName: 'SWOGE Wallet',
    rpID: rpId,
    userName: nom || addr,
    userID: Buffer.from(low(addr)),
    attestationType: 'none',               /* on ne veut pas tracer l'appareil */
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',        /* la biometrie EST exigee */
      authenticatorAttachment: 'platform', /* Face ID / Touch ID, pas une cle USB */
    },
    excludeCredentials: (existantes || []).map((c) => ({ id: c.id, transports: c.transports })),
  });
  poseDefi(addr, o.challenge);
  return o;
}

/* Verifie la reponse d'inscription et rend la carte de cle a STOCKER (telle
   quelle) : { id, publicKey (base64url), counter, transports }. */
async function verifieInscription({ addr, reponse, rpId, origin }) {
  const L = await lib();
  const defi = prendDefi(addr);
  if (!defi) throw new Error('challenge expired or missing');
  const v = await L.verifyRegistrationResponse({
    response: reponse,
    expectedChallenge: defi,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) throw new Error('registration not verified');
  const c = v.registrationInfo.credential;   /* WebAuthnCredential : { id, publicKey:Uint8Array, counter, transports } */
  return {
    id: c.id,
    publicKey: Buffer.from(c.publicKey).toString('base64url'),
    counter: c.counter || 0,
    transports: c.transports || [],
  };
}

/* Les options d'AUTHENTIFICATION (deverrouiller). `existantes` : les cles
   enregistrees pour cette adresse, pour ne proposer que les bonnes. */
async function optionsAuth({ addr, rpId, existantes }) {
  const L = await lib();
  const o = await L.generateAuthenticationOptions({
    rpID: rpId,
    userVerification: 'required',
    allowCredentials: (existantes || []).map((c) => ({ id: c.id, transports: c.transports })),
  });
  poseDefi(addr, o.challenge);
  return o;
}

/* Verifie une reponse de deverrouillage contre la cle stockee `credit`. Rend
   { newCounter } (le serveur met a jour le compteur anti-rejeu) ou jette. */
async function verifieAuth({ addr, reponse, rpId, origin, credit }) {
  const L = await lib();
  const defi = prendDefi(addr);
  if (!defi) throw new Error('challenge expired or missing');
  if (!credit) throw new Error('unknown credential');
  const v = await L.verifyAuthenticationResponse({
    response: reponse,
    expectedChallenge: defi,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
    credential: {
      id: credit.id,
      publicKey: Buffer.from(credit.publicKey, 'base64url'),
      counter: credit.counter || 0,
      transports: credit.transports,
    },
  });
  if (!v.verified) throw new Error('authentication not verified');
  return { newCounter: v.authenticationInfo.newCounter };
}

module.exports = {
  optionsInscription, verifieInscription, optionsAuth, verifieAuth,
  poseDefi, prendDefi, _setLib, DEFI_TTL, _defis: DEFIS,
};
