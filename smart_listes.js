'use strict';
/* ==================================================================
 * LES WALLETS DU BRIEF (15/10/2026) — UNE TABLE, PAS UNE MESURE A NOUS
 * ==================================================================
 *
 * Chaque ligne vient du brief d'analyste ecrit par le proprietaire le
 * 15/10/2026 (texte complet : smart_brief.js). Les chiffres portes ici sont
 * les SIENS : ils n'ont PAS ete revérifiés sur la chaine par ce depot. La
 * seule lecture faite ici (sonde du 15/10, voir EXPLOITATION.md) dit comment
 * un achat de Sniper 1 se presente sur la chaine, pas s'il gagne.
 *
 * Le role dit ce que vaut l'achat d'un wallet pour le verdict :
 *   fort     regle 3 du brief : « Sniper 1, 0x1ad70bc7 ou 0xb255c023 vient
 *            d'acheter (moins de 5 min) »
 *   faible   un wallet suivi qui n'est PAS dans la regle 3 (0xc8b58075, les
 *            deux wallets lies a Sniper 1, le groupe a tester) : « un seul
 *            signal faible » mene a SURVEILLER, jamais a ACHETER
 *   neutre   « leur achat ne prouve rien » (bots rapides, sniper perdant)
 *   negatif  « leur achat est un signal NEGATIF » (equipe de lancement)
 *   dev      le dev d'IGNITION : son RACHAT apres une reclamation de frais est
 *            un signal (regle 3), pas son achat seul
 *
 * Adresses PARTIELLES : le brief ne donne que 0x5aafc1f2… et 0xad01c20d…. On
 * les garde en PREFIXE (10 caracteres, 0x + 8 chiffres hex) et on compare par
 * prefixe. Elles ne peuvent PAS servir de filtre au noeud (un topic exige
 * l'adresse entiere) : elles ne sont reconnues que parmi des acheteurs deja
 * lus. Une collision fortuite sur 8 chiffres hex vaut 1 sur 4,3 milliards
 * par adresse lue — negligeable, mais ce n'est pas une identite prouvee.
 * ================================================================== */

const SOURCE = 'brief du proprietaire du 15/10/2026';

const ROLES = {
  SNIPER_1: 'SNIPER_1',
  SNIPER_1_LIE: 'SNIPER_1_LIE',
  SUIVRE: 'SUIVRE',
  GROUPE_A_TESTER: 'GROUPE_A_TESTER',
  BOT_RAPIDE: 'BOT_RAPIDE',
  SNIPER_PERDANT: 'SNIPER_PERDANT',
  BUNDLE: 'BUNDLE',
  DEV_IGNITION: 'DEV_IGNITION',
};

/* Chaque entree : adresse (entiere) OU prefixe (partielle), role, signal, nom
   court montre au proprietaire, et ce que le brief en dit, chiffres compris. */
