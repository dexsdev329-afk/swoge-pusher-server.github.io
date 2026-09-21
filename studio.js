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

/* ---- LE PRIX EST ANCRE EN USD, PAS EN $SWOGE ----
 * Le cout reel d une generation, c est ce que le fournisseur nous facture,
 * en dollars. Le cours du $SWOGE bouge tous les jours : un prix fige a
 * « 25 000 $SWOGE » devient absurde si le $SWOGE fait x10, et nous fait
 * perdre de l argent s il chute. On ancre donc chaque modele en USD
 * (`prixUsd`, cout fournisseur + marge), et on convertit en $SWOGE AU
 * MOMENT du devis, avec le cours du $SWOGE lu sur le dex — le meme que le
 * scan et la colonie lisent deja, donc aucun appel de plus.
 *
 * Le devis VERROUILLE le montant en $SWOGE pour quelques minutes : entre le
 * moment ou on annonce le prix et celui ou le joueur paie, le cours n a pas
 * le temps de deriver assez pour que ca compte, et s il derive, on redevise.
 * La conversion en unites de base, elle, se fait une seule fois a la
 * verification, avec les decimales du contrat. */
const MODELES = [];
function declareModele(m) {
  for (const champ of ['id', 'genre', 'fournisseur', 'prixUsd']) {
    if (m[champ] === undefined) throw new Error('modele sans ' + champ + ' : ' + JSON.stringify(m));
  }
  if (!['image', 'video', 'texte', 'reponse'].includes(m.genre)) throw new Error('genre inconnu : ' + m.genre);
  if (MODELES.some((x) => x.id === m.id)) throw new Error('modele en double : ' + m.id);
  if (!(m.prixUsd > 0)) throw new Error('prix USD invalide : ' + m.id);
  MODELES.push(Object.assign({ cle: null, entree: 'prompt', actif: false, note: null }, m));
  return MODELES[MODELES.length - 1];
}

/* Le cours du $SWOGE en USD. Pour l instant, un reglage de l hote
   (`SWOGE_PRIX_USD`) — quand le studio ouvrira, ce sera `lisDex(SWOGE).prix`,
   deja en cache. `null` quand on ne le connait pas : alors on n affiche pas
   un prix en $SWOGE qu on serait incapable de tenir. */
function prixSwogeUsd(env) {
  const v = Number((env || process.env).SWOGE_PRIX_USD);
  return v > 0 ? v : null;
}

/* USD -> unites de base de la monnaie, ARRONDI AU SUPERIEUR, en BigInt.
 *
 * LE PIEGE, attrape a l essai : arrondir au JETON entier marche pour le
 * $SWOGE (un jeton vaut ~0,00002 $) mais RUINE l ETH — 0,50 $ a 2500 $/ETH
 * donne 0,0002 ETH, et ceil au jeton entier facturerait 1 ETH, soit 2500 $
 * pour une generation a 0,50 $. On arrondit donc en UNITES DE BASE (wei),
 * la ou 0,0002 ETH = 2e14 wei se represente exactement.
 *
 * Et on ne multiplie jamais un flottant par 1e18 : 25000e18 depasse le plus
 * grand entier sur d un flottant. On met prix et cours a l echelle entiere
 * (1e12), puis tout le calcul est en BigInt. */
const ECHELLE = 1000000000000n;   /* 1e12 : 12 decimales, assez pour un cours a 1e-9 $ */
function montantBaseDe(prixUsd, cours, decimales) {
  if (!(cours > 0) || !(prixUsd > 0)) return null;
  const p = BigInt(Math.round(Number(prixUsd) * 1e12));
  const c = BigInt(Math.round(Number(cours) * 1e12));
  if (c <= 0n) return null;
  const d = BigInt(Number.isInteger(decimales) ? decimales : 18);
  /* ceil(p * 10^d / c), les echelles 1e12 s annulent. */
  const num = p * (10n ** d);
  return (num + c - 1n) / c;
}

/* Unites de base -> texte exact, sans flottant. 25000e18 -> « 25000 »,
   2e14 a 18 decimales -> « 0.0002 ». L affichage ne doit jamais montrer
   24999.9999 la ou le montant facture est exactement 25000. */
function formateBase(base, decimales) {
  let b = BigInt(base);
  const d = BigInt(Number.isInteger(decimales) ? decimales : 18);
  const un = 10n ** d;
  const entier = b / un;
  let frac = (b % un).toString().padStart(Number(d), '0').replace(/0+$/, '');
  return frac ? entier + '.' + frac : entier.toString();
}

/* USD -> $SWOGE ENTIERS, pour l affichage indicatif du catalogue seulement.
   Le montant REELLEMENT facture passe par montantBaseDe, en unites de base. */
