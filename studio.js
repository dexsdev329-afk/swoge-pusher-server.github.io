'use strict';
/* ==================================================================
 * SWOGE STUDIO — generer des images et des videos, payer en $SWOGE
 * ==================================================================
 *
 * L etat present, dit franchement : RIEN ne genere encore. Les cles des
 * fournisseurs (OpenAI pour l image, Claude pour le texte, Grok Imagine
 * pour la video) ne sont pas la, et le contrat de paiement n est pas cable.
 * La page le montre en « en preparation » plutot que de promettre ce qu elle
 * ne fait pas.
 *
 * Ce fichier pose donc DEUX choses qui, elles, sont reelles des maintenant
 * et ne demandent aucune cle :
 *
 *   1. LE REGISTRE DES MODELES. Comme le registre des connecteurs OSINT :
 *      chaque modele declare son genre, son fournisseur, son prix en $SWOGE,
 *      la cle qu il attend. Ajouter un modele plus tard ne touche ni la
 *      page ni la route — la page LIT le catalogue. C est le « systeme
 *      facilement extensible » demande, et c est structurel.
 *
 *   2. LA LOGIQUE DE PAIEMENT QUI NE PERD PAS D ARGENT. C est la seule
 *      partie ou une erreur coute des jetons reels : une double depense, ou
 *      une fausse confirmation qui credite une generation jamais payee. On
 *      l ecrit et on la teste MAINTENANT, sans reseau, parce qu elle ne
 *      depend d aucune cle — seulement d une decision correcte.
 *
 * La lecture on-chain elle-meme (aller chercher la transaction) est branchee
 * plus tard : `verifieRecu` prend un RECU deja lu, il ne lit pas la chaine.
 * C est ce qui le rend testable, et c est aussi la bonne separation : la
 * decision « faut-il crediter » ne doit pas dependre de la meteo d un RPC. */

const config = require('./config');

/* ==================================================================
 * LE REGISTRE DES MODELES
 * ================================================================== */

/* Le prix est en $SWOGE ENTIERS, jamais en unites de base : un prix ecrit
   en wei se relit faux six mois plus tard, et c est le genre d erreur qui
   fait payer mille fois trop. La conversion en unites de base se fait une
   seule fois, a la verification, avec les decimales du contrat. */
const MODELES = [];
function declareModele(m) {
  for (const champ of ['id', 'genre', 'fournisseur', 'prixSwoge']) {
    if (m[champ] === undefined) throw new Error('modele sans ' + champ + ' : ' + JSON.stringify(m));
  }
  if (!['image', 'video', 'texte'].includes(m.genre)) throw new Error('genre inconnu : ' + m.genre);
  if (MODELES.some((x) => x.id === m.id)) throw new Error('modele en double : ' + m.id);
  if (!(m.prixSwoge >= 0)) throw new Error('prix invalide : ' + m.id);
  MODELES.push(Object.assign({ cle: null, entree: 'prompt', actif: false, note: null }, m));
  return MODELES[MODELES.length - 1];
}

/* Un modele est ACTIF quand sa cle est dans l environnement de l hote. Sans
   la cle, il est declare et affiche, mais EN PREPARATION — un modele muet
   qui se dit muet vaut mieux qu un bouton qui echoue apres le paiement. */
function actif(m, env) {
  if (!m.cle) return false;                 /* rien n est actif tant que le paiement n est pas cable non plus */
  return !!(env || process.env)[m.cle];
}

/* ---- LES MODELES. Prix indicatifs, a regler avant l ouverture. ---- */
/* Image — OpenAI. */
declareModele({ id: 'image-openai', genre: 'image', fournisseur: 'OpenAI',
  nom: 'Image', modele: 'gpt-image-1.5', cle: 'OPENAI_API_KEY',
  prixSwoge: 5000, entree: 'prompt', resolutions: ['1024x1024', '1536x1024', '1024x1536'],
  note: 'Text-to-image. The same path the announcement posters already use.' });
/* Video — Grok Imagine. Image->video ET prompt->video. */
declareModele({ id: 'video-grok', genre: 'video', fournisseur: 'xAI Grok Imagine',
  nom: 'Video', modele: 'grok-imagine-video', cle: 'GROK_API_KEY',
  prixSwoge: 25000, entree: 'image_ou_prompt', durees: [6, 10], resolutions: ['720p', '1080p'],
  note: 'Image-to-video or prompt-to-video. Costs more: a video is more compute than an image.' });
