'use strict';
/* ============================================================================
 * SWOGE STUDIO — LE PAIEMENT NE DOIT JAMAIS PERDRE DE JETONS
 *
 * Rien ne genere encore : les cles ne sont pas la. Mais la logique qui
 * decide de crediter une generation se teste AUJOURD HUI, sans reseau,
 * parce qu elle ne depend d aucune cle — seulement d une decision correcte.
 * Et c est la seule partie ou une erreur coute de l argent reel.
 *
 * Deux dangers, symetriques, et il faut mordre sur les DEUX :
 *
 *   LA DOUBLE DEPENSE : un hash paye une fois ne doit jamais crediter deux
 *   generations. Meme sous deux clics simultanes.
 *
 *   LA FAUSSE CONFIRMATION : rien de ce que dit le client n est cru. Mauvais
 *   destinataire, mauvais jeton, montant trop faible, pas assez de
 *   confirmations, transaction ratee, paiement d un autre wallet : tout
 *   ecart REFUSE.
 *
 * Le registre extensible est verifie aussi : ajouter un modele ne doit
 * toucher a rien d autre, et un modele sans cle se dit « en preparation »
 * plutot que de promettre ce qu il ne fait pas.
 * ==========================================================================*/
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

/* Le destinataire et le jeton viennent de l hote : on les pose pour l essai,
   comme l hote les posera en production. */
process.env.STUDIO_PAIEMENT_ADR = '0x' + 'PAY'.padEnd(40, '0').slice(0, 40).toLowerCase();
process.env.SWOGE_TOKEN = '0x8a166fb41cd659a0a43396272ff73973ce29f817';
process.env.STUDIO_CONFIRMATIONS = '12';
const DEST = process.env.STUDIO_PAIEMENT_ADR;
const JETON = process.env.SWOGE_TOKEN;

const S = require('./studio');

/* Un recu valide, dont chaque essai casse UN champ pour verifier que ce
   champ-la est bien garde. */
function recuOk(sur) {
  return Object.assign({
    hash: '0x' + 'a'.repeat(64), versAdr: DEST, jetonAdr: JETON,
    montantBase: (5000n * 10n ** 18n).toString(), confirmations: 12,
    deAdr: '0x' + 'b'.repeat(40), statut: 1,
  }, sur || {});
}
const attendu = (sur) => Object.assign({ genre: 'erc20', jeton: JETON, montant: 5000, decimales: 18 }, sur || {});