function deviseSwoge(prixUsd, cours) {
  if (!(cours > 0)) return null;
  return Math.ceil(Number(prixUsd) / cours);
}

/* Un devis : le montant en $SWOGE verrouille pour une fenetre. Le paiement
   sera compare a CE montant, pas a un prix recalcule entre-temps. */
const DEVIS_FENETRE_MS = Math.max(60000, Number(process.env.STUDIO_DEVIS_MS || 5 * 60 * 1000));
function devis(id, moyenId, cours, maintenant) {
  const md = modele(id);
  if (!md) return { ok: false, raison: 'unknown model' };
  const mo = moyen(moyenId);
  if (!mo) return { ok: false, raison: 'unknown payment method' };
  /* Combien d unites de LA MONNAIE CHOISIE pour couvrir le prix USD. Arrondi
     au superieur : jamais facturer moins que le cout. */
  if (!(cours > 0)) return { ok: false, raison: 'the ' + mo.nom + ' price is not available right now' };
  const base = montantBaseDe(md.prixUsd, cours, mo.decimales);
  if (base === null) return { ok: false, raison: 'the ' + mo.nom + ' price is not available right now' };
  /* Le montant humain, pour l affichage : les unites de base ramenees a la
     monnaie. Entier pour le $SWOGE, fractionnaire pour l ETH (0,0002). */
  const montant = Number(base) / Math.pow(10, mo.decimales);
  const t = maintenant || Date.now();
  return { ok: true, id, moyen: mo.id, nom: mo.nom, genre: mo.genre, jeton: mo.jeton(),
           decimales: mo.decimales, prixUsd: md.prixUsd, coursUsd: cours,
           montant, montantTexte: formateBase(base, mo.decimales), montantBase: base.toString(),
           montantSwoge: mo.id === 'swoge' ? Math.round(montant) : null,
           t, expire: t + DEVIS_FENETRE_MS };
}
function devisValide(d, maintenant) {
  return !!(d && d.ok && (maintenant || Date.now()) < d.expire);
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
  prixUsd: 0.10, entree: 'prompt', resolutions: ['1024x1024', '1536x1024', '1024x1536'],
  note: 'Text-to-image. The same path the announcement posters already use.' });
/* Video — Grok Imagine. Image->video ET prompt->video. */
declareModele({ id: 'video-grok', genre: 'video', fournisseur: 'xAI Grok Imagine',
  nom: 'Video', modele: 'grok-imagine-video', cle: 'GROK_API_KEY',
  prixUsd: 0.50, entree: 'image_ou_prompt', durees: [6, 10], resolutions: ['720p', '1080p'],
  note: 'Image-to-video or prompt-to-video. Costs more: a video is more compute than an image.' });
/* Texte — Claude, pour les fonctions IA existantes (titres, descriptions,
   reformulation d un prompt). */
declareModele({ id: 'texte-claude', genre: 'texte', fournisseur: 'Anthropic Claude',
  nom: 'Text', modele: 'claude', cle: 'ANTHROPIC_API_KEY',
  prixUsd: 0.01, entree: 'prompt',
  note: 'Rewrites a rough idea into a strong image or video prompt.' });
/* Reponse — facon Perplexity : une question, une reponse SOURCEE. Elle
   cherche le web et repond en citant. Fournisseur Perplexity, ou Claude
   avec recherche web — le registre permet d en changer sans toucher la page. */
declareModele({ id: 'reponse-perplexity', genre: 'reponse', fournisseur: 'Perplexity',
  nom: 'Answer', modele: 'sonar', cle: 'PERPLEXITY_API_KEY',
  prixUsd: 0.02, entree: 'question',
  note: 'Ask a question, get an answer with its sources \u2014 like Perplexity. Cited, not made up.' });
/* Chat — Claude en conversation, pour tout le reste. C est la brique qui fait
   de Studio « tous les modeles au meme endroit » plutot qu un simple
   generateur d images. */
declareModele({ id: 'chat-claude', genre: 'texte', fournisseur: 'Anthropic Claude',
  nom: 'Chat', modele: 'claude', cle: 'ANTHROPIC_API_KEY',
  prixUsd: 0.02, entree: 'prompt',
  note: 'A conversation with Claude \u2014 the everything model, in the same place.' });

function catalogue(env) {
  const cours = prixSwogeUsd(env);
  return MODELES.map((m) => ({
    id: m.id, genre: m.genre, nom: m.nom, fournisseur: m.fournisseur,
    /* Le prix vrai, l ancre : en USD. */
    prixUsd: m.prixUsd,
    /* Et sa traduction en $SWOGE AU COURS DU MOMENT — indicative : le
       montant exact est verrouille dans un devis au moment de payer. Null
       si on ne connait pas le cours, plutot qu un chiffre qu on ne tiendrait
       pas. */
    prixSwoge: deviseSwoge(m.prixUsd, cours),
    prixIndicatif: true,
    entree: m.entree, durees: m.durees || null, resolutions: m.resolutions || null,
    note: m.note, actif: actif(m, env),
    enAttente: actif(m, env) ? null : (m.cle ? 'provider key not set (' + m.cle + ')' : 'not wired'),
  }));
}
const modele = (id) => MODELES.find((m) => m.id === id) || null;

