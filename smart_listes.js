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

/* ==================================================================
 * LE BRIEF V2 (15/10/2026, apres JUDGEBOT) — UNE TABLE, PAS UNE MESURE A NOUS
 * ==================================================================
 *
 * Le proprietaire a ecrit un second brief le 15/10/2026 au soir (texte :
 * smart_brief.js, BRIEF2) apres que le detecteur a rate $JUDGEBOT
 * (0xa922cdff…, encore sur la courbe Pons, absent de DexScreener). Ses
 * chiffres viennent de l'ETUDE DE SON AUTRE BOT (245 000 lancements Pons sur
 * 30 jours, 199 gagnants, 78 gradues en moins de 2 min, ×93…) : ce sont les
 * SIENS, pas les notres. Ce que la chaine en dit (sondes du 15/10, voir
 * EXPLOITATION.md, « Lancements Pons ») est ecrit a cote de chaque ligne,
 * sous « sonde ». La table v1 ci-dessus n'est PAS touchee : ses regles
 * (smart_signaux.js) restent celles du 1er brief.
 *
 * RECONCILIATION avec la table v1 (demandee) :
 *  - 0x9bf265c7…, 0x2a4d34cd…, 0x53e68553… : donnes en PREFIXE dans la
 *    section 4 (« un seul vote ») ET en entier dans la section 5 (« ne compte
 *    PAS »). Ils sont deja en entier dans la v1 (BOT_RAPIDE, neutres). Le
 *    brief se contredit ; l'exclusion l'emporte (fail closed) : ils ne
 *    comptent JAMAIS, le groupe n'a donc plus d'effet. Dit au rapport.
 *  - 0x7632bd8e… (Sniper 1) et 0x1ad70bc7… : deja dans la v1 (fort) ; la v2
 *    les met en copie, Sniper 1 avec sa condition (5-60 min, < 35 k$).
 *  - 0x2fd1887e…, 0x5b7e7cdf…, 0x7f7c73aa…, 0xcc00d470… : deja dans la v1
 *    (neutres) ; la v2 les exclut aussi : meme sens.
 *  - 0x7d17bfa7… (DEV_IGNITION de la v1) : c'est LUI qui envoie l'ETH de la
 *    chaine 4663 vers les wallets Solana de la section 3 (Relay, sonde du
 *    15/10 : 19 envois de 0,3 a 6,5 ETH vers B5Js… et 7Be6…).
 * ================================================================== */

const SOURCE_V2 = 'brief du proprietaire du 15/10/2026, v2 (apres JUDGEBOT), chiffres de l etude de son autre bot';