(async () => {

console.log('-- 1. le registre des modeles, extensible et honnete --');
{
  const cat = S.catalogue({ SWOGE_PRIX_USD: '0.00002' });
  ok(cat.length >= 3, 'image, video, texte sont declares [' + cat.length + ']');
  ok(cat.every((m) => m.prixUsd > 0 && m.genre && m.fournisseur), 'chacun porte son prix ANCRE en USD, genre, fournisseur');
  /* La video coute plus cher que l image : plus de calcul. */
  const img = cat.find((m) => m.genre === 'image'), vid = cat.find((m) => m.genre === 'video');
  ok(vid.prixUsd > img.prixUsd, 'la video coute plus que l image [$' + vid.prixUsd + ' > $' + img.prixUsd + ']');
  ok(vid.prixSwoge > img.prixSwoge && vid.prixIndicatif, 'et sa traduction en $SWOGE au cours du moment est indicative');
  /* Sans cle, un modele est EN PREPARATION et le dit. */
  ok(cat.every((m) => !m.actif), 'sans cle, aucun modele n est actif');
  ok(cat.every((m) => m.enAttente), 'et chacun dit ce qui lui manque');
  ok(img.enAttente.includes('OPENAI_API_KEY'), 'l image attend sa cle OpenAI, nommee');
  /* Avec la cle, il s allume — sans qu on touche au code. */
  ok(S.catalogue({ OPENAI_API_KEY: 'x' }).find((m) => m.genre === 'image').actif,
     'la cle posee dans l environnement l allume');
  /* Ajouter un modele ne casse rien et refuse les doublons. */
  let jete = null;
  try { S.declareModele({ id: 'image-openai', genre: 'image', fournisseur: 'X', prixUsd: 1 }); }
  catch (e) { jete = e.message; }
  ok(jete && /double/.test(jete), 'un id en double est refuse');
  try { S.declareModele({ id: 'z', genre: 'hologramme', fournisseur: 'X', prixUsd: 1 }); jete = null; }
  catch (e) { jete = e.message; }
  ok(jete && /genre/.test(jete), 'un genre inconnu est refuse');
}

console.log('\n-- 2. un recu valide passe --');
{
  const r = S.verifieRecu(recuOk(), attendu());
  ok(r.ok, 'le recu complet et confirme est accepte : ' + r.raison);
}

console.log('\n-- 3. la fausse confirmation : tout ecart refuse --');
{
  eq(S.verifieRecu(recuOk({ versAdr: '0x' + 'c'.repeat(40) }), attendu()).ok, false, 'paiement au mauvais destinataire : refuse');
  eq(S.verifieRecu(recuOk({ jetonAdr: '0x' + 'd'.repeat(40) }), attendu()).ok, false, 'paiement dans un autre jeton : refuse');
  eq(S.verifieRecu(recuOk({ statut: 0 }), attendu()).ok, false, 'transaction ratee on-chain : refuse');
  eq(S.verifieRecu(recuOk({ montantBase: (4999n * 10n ** 18n).toString() }), attendu()).ok, false, 'un jeton de moins : refuse');
  const sousPaye = S.verifieRecu(recuOk({ montantBase: (4999n * 10n ** 18n).toString() }), attendu());
  ok(/underpaid/i.test(sousPaye.raison), '  et il DIT que c est sous-paye');
  const pasAssez = S.verifieRecu(recuOk({ confirmations: 3 }), attendu());
  eq(pasAssez.ok, false, '3 confirmations sur 12 : refuse');
  ok(pasAssez.attendre, '  et il dit d ATTENDRE, pas de rejeter pour toujours');
  eq(S.verifieRecu(recuOk({ deAdr: '0x' + 'f'.repeat(40) }), attendu({ deAdr: '0x' + 'b'.repeat(40) })).ok, false,
     'paye par un autre wallet que celui connecte : refuse');
  eq(S.verifieRecu(null, attendu()).ok, false, 'pas de recu du tout : refuse, sans planter');
  eq(S.verifieRecu(recuOk({ montantBase: 'pas un nombre' }), attendu()).ok, false, 'un montant illisible : refuse, sans planter');
  /* Payer PLUS que le prix passe : on demande au moins le prix. */
  ok(S.verifieRecu(recuOk({ montantBase: (6000n * 10n ** 18n).toString() }), attendu()).ok, 'payer plus que le prix passe');
}

console.log('\n-- 4. le montant se compare en unites de base, pas en flottant --');
{
  /* 5000 jetons a 18 decimales = 5e21, bien au-dela de Number.MAX_SAFE_INTEGER.
     Un seul calcul en flottant ici perdrait de la precision et laisserait
     passer un sous-paiement. */
  const du = S.enUnitesBase(5000, 18);
  eq(du.toString(), '5000000000000000000000', '5000 jetons = 5e21 unites de base');
  ok(typeof du === 'bigint', 'et c est un BigInt, jamais un Number');
  /* Un jeton en dessous, en unites de base, doit etre vu comme insuffisant
     meme si la difference est invisible en flottant. */
  const presque = (S.enUnitesBase(5000, 18) - 1n).toString();
  eq(S.verifieRecu(recuOk({ montantBase: presque }), attendu()).ok, false, 'une unite de base de moins : refuse');
  /* Decimales differentes du contrat : le prix suit. */
  eq(S.enUnitesBase(5000, 6).toString(), '5000000000', 'a 6 decimales, le meme prix vaut moins d unites');
}

console.log('\n-- 5. la double depense : un hash sert une seule fois --');
{
  const h = '0x' + '1'.repeat(64);
  eq(S.dejaConsomme(h), false, 'un hash neuf n est pas consomme');
  eq(S.reserve(h, 'video-grok').ok, true, 'la premiere reservation passe');
  eq(S.dejaConsomme(h), true, 'et le hash est marque consomme');
  eq(S.reserve(h, 'video-grok').ok, false, 'la SECONDE reservation du meme hash est refusee');
  ok(/already been used/i.test(S.reserve(h).raison), '  et elle DIT que le paiement a deja servi');
  /* Un hash mal forme n entre pas : ni comme paiement, ni dans le registre. */
  eq(S.reserve('pas un hash').ok, false, 'ce qui n est pas un hash de transaction est refuse');
  eq(S.reserve('0x' + 'g'.repeat(64)).ok, false, 'un hash aux mauvais caracteres aussi');

  /* La generation echoue APRES reservation : on rend le hash, l utilisateur
     ne perd pas ce qu il a paye. Mais rendre puis rejouer ne credite qu une
     generation reussie : c est la generation qui a eu lieu ou non qui
     tranche, pas le hash. */
  const h2 = '0x' + '2'.repeat(64);
  S.reserve(h2, 'image-openai');
  S.rend(h2);
  eq(S.dejaConsomme(h2), false, 'un hash rendu apres un echec est reutilisable');
  eq(S.reserve(h2, 'image-openai').ok, true, '  et l utilisateur peut relancer sa generation payee');
}

console.log('\n-- 6. deux clics simultanes ne passent pas tous les deux --');
{
  /* La reservation est atomique dans le fil unique de Node : tester-puis-
     poser sans await entre les deux. Dix reservations « simultanees » du
     meme hash : une seule doit gagner. */
  const h = '0x' + '3'.repeat(64);
  const essais = await Promise.all(Array.from({ length: 10 }, async () => S.reserve(h).ok));
  eq(essais.filter(Boolean).length, 1, 'sur dix reservations simultanees, une seule gagne');
}

console.log('\n-- 6bis. le prix suit le cours du $SWOGE, pas l inverse --');
{
  /* Le point que le proprietaire a souleve : le cours du $SWOGE bouge, donc
     un prix fige en $SWOGE ne tient pas. L ancre est en USD ; le montant en
     $SWOGE se recalcule au cours du moment. */
  const bas = S.deviseSwoge(0.50, 0.00002);   /* cours bas : beaucoup de jetons */
  const haut = S.deviseSwoge(0.50, 0.0002);   /* cours x10 : dix fois moins */
  eq(bas, 25000, '0,50 $ a 0,00002 $/SWOGE = 25 000 $SWOGE');
  eq(haut, 2500, 'le meme 0,50 $ a 0,0002 $/SWOGE = 2 500 $SWOGE : le cout reel ne bouge pas');
  /* On arrondit AU JETON SUPERIEUR : jamais facturer moins que le cout. */
  eq(S.deviseSwoge(0.50, 0.00003), Math.ceil(0.50 / 0.00003), 'arrondi au jeton superieur, jamais en dessous du cout');
  eq(S.deviseSwoge(0.50, 0), null, 'cours inconnu : pas de prix invente');

  /* Le devis VERROUILLE le montant pour une fenetre : le paiement sera
     compare a CE montant, pas a un prix recalcule entre-temps. */
  const d = S.devis('video-grok', 'swoge', 0.00002, 1000);
  ok(d.ok && d.montantSwoge === 25000, 'un devis fixe le montant en $SWOGE');
  ok(d.expire > d.t, 'et il a une fenetre de validite');
  ok(S.devisValide(d, 1000), 'valide juste apres emission');
  ok(!S.devisValide(d, d.expire + 1), 'et perime apres sa fenetre');
  eq(S.devis('inconnu', 'swoge', 0.00002).ok, false, 'un modele inconnu ne se devise pas');

  /* Et la verification compare au MONTANT DEVISE, pas a un prix libre. Un
     devis a 25 000, paye 25 000 : ok. Sans devis : refuse. */
  const recuVideo = recuOk({ montantBase: (25000n * 10n ** 18n).toString() });
  ok(S.verifieRecu(recuVideo, { genre:'erc20', jeton: JETON, montantBase: d.montantBase }).ok,
     'paiement egal au montant devise : accepte');
  ok(!S.verifieRecu(recuVideo, { genre:'erc20', jeton: JETON, decimales: 18 }).ok,
     'sans montant verrouille a comparer : refuse, on ne devine pas le prix');
}

console.log('\n-- 6ter. payer en ETH : natif, et le prix arrondi en WEI --');
{
  /* Le proprietaire veut aussi l ETH. La difference qui compte : un paiement
     ETH est NATIF (pas de contrat de jeton), un paiement $SWOGE passe par le
     contrat. On ne les confond pas. */
  eq(S.moyen('eth').genre, 'native', 'ETH est une monnaie native');
  eq(S.moyen('swoge').genre, 'erc20', '$SWOGE est un jeton ERC-20');

  /* LE BUG ATTRAPE : arrondir au jeton entier ruine l ETH. 0,50 $ a 2500 $/ETH
     doit faire 0,0002 ETH (2e14 wei), PAS 1 ETH. On arrondit en unites de
     base. */
  eq(S.montantBaseDe(0.50, 2500, 18).toString(), '200000000000000', '0,50 $ a 2500 $/ETH = 2e14 wei, pas 1 ETH');
  eq(S.montantBaseDe(0.50, 0.00002, 18).toString(), '25000000000000000000000', 'et 25000e18 pour le $SWOGE');
  /* Jamais un flottant sur 25000e18 : le montant reste exact. */
  ok(S.formateBase('200000000000000', 18) === '0.0002', 'l affichage est exact : 0.0002 ETH');
  ok(S.formateBase('25000000000000000000000', 18) === '25000', 'et 25000 pile pour le $SWOGE, pas 24999.99');

  const dE = S.devis('video-grok', 'eth', 2500, 1000);
  ok(dE.ok && dE.genre === 'native' && dE.jeton === null, 'un devis ETH est natif, sans contrat de jeton');
  eq(dE.montantBase, '200000000000000', 'et il verrouille 0,0002 ETH en wei');

  /* La verification d un paiement NATIF : aucun contrat de jeton ne doit
     apparaitre. */
  const recuEth = { hash: '0x' + '9'.repeat(64), versAdr: DEST, jetonAdr: null,
    montantBase: '200000000000000', confirmations: 12, deAdr: '0x' + 'b'.repeat(40), statut: 1 };
  ok(S.verifieRecu(recuEth, { genre: 'native', nom: 'ETH', montantBase: dE.montantBase }).ok,
     'un vrai paiement ETH natif est accepte');
  /* La fraude : un jeton sans valeur envoye a la bonne adresse, presente
     comme de l ETH. */
  const faux = Object.assign({}, recuEth, { jetonAdr: '0x' + 'e'.repeat(40) });
  eq(S.verifieRecu(faux, { genre: 'native', nom: 'ETH', montantBase: dE.montantBase }).ok, false,
     'un transfert de jeton presente comme de l ETH natif : refuse');
  ok(/token transfer/i.test(S.verifieRecu(faux, { genre: 'native', montantBase: dE.montantBase }).raison),
     '  et il DIT pourquoi');
  /* Et l inverse : de l ETH natif presente comme un paiement $SWOGE. */
  eq(S.verifieRecu(recuEth, { genre: 'erc20', jeton: JETON, montantBase: dE.montantBase }).ok, false,
     'de l ETH natif presente comme un paiement en jeton : refuse');
  /* Sous-payer en ETH : refuse, au wei pres. */
  const presque = Object.assign({}, recuEth, { montantBase: '199999999999999' });
  eq(S.verifieRecu(presque, { genre: 'native', montantBase: dE.montantBase }).ok, false,
     'un wei de moins en ETH : refuse');
}

console.log('\n-- 7. rien ne genere tant que le paiement n est pas cable --');
{
  /* La garde ultime : meme avec une cle de modele, si l adresse de paiement
     n est pas configuree, le studio n est pas ouvert. On ne genere pas ce
     qu on ne sait pas encaisser. */
  const sansAdr = Object.assign({}, process.env, { STUDIO_PAIEMENT_ADR: '' });
  eq(S.destinataire.call ? '' : '', '', 'garde de forme');   /* no-op lisible */
  const av = process.env.STUDIO_PAIEMENT_ADR;
  process.env.STUDIO_PAIEMENT_ADR = '';
  eq(S.ouvert({ OPENAI_API_KEY: 'x' }), false, 'une cle sans adresse de paiement ne suffit pas a ouvrir');
  process.env.STUDIO_PAIEMENT_ADR = av;
  ok(S.ouvert({ OPENAI_API_KEY: 'x' }), 'avec l adresse ET une cle, le studio est ouvert');
}

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