const WALLETS = [
  { adresse: '0x7632bd8e72767ed67a724c564c42ceea98e81180', role: ROLES.SNIPER_1, signal: 'fort', nom: 'Sniper 1',
    source: SOURCE + ' : « confirmé » ; ~100 jetons depuis juillet, 29 % de gagnants, gagnants ×5,5 en moyenne, perdants ×0,57 ; '
      + '~13 600 $ mis, ~+21 400 $ dont presque tout sur BULLISH (188 $ à 8 k$ de capi, 7 min après le lancement, ×100) ; sans BULLISH +8 % ; '
      + 'entre en moyenne 72 min après le lancement (routeurs 0x / Relay) ; gagne entre 10 et 60 min et sous 10 k$ ou 30-100 k$ ; '
      + 'perd au-dessus de 100 k$ (1 gagnant sur 14) et après 6 h (3 sur 26) ; ~100 $ par jeton, garde ~3 h',
    mesure: { jetons: 100, partGagnants: 29, gagnantMoyen: 5.5, perdantMoyen: 0.57, miseUsd: 13600, gainUsd: 21400, sansBullishPct: 8, entreeMoyenneMin: 72, perteAuDessus100k: '1/14', perteApres6h: '3/26' } },
  { adresse: '0x381d02f5578a1d5872d095006fcc2dfeacb7b60c', role: ROLES.SNIPER_1_LIE, signal: 'faible', nom: 'Sniper 1 (lié)',
    source: SOURCE + ' : « probablement au même propriétaire » que Sniper 1 ; aucun chiffre propre' },
  { adresse: '0x3ef061aa8a4b83699a2a1c63049e147a4b4000c1', role: ROLES.SNIPER_1_LIE, signal: 'faible', nom: 'Sniper 1 (lié)',
    source: SOURCE + ' : « probablement au même propriétaire » que Sniper 1 ; aucun chiffre propre' },
  { adresse: '0x1ad70bc7ac98539dada8f97360d353687f6c29d6', role: ROLES.SUIVRE, signal: 'fort', nom: 'Suivi 0x1ad70bc7',
    source: SOURCE + ' : 34 % de gagnants, +5 000 $, VANTOR ×8,5, garde ~7 h ; « le plus facile à copier après Sniper 1 » (dernières semaines)',
    mesure: { partGagnants: 34, gainUsd: 5000, meilleur: 'VANTOR ×8,5', tenueH: 7 } },
  { adresse: '0xb255c02311fea12523d8d15c4938f0a53d2a2870', role: ROLES.SUIVRE, signal: 'fort', nom: 'Suivi 0xb255c023',
    source: SOURCE + ' : 25 % de gagnants, +2 700 $, BULLISH ×7 (dernières semaines)',
    mesure: { partGagnants: 25, gainUsd: 2700, meilleur: 'BULLISH ×7' } },
  /* Suivi, mais ABSENT de la regle 3 : son achat est un signal faible. */
  { adresse: '0xc8b580755bf30d1dcce76bfcfe29e8129637460e', role: ROLES.SUIVRE, signal: 'faible', nom: 'Suivi 0xc8b58075',
    source: SOURCE + ' : 39 % de gagnants, +4 000 $ sur 97 jours ; pas dans la règle 3 du brief',
    mesure: { partGagnants: 39, gainUsd: 4000, jours: 97 } },
  { adresse: '0x84b68f5785a29435f17d2d3857a0d378a1489f36', role: ROLES.GROUPE_A_TESTER, signal: 'faible', nom: 'Groupe à tester 0x84b68f57',
    source: SOURCE + ' : achète souvent 0,4 à 6 min AVANT Sniper 1 (CHIP, DAEMON, EOSA…) ; « groupe à tester, pas encore prouvé rentable »' },
  /* PARTIELLES : le brief ne donne que ces 8 chiffres hex. */
  { prefixe: '0x5aafc1f2', partielle: true, role: ROLES.GROUPE_A_TESTER, signal: 'faible', nom: 'Groupe à tester 0x5aafc1f2…',
    source: SOURCE + ' : adresse PARTIELLE dans le brief (0x5aafc1f2…), avec 0x84b68f57' },
  { prefixe: '0xad01c20d', partielle: true, role: ROLES.GROUPE_A_TESTER, signal: 'faible', nom: 'Groupe à tester 0xad01c20d…',
    source: SOURCE + ' : adresse PARTIELLE dans le brief (0xad01c20d…), avec 0x84b68f57' },
  ...['0x2fd1887e5d99014cb0b8884f06560ed20d65003d', '0x9bf265c742d96aacf1083ef24c9110240af0bea9', '0x2a4d34cd09a36f59ae3bedc0880cd5da929321d7',
    '0x53e68553ca08f512423628d64c01b0a14dfcda99', '0x5b7e7cdf20193286bc9109f92ba7d12819968225', '0x7f7c73aad4d210ec65bccb341df090cd63d49aaa']
    .map((a) => ({ adresse: a, role: ROLES.BOT_RAPIDE, signal: 'neutre', nom: 'Bot rapide ' + a.slice(0, 10),
      source: SOURCE + ' : bot rapide, 300 à 700 jetons par semaine, garde quelques minutes ; « leur achat ne prouve rien »' })),
  { adresse: '0xcc00d47039dc20754eaeb3a21f7891226d52534c', role: ROLES.SNIPER_PERDANT, signal: 'neutre', nom: 'Sniper du 1er bloc (perdant)',
    source: SOURCE + ' : vrai sniper du premier bloc, perdant (−1 500 $ en 3 jours)', mesure: { gainUsd: -1500, jours: 3 } },
  { adresse: '0xe1e514008f797303634c28ea2e6bb8fe2968350c', role: ROLES.BUNDLE, signal: 'negatif', nom: 'Équipe de lancement 0xe1e51400',
    source: SOURCE + ' : équipe de lancement (bundle) sur VANTOR et BORRO ; « leur achat est un signal NÉGATIF (ils revendent sur toi) »' },
  { adresse: '0x7d17bfa7383e42e8df00ae042dcaf24748dd69b9', role: ROLES.DEV_IGNITION, signal: 'dev', nom: 'Dev IGNITION',
    source: SOURCE + ' : un seul jeton lancé (IGNITION, 12/10) ; gagne avec les frais de créateur (34,75 ETH réclamés), pas en vendant ; '
      + 'rachète juste après avoir réclamé (signal de soutien) ; ses « nouveaux jetons » (旺柴, Altai, Larry) sont des airdrops de spam',
    mesure: { lancements: 1, fraisReclamesEth: 34.75 } },
];

const PREFIXE_LONGUEUR = 10;   // « 0x » + 8 chiffres hex : ce que le brief donne
const norm = (a) => String(a || '').trim().toLowerCase();
const estAdresse = (a) => /^0x[0-9a-f]{40}$/.test(norm(a));

const PAR_ADRESSE = new Map(WALLETS.filter((w) => w.adresse).map((w) => [w.adresse, w]));
const PAR_PREFIXE = WALLETS.filter((w) => w.prefixe);

/** Le wallet du brief qui correspond a cette adresse, ou null. L'adresse
 *  entiere d'abord ; un prefixe (adresse partielle du brief) ensuite, et la
 *  reponse le dit (`partielle: true`). */
function roleDe(adr) {
  const a = norm(adr);
  if (!estAdresse(a)) return null;
  const w = PAR_ADRESSE.get(a);
  if (w) return w;
  const p = PAR_PREFIXE.find((x) => a.startsWith(x.prefixe));
  return p || null;
}

/** Les adresses ENTIERES : les seules qu'un filtre de journaux peut porter. */
function adressesCompletes() { return [...PAR_ADRESSE.keys()]; }

/** Les adresses entieres d'un role. */
function duRole(role) { return WALLETS.filter((w) => w.adresse && w.role === role).map((w) => w.adresse); }

module.exports = { SOURCE, ROLES, WALLETS, PREFIXE_LONGUEUR, roleDe, adressesCompletes, duRole, estAdresse };