/* Texte — Claude, pour les fonctions IA existantes (titres, descriptions,
   reformulation d un prompt). */
declareModele({ id: 'texte-claude', genre: 'texte', fournisseur: 'Anthropic Claude',
  nom: 'Text', modele: 'claude', cle: 'ANTHROPIC_API_KEY',
  prixSwoge: 500, entree: 'prompt',
  note: 'Rewrites a rough idea into a strong image or video prompt.' });

function catalogue(env) {
  return MODELES.map((m) => ({
    id: m.id, genre: m.genre, nom: m.nom, fournisseur: m.fournisseur,
    prixSwoge: m.prixSwoge, entree: m.entree,
    durees: m.durees || null, resolutions: m.resolutions || null,
    note: m.note, actif: actif(m, env),
    /* Ce qui manque pour l allumer, dit en clair. */
    enAttente: actif(m, env) ? null : (m.cle ? 'provider key not set (' + m.cle + ')' : 'not wired'),
  }));
}
const modele = (id) => MODELES.find((m) => m.id === id) || null;

/* ==================================================================
 * LE PAIEMENT — ne jamais crediter une generation non payee,
 * ne jamais crediter deux fois la meme transaction
 * ==================================================================
 *
 * Le seul endroit de ce fichier ou une erreur coute des jetons reels. Deux
 * dangers, symetriques, et il faut se defendre des DEUX :
 *
 *   LA DOUBLE DEPENSE : un utilisateur paie une fois, puis rejoue le meme
 *   hash de transaction pour obtenir dix generations. Defense : un hash est
 *   a USAGE UNIQUE. Le registre des hashes consommes est la verite, pas la
 *   parole du client.
 *
 *   LA FAUSSE CONFIRMATION : le client annonce « paye », mais la transaction
 *   n existe pas, ou va au mauvais destinataire, ou pour trop peu, ou n est
 *   pas encore confirmee. Defense : on ne croit RIEN de ce que dit le
 *   client. On verifie le recu lu sur la chaine — destinataire, jeton,
 *   montant, confirmations — et tout ecart refuse.
 *
 * `verifieRecu` ne lit pas la chaine : il DECIDE a partir d un recu deja lu.
 * C est ce qui le rend testable sans reseau, et c est la bonne separation —
 * la decision de crediter ne doit pas dependre de la meteo d un RPC. La
 * lecture (aller chercher la transaction par son hash) est le seul morceau
 * qui restera a brancher, et il ne DECIDE rien : il rapporte. */

/* Combien de blocs avant de croire un paiement. Une transaction a un bloc
   peut etre reorganisee ; a douze, la reorganisation est du domaine du
   jamais-vu sur une chaine EVM. Regle par l hote, plancher a 1. */
const CONFIRMATIONS_MIN = Math.max(1, Number(process.env.STUDIO_CONFIRMATIONS || 12));

/* Le destinataire des paiements et le jeton attendu viennent de la
   configuration de l hote, JAMAIS du message du client — c est la regle
   centrale du depot : « un geste n agit que sur des valeurs verifiees cote
   serveur ». Un paiement vers une autre adresse que la notre n est pas
   notre paiement, meme si le client jure que si. */
function destinataire() { return String(process.env.STUDIO_PAIEMENT_ADR || '').toLowerCase(); }
function jetonAttendu() { return String(config.SWOGE_TOKEN || '').toLowerCase(); }

/* En unites de base, avec les decimales du contrat. Le prix vit en jetons
   entiers ; la conversion est faite ICI, une fois, au moment de comparer. */
function enUnitesBase(prixSwoge, decimales) {
  const d = Number.isInteger(decimales) ? decimales : 18;
  return BigInt(Math.round(prixSwoge)) * (10n ** BigInt(d));
}

/* LA DECISION. `recu` est ce qu on a lu sur la chaine :
 *   { hash, versAdr, jetonAdr, montantBase (BigInt|string), confirmations,
 *     deAdr, statut (1 = reussie) }
 * `attendu` : { prixSwoge, decimales, deAdr (optionnel : le wallet connecte) }
 * Rend { ok, raison } — jamais une exception pour un paiement invalide : un
 * refus est un RESULTAT a montrer, pas un plantage. */