/* ==================================================================
 * LES MOYENS DE PAIEMENT — $SWOGE, ou ETH
 * ==================================================================
 * Le wallet accepte plusieurs monnaies : on laisse payer en $SWOGE (le
 * jeton, ERC-20) ou en ETH (la monnaie native de la chaine). Le prix reste
 * ancre en USD ; chaque moyen le convertit a SON cours.
 *
 * LA DIFFERENCE QUI COMPTE POUR LA SECURITE : un paiement NATIF (ETH) est un
 * transfert de valeur, il n a pas de contrat de jeton. Un paiement ERC-20
 * ($SWOGE) passe par le contrat du jeton. Les confondre est une fraude
 * classique — envoyer un jeton sans valeur a la bonne adresse et jurer que
 * c est de l ETH. La verification exige donc, pour le natif, qu il n y ait
 * AUCUN contrat de jeton dans le recu ; pour l ERC-20, que ce soit LE bon
 * contrat. Le registre est extensible : ajouter une monnaie, c est une
 * entree de plus, rien d autre. */
const MOYENS = {
  swoge: { id: 'swoge', nom: '$SWOGE', genre: 'erc20', decimales: 18,
           coursEnv: 'SWOGE_PRIX_USD', jeton: () => jetonAttendu(),
           chaine: 'Robinhood Chain' },
  eth: { id: 'eth', nom: 'ETH', genre: 'native', decimales: 18,
         coursEnv: 'ETH_PRIX_USD', jeton: () => null,
         chaine: 'Robinhood Chain' },
};
function moyen(id) { return MOYENS[id] || null; }
function coursMoyen(id, env) {
  const m = MOYENS[id];
  if (!m) return null;
  const v = Number((env || process.env)[m.coursEnv]);
  return v > 0 ? v : null;
}

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
  /* LA MONNAIE : natif ou ERC-20, et on ne les confond pas.
     - erc20 : ce doit etre LE bon contrat de jeton. Un autre jeton, meme
       envoye a la bonne adresse, ne compte pas — fraude classique.
     - natif : il ne doit y avoir AUCUN contrat de jeton. Sinon quelqu un
       paie un jeton sans valeur et le fait passer pour de l ETH. */
  const genre = attendu.genre || 'erc20';
  if (genre === 'erc20') {
    const jeton = String(attendu.jeton || jetonAttendu());
    if (!jeton) return { ok: false, raison: 'no token address to check against' };
    if (String(recu.jetonAdr || '').toLowerCase() !== jeton.toLowerCase()) {
      return { ok: false, raison: 'paid in the wrong token' };
    }
  } else if (genre === 'native') {
    if (recu.jetonAdr) {
      return { ok: false, raison: 'expected a native ' + (attendu.nom || 'ETH')
                                + ' payment, but a token transfer was sent' };
    }
  } else {
    return { ok: false, raison: 'unknown payment kind: ' + genre };
  }
  /* Le montant du : celui du DEVIS verrouille — le seul qui fait foi, pas un
     prix recalcule apres coup. On accepte le montant deja en unites de base
     (`montantBase`) ou un montant a convertir. Compare en BigInt, jamais en
     flottant : un centieme perdu, multiplie par mille paiements, est un trou. */
  let du;
  if (attendu.montantBase !== undefined && attendu.montantBase !== null) {
    try { du = BigInt(attendu.montantBase); } catch (e) { return { ok: false, raison: 'bad quote amount' }; }
  } else if (attendu.montant > 0) {
    du = enUnitesBase(attendu.montant, attendu.decimales);
  } else if (attendu.montantSwoge > 0) {
    du = enUnitesBase(attendu.montantSwoge, attendu.decimales);   /* compat */
  } else {
    return { ok: false, raison: 'no locked quote amount to check against' };
  }
  if (!(du > 0n)) return { ok: false, raison: 'quote amount is zero' };
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
  MOYENS, moyen, coursMoyen,
  prixSwogeUsd, deviseSwoge, montantBaseDe, formateBase, devis, devisValide, DEVIS_FENETRE_MS,
  CONFIRMATIONS_MIN, destinataire, jetonAttendu, enUnitesBase, verifieRecu,
  CONSOMMES, dejaConsomme, reserve, rend,
  /* pret : rien ne genere tant que ni cle ni adresse de paiement ne sont la */
  ouvert: (env) => !!destinataire() && MODELES.some((m) => actif(m, env)),
};