const BRIEF2 = {
  /* « etude de 245 000 lancements Pons sur 30 jours ; 78 des 199 gagnants ont
     gradue en moins de 2 minutes » ; « le dev achete >= 2 ETH : 11 %
     atteignent 300 k$, contre 0,12 % en moyenne (×93) ». Sonde du 15/10 :
     l'usine Pons V2 0x7ed598bc… a emis 1 664 TokenLaunched en 24 h (~50 000
     par 30 jours a ce rythme : le chiffre du brief compte peut-etre d'autres
     usines ou une autre periode — NON reconcilie) ; sur ses 200 derniers
     lancements, aucun tx.value >= 2 ETH (max 1,0005). */
  ETUDE: { lancements: 245000, jours: 30, gagnants: 199, gradueSous2min: 78, devAchat2Eth: { partPct: 11, moyennePct: 0.12, facteur: 93, seuilCapUsd: 300000 } },
  /* Les devs connus « comme bons ». Sonde du 15/10 (TokenLaunched de l'usine
     V2, topic 3 = deployer, toute l'histoire depuis le bloc 27 M) : chacun a
     lance au moins une fois ; seuls les deux CrawlScan dans les 10 M derniers
     blocs (~12 jours). Quatre sont des CONTRATS (eth_getCode), pas des
     wallets : ils lancent pour d'autres (deployer = le contrat). */
  DEVS: [
    { groupe: 'CrawlScan', adresses: ['0x58ea497c16422a344a50785f6f23ca92082e2e03', '0xd74321415c4ba41f07b6175739961b2b9865acd9'],
      source: SOURCE_V2 + ' : dev CrawlScan (740 k$), celui de JUDGEBOT ; lance souvent (7 jetons en 11 jours, 1 gros gagnant) : alerte, puis suis la courbe',
      sonde: '0x58ea… : 7 lancements dans les 10 M derniers blocs, dont JUDGEBOT (bloc 89 565 235) ; 0xd743… : 9 en tout, le dernier au bloc 82 798 178' },
    { groupe: 'UsePaid', adresses: ['0xf0870a6e99693d423d0f009132619dbc1f7bf29f', '0x7ade2841bc76ee79a7d2cc1347e179e9d7d995f5'],
      source: SOURCE_V2 + ' : devs UsePaid (2 gagnants chacun)', sonde: '4 lancements chacun, aucun dans les 10 M derniers blocs' },
    { groupe: 'Perps platform', adresses: ['0x013a529598bdbb6f46800db0965db11f699a03b8', '0xb91dd395b182f9fee3827b5bfb0e55e1793e1159', '0xb62bac455996ad1177706d35e098d01357915f43', '0xa295250c44c3e355a2a826705744e1c57806db09', '0xffebcf0eb51ff341a11a5792daff5bea7ed57f83', '0xd6ad6296875cff486e8c1aa1e13765f69c396550'],
      source: SOURCE_V2 + ' : equipe « Perps platform »', sonde: '1 lancement chacun (blocs 64,7 M a 74,7 M)' },
    { groupe: 'Cestus Network', adresses: ['0x7ce0f0330e3aa342404668428ef2c8d5caec7038', '0x10ad99ab6be60dae16f74286b6dc53b096c237b3'],
      source: SOURCE_V2 + ' : Cestus Network', sonde: '1 lancement chacun ; 0x7ce0… est un contrat' },
    { groupe: 'tank.cash / WIRE', adresses: ['0xfa2dc8b3a8da287567dc9b8a1b7249c97c96724a', '0x1479c01ad83537bc8418e4e6a37de71832549451', '0xe0451555b75487bac63e296583f7274045ff9be7'],
      source: SOURCE_V2 + ' : groupe tank.cash / WIRE', sonde: '11, 8 et 3 lancements ; 0x1479… est un contrat' },
    { groupe: 'FOMO-game', adresses: ['0x68fcdc113f86c84d268edaef0b11a83f66815d63', '0x6ec5d94b6fe3aa09bcdfa092261810f0a85c8fdc', '0x9aa72dc1b9701edb663efcc0944e94b96260e250', '0xa3350e4ff9b65c044c69151ab3ab4e55ba39a7c1'],
      source: SOURCE_V2 + ' : groupe FOMO-game', sonde: '1 lancement chacun ; 0x68fc… et 0x6ec5… sont des contrats' },
  ],
  /* « Plateformes qui graduent souvent : FOMOPAD et Nosh (deployer ou tx.to),
     avec >= 1 ETH du dev ». Sonde du 15/10 : deux contrats ; FOMOPAD deployer
     de 10 lancements dans les 10 M derniers blocs (le dernier au bloc
     82 305 333) ; Nosh d'aucun, et ni l'un ni l'autre n'est le tx.to des 200
     derniers lancements (95 passent par 0xe33e9e47…, 82 par l'usine). */
  PLATEFORMES: [
    { nom: 'FOMOPAD', adresse: '0x3f50f64ec6f233fc5cdfa2ed03b2d5de2a2b0722' },
    { nom: 'Nosh', adresse: '0x1a66d8ecc2274fc8887ab386e35d7da981ba2f37' },
  ],
  PLATEFORME_DEV_MIN_ETH: 1,
  /* « relais de l'usine a graduation (bundles : vendre vite) ». Sonde du
     15/10 : trois wallets (pas de code), nonce 2 065 a 2 079 chacun, aucun
     lancement Pons comme deployer, aucun Buy ni Sell de courbe (expediteur ou
     destinataire) sur les 30 000 derniers blocs : leur role exact n'est PAS
     verifie (l'ETH natif qu'ils envoient ne laisse aucun journal). */
  RELAIS: ['0x8234222a80abebc5df729cf00ba7db0960a8724e', '0xe3c5329e82c166426df72ffcc022a0f437474eeb', '0x619af567afd627f560a55d03cb722e0ed86a3a84'],
  /* Section 4 : copie avec <= 5 min de retard. */
  COPIE: [
    { adresse: '0x7632bd8e72767ed67a724c564c42ceea98e81180', nom: 'Sniper 1', condition: { ageMin: 5, ageMax: 60, capMaxUsd: 35000 } },
    { adresse: '0x1ad70bc7ac98539dada8f97360d353687f6c29d6', nom: 'Copie 0x1ad70bc7' },
    { adresse: '0xc08a47f5111ae27100fb18106e929537ea97f838', nom: 'Copie 0xc08a47f5' },
    { adresse: '0x0d3f171bfbdb3f5acb1d2b5c8088c83365382b51', nom: 'Copie 0x0d3f171b' },
    { adresse: '0x8fe61d0163413d9d256aaf30b65886f9020b1181', nom: 'Copie 0x8fe61d01' },
    { adresse: '0xf19c46c5014bcba4d0cc602f6f771b50422aa71c', nom: 'Copie 0xf19c46c5' },
    { adresse: '0x3add78a28de6f0077d750e18ee6a4ceeb2db3366', nom: 'Copie 0x3add78a2' },
    { adresse: '0x48d8a72f4e1471ab737baae71d5f4fd51f0556f7', nom: 'Copie 0x48d8a72f' },
    { adresse: '0x72ff82dbf9ffa5fbbcd27ee327e01989a1fafcf2', nom: 'Copie 0x72ff82db' },
    { adresse: '0xbdbe8fba5fd93defc6832160a8d1cbffb472dcb4', nom: 'Copie 0xbdbe8fba' },
    /* membre du 1er groupe, absent de la liste de copie elle-meme : il vote
       pour le groupe */
    { adresse: '0x20916bbae39a992a2204e1c084ca48ecf7429e1a', nom: 'Groupe 0x3add/0xc08a/0x2091' },
  ],
  /* « Groupes a compter pour UNE seule voix ». Le 2e groupe (prefixes du
     brief) est entierement exclu par la section 5 : voir la reconciliation. */
  GROUPES: [
    ['0x3add78a28de6f0077d750e18ee6a4ceeb2db3366', '0xc08a47f5111ae27100fb18106e929537ea97f838', '0x20916bbae39a992a2204e1c084ca48ecf7429e1a'],
    ['0x9bf265c742d96aacf1083ef24c9110240af0bea9', '0x2a4d34cd09a36f59ae3bedc0880cd5da929321d7', '0x53e68553ca08f512423628d64c01b0a14dfcda99'],
  ],
  GROUPES_PREFIXES_BRIEF: [['0x9bf265c7', '0x2a4d34cd', '0x53e68553']],
  /* Regle du proprietaire du 16/10 (son autre bot) : « meme createur que BAGGR
     = lanceur en serie sans traction, ne pas suivre ». Sonde du 16/10 :
     0x64327b3d… est un CONTRAT (nonce 12) ; il figure dans 2 journaux de la
     fabrique Runitup 0xa37e… sur ~9,5 M blocs (BAGGR inclus). Ses lancements
     ne declenchent aucune alerte (ni lancement, ni copie sur sa courbe) ; ils
     sont COMPTES (bilan.ignores) pour rester jugeables. */
  LANCEURS_SERIE: [
    { adresse: '0x64327b3d69740cca74f19d9ed78dc5f4094dcb0c', nom: 'BAGGR creator', source: 'regle du proprietaire du 16/10 : lanceur en serie sans traction, ne pas suivre' },
  ],
  /* Section 5 : ne compte PAS (bots rapides, snipers de la 1re minute, equipes). */
  EXCLUS: ['0x2fd1887e5d99014cb0b8884f06560ed20d65003d', '0x9bf265c742d96aacf1083ef24c9110240af0bea9', '0x2a4d34cd09a36f59ae3bedc0880cd5da929321d7',
    '0x53e68553ca08f512423628d64c01b0a14dfcda99', '0x5b7e7cdf20193286bc9109f92ba7d12819968225', '0x7f7c73aad4d210ec65bccb341df090cd63d49aaa',
    '0xcc00d47039dc20754eaeb3a21f7891226d52534c', '0x9c4d5bd19f9acfe75610860b17cf7471b7ce462a', '0x5a0e4930e3fb009eee11071046797645dd823b7a',
    '0x305aabee679fd43a46705602aa4d9e9a9d07ddd1', '0x00765658b85d67d9b8d4c39542812df565d85619', '0x3b56d9905983723a870e6af9c251241d37079daa',
    '0x7503caf13eccf20622e4ba905c09de174b4a1932', '0xe15e17ead2853dfbce8d32b90f2a1d2833d791b1', '0xf7142c2b1e52308c354564a3f3a5cc420947a266',
    '0xfaa367d59783d50ffd3a67dcabce8bc79959b735', '0x4992e7add8c4686160bbfdc72e9526789ee15305', '0xb9577f4543392519f7dd9f94a77b60946e09457b',
    '0xcf51f21eb2d8a501f9f4bb3f2642ab2d469d4d48', '0x4535823bf758f7cd037d7b7c328740cda23ef5cd'],
  /* Section 3 : IGNITION. Sonde du 15/10 : 0x02d67001… est un wallet (nonce
     91) ; ses contrats aux nonces 3, 9, 18, 46 et 47 SONT les cinq usines du
     brief (getContractAddress) ; aucun de ses 19 contrats n'a de symbol().
     Les trois premieres emettent TokenLaunched (3, 11 et 14 lancements, le
     dernier au bloc 89 065 765) ; la « V4 » (nonce 46) et la « V5 » (nonce 47)
     n'ont emis AUCUN journal (nonce 1 chacune). Leur date de deploiement ne se
     lit pas : le noeud public n'a pas l'etat historique.
     CONTREDIT : 0x573397b0… (« probable V5 ») N'EST PAS une usine. Analyse du
     bytecode (rapport du coordinateur, 15/10) puis sonde : ses selecteurs sont
     ceux d'un CROCHET Uniswap v4 de jeton (afterSwap, poolKey, treasury,
     weatherOracle, fomoWallet — tous a zero : pas encore configure), aucun de
     ceux des usines (launchesCount, graduationEthTarget, launchFeeWei absents),
     aucun TokenLaunched. Il est garde ici comme deploye par le wallet, mais
     n'est PAS lu comme une usine (`usines` ci-dessous). */
  IGNITION: {
    wallet: '0x02d6700179e52bc5b5c20198cc8e0ec969dd6f03',
    usines: ['0xb69d60752612d04cbef3e441142cfee79b9315fb', '0xfbd722409c14eb14f43a7fcc480da2bb3d00b63f', '0x8a2a38b19ec21b355eef45ab47cb58d0520bbada',
      '0x7d58b37e845fe59aef82ecb30583a4c0376ba213'],
    crochetNonUsine: '0x573397b04250a092515ef1362b24f4c3ab8dc00b',
    /* « finance chaque wallet de lancement via Relay depuis ces wallets
       Solana (2 a 55 min avant le lancement) ». Sonde du 15/10 : 2 des 6
       (B5Js…, 7Be6…) ont envoye vers 4663 dans leurs 20 dernieres demandes
       (11 destinataires) ; 3 de ces 11 ont lance sur Pons (blocs 84,3 a
       84,6 M), tous par 0xe33e9e47… ; l'un porte une image
       launchcri-assets.netlify.app. Bqyr… n'a rien fait depuis mars. */
    solana: ['B5JszNrk5NZWsvbfXfeGRJkCmWjhrwjDX75nsW1dKSze', '7Be6hvoGSJrvemHjuvCebcA7gz24msNsVeeorz9vwKdg', 'Bqyr8SjoZKeAZovA5B5K5asfCcw4yTe9DZUy8opmd4VB',
      'Dx7W4z12eyUw42Sk8koFL2Q1HDfZz85qsnK4imLjwVqT', '2j2Uz7QRhGieu24cqvaDfEUoNYZyck86CfaoZoa1sZ9o', '5zZcVguDZ6qHwSQuwh7bcM4YjhBY6bibzFJwQBKUG2vb'],
    imagesHote: 'launchcri-assets.netlify.app',
    /* « les copieurs ont maxFee = 0,2 gwei et un gaz < 5,8 M ». Sonde : les
       trois lancements des wallets finances par Relay portaient maxFee
       0,0287 a 0,029 gwei et gaz 5 818 661 a 8 186 306 ; JUDGEBOT 0,0312 gwei
       et 5 816 003. */
    copieurs: { maxFeeWei: 200000000, gazMax: 5800000 },
  },
};