function verifieRecu(recu, attendu) {
  if (!recu || typeof recu !== 'object') return { ok: false, raison: 'no receipt read from the chain' };
  if (recu.statut !== 1 && recu.statut !== '1' && recu.statut !== true) {
    return { ok: false, raison: 'the transaction failed on-chain' };
  }
  /* Le destinataire. Configure cote hote ; un paiement ailleurs n est pas le
     notre. */
  const dest = destinataire();
  if (!dest) return { ok: false, raison: 'payment address not configured on the server' };
  if (String(recu.versAdr || '').toLowerCase() !== dest) {
    return { ok: false, raison: 'paid to the wrong address' };
  }
  /* Le bon jeton : un paiement en un autre jeton, ou en monnaie native, ne
     compte pas. C est une fraude courante — envoyer un jeton sans valeur a
     la bonne adresse. */
  if (String(recu.jetonAdr || '').toLowerCase() !== jetonAttendu()) {
    return { ok: false, raison: 'paid in the wrong token' };
  }
  /* Le montant : AU MOINS le prix. On compare en unites de base, en BigInt,
     jamais en flottant — un centieme de jeton perdu en flottant, multiplie
     par mille paiements, est un trou. */
  const du = enUnitesBase(attendu.prixSwoge, attendu.decimales);
  let paye;
  try { paye = BigInt(recu.montantBase); } catch (e) { return { ok: false, raison: 'unreadable amount' }; }
  if (paye < du) return { ok: false, raison: 'underpaid: ' + paye + ' < ' + du + ' base units' };
  /* L expediteur, quand on connait le wallet connecte : le paiement doit
     venir de LUI, sinon quelqu un crediterait sa session avec le paiement
     d un autre, vu passer sur la chaine. */
  if (attendu.deAdr && String(recu.deAdr || '').toLowerCase() !== String(attendu.deAdr).toLowerCase()) {
    return { ok: false, raison: 'paid by a different wallet than the one connected' };
  }
  /* Les confirmations : assez de blocs pour qu une reorganisation ne
     defasse pas le paiement APRES qu on a genere. */
  const conf = Number(recu.confirmations);
  if (!(conf >= CONFIRMATIONS_MIN)) {
    return { ok: false, raison: 'only ' + (conf || 0) + ' confirmation(s), need ' + CONFIRMATIONS_MIN,
             attendre: true };
  }
  return { ok: true, raison: 'verified: ' + paye + ' base units, ' + conf + ' confirmations' };
}

/* ==================================================================
 * LE REGISTRE DES HASHES CONSOMMES — l usage unique
 * ==================================================================
 * La verite sur « ce paiement a-t-il deja servi » ne peut pas vivre dans le
 * client : il mentirait. Elle vit ici. En memoire pour l instant, avec une
 * frontiere nette pour poser un stockage durable derriere (le meme role que
 * DATA_DIR ailleurs) : la fonction ne change pas, seulement ce qu elle
 * ecrit dessous.
 *
 * `reserve` est ATOMIQUE dans le fil unique de Node : tester-puis-poser sans
 * rien d asynchrone entre les deux, donc deux requetes sur le meme hash ne
 * peuvent pas passer toutes les deux. C est ce qui ferme la double depense
 * meme sous deux clics simultanes. */
const CONSOMMES = new Map();
function dejaConsomme(hash) { return CONSOMMES.has(String(hash || '').toLowerCase()); }
function reserve(hash, quoi) {
  const h = String(hash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) return { ok: false, raison: 'not a transaction hash' };
  if (CONSOMMES.has(h)) return { ok: false, raison: 'this transaction has already been used' };
  CONSOMMES.set(h, { t: Date.now(), quoi: quoi || null });
  return { ok: true };
}
/* Si la generation echoue APRES reservation, on rend le hash : l utilisateur
   a paye, il ne doit pas perdre son credit parce que le fournisseur a eu un
   hoquet. Rendre n est pas la meme chose que ne jamais reserver — entre les
   deux, la generation a eu lieu ou non, et c est ca qui tranche. */
function rend(hash) { CONSOMMES.delete(String(hash || '').toLowerCase()); }

module.exports = {
  MODELES, declareModele, actif, catalogue, modele,
  CONFIRMATIONS_MIN, destinataire, jetonAttendu, enUnitesBase, verifieRecu,
  CONSOMMES, dejaConsomme, reserve, rend,
  /* pret : rien ne genere tant que ni cle ni adresse de paiement ne sont la */
  ouvert: (env) => !!destinataire() && MODELES.some((m) => actif(m, env)),
};