const COPIE_PAR = new Map(BRIEF2.COPIE.map((w) => [w.adresse, w]));
const EXCLUS_V2 = new Set(BRIEF2.EXCLUS);
const SERIE_PAR = new Map(BRIEF2.LANCEURS_SERIE.map((w) => [w.adresse, w]));
/** Un lanceur en serie a ne pas suivre (regle du proprietaire du 16/10), ou null. */
function lanceurSerie(a) { return a ? SERIE_PAR.get(String(a).toLowerCase()) || null : null; }
const DEV_PAR = new Map(); for (const g of BRIEF2.DEVS) for (const a of g.adresses) DEV_PAR.set(a, g);
const GROUPE_PAR = new Map(); BRIEF2.GROUPES.forEach((g, i) => { for (const a of g) GROUPE_PAR.set(a, 'groupe' + (i + 1)); });

/** Le role v2 d'une adresse : 'exclu' (section 5, l'emporte toujours),
 *  'copie' (section 4), ou null. */
function roleV2(adr) {
  const a = norm(adr);
  if (!estAdresse(a)) return null;
  if (EXCLUS_V2.has(a)) return { role: 'exclu' };
  const w = COPIE_PAR.get(a);
  return w ? Object.assign({ role: 'copie', voix: GROUPE_PAR.get(a) || a }, w) : null;
}
/** Le dev connu (section 2) de cette adresse, ou null. */
function devConnu(adr) { return DEV_PAR.get(norm(adr)) || null; }
/** Les adresses ENTIERES que la veille filtre : la v1 et la copie v2 (les
 *  exclus v2 n'ont pas besoin d'etre lus : ils ne comptent pas). */
function adressesVeille() { return [...new Set(adressesCompletes().concat(BRIEF2.COPIE.map((w) => w.adresse)))]; }

module.exports = { SOURCE, ROLES, WALLETS, PREFIXE_LONGUEUR, roleDe, adressesCompletes, duRole, estAdresse,
  SOURCE_V2, BRIEF2, roleV2, devConnu, adressesVeille, lanceurSerie };
