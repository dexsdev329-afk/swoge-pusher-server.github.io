'use strict';
/* ==================================================================
 * SMART MONEY ROBINHOOD CHAIN — LES CALCULS (13/10/2026)
 * ==================================================================
 *
 * Fonctions PURES : aucune entree/sortie, aucune horloge, aucun reseau. Tout
 * ce qui est lu sur la chaine arrive deja lu (journaux bruts du noeud, recus,
 * soldes balanceOf) ; tout ce qui sort est un objet ou un texte. Les montants
 * restent des BigInt (wei, unites brutes du jeton) jusqu'a l'affichage : un
 * Number perd l'unite au-dela de 2^53 (9 007 ETH en wei... deja depasse par un
 * seul achat de 0,01 ETH ecrit en wei).
 *
 * ---- CE QUE LES MOTS VEULENT DIRE ICI ----
 *  lancement      le bloc ou la piscine ETH du jeton est nee (Initialize v4,
 *                 PoolCreated v3, PairCreated v2, ou 1er journal de la paire)
 *  acheteur       le BENEFICIAIRE d'un achat, jamais le signataire : l'adresse
 *                 qui recoit le jeton dans la transaction (regle de
 *                 communaute.js, sonde du 11/10 : 59 echanges sur 120 signes
 *                 par un autre que l'acheteur)
 *  entre / sorti  ETH PAYE / RECU PAR LE WALLET : le montant du Swap, plus les
 *                 frais lus dans le recu (revue C1 du 13/10) — le crochet
 *                 0x332f… (BRODIE, NILF, HM, PEPONS, TROLL) et 0xe5e702…
 *                 (NOVAAI) retiennent 1 % de l'ETH de CHAQUE vente (226 ventes
 *                 sur 226 de PEPONS, 68 sur 68 de NOVAAI ; evenement 0xc532c43b,
 *                 hors du Swap) ; le routeur 0x65050a… prend 1 % a l'achat et
 *                 ~0,99 % a la vente (16 achats sur 16, 25 ventes sur 25 des
 *                 recus en cache ; evenement 0x205442d6). Recu NILF lu
 *                 (tx 0x13fb9218…) : ETH remis au wallet = Swap - crochet -
 *                 routeur, au wei pres
 *  solde          balanceOf lu sur la chaine (jamais recompose depuis les
 *                 Transfer : relecture du rapport, 13/10)
 *  gain           sorti - entre + solde x prix (prix du dernier Swap lu)
 *  tot            entre dans la 1re heure apres le lancement
 *  initie         au moins une des 4 marques ci-dessous : jamais « smart »
 *  smart          regle du proprietaire : tot ET gagnant sur >= 3 jetons de
 *                 plus de 1 M$, sans marque d'initie
 *
 * ---- LES SIGNES DES SWAP : LUS, PAS SUPPOSES (13/10/2026) ----
 * v4 (PoolManager) : amount0/amount1 = variation du COTE DE L'UTILISATEUR.
 *   Mesure sur les vies entieres de NILF (8 999 Swap) et BRODIE (10 636) en
 *   cache : 4 221 + 5 050 achats (le jeton sort du PoolManager) ont amount0
 *   (ETH) < 0 et amount1 > 0 ; 4 575 + 4 941 ventes ont amount0 > 0 et
 *   amount1 < 0 ; 0 vente a l'envers. Les 14 + 43 « achats a l'envers » sont
 *   des ventes ou le net du PoolManager trompe (voir BENEFICIAIRE) : le sens
 *   se lit donc dans le Swap, jamais dans le net du PoolManager.
 * v3 (piscine) : amount0/amount1 = variation du COTE DE LA PISCINE. Lu dans 2
 *   recus (13/10, piscines 0x9b35… et USDG/WETH 0x52e6…) : amount0 < 0 quand
 *   le WETH SORT de la piscine. Signe oppose au v4.
 * v2 (paire) : amount0In/amount1In/amount0Out/amount1Out, sans signe.
 * ================================================================== */

const TOPIC = {
  /* les 7 premiers : relus sur la chaine par la sonde du 13/10 (mesures_noeud.json,
     topics_verifies) ET recalcules par keccak256 de la signature : identiques */
  TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  SWAP_V4: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  SWAP_V3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  INIT_V4: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  POOL_V3: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  PAIR_V2: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  /* emis par la fabrique de migrateurs 0xc1dd8507… : 12 journaux relus le 13/10
     (verif_rapport, v13_migr), topics = [sig, migrateur, ancien, nouveau] ; le
     NOM vient d'openchain et n'est pas verifie, le hash l'est */
  MIGRATOR_CREATED: '0x07698135ed348cab23c84a90beee89f501f92cf0186e7ba75e587bd2b8dd0bf5',
  /* les FRAIS (revue C1, 13/10) : lus dans 4 recus (NILF 0x13fb9218…, TROLL
     0x34f0ecec…, BRODIE 0x5c10fd7f…, HM 0xaf63ff14…) et ceux du cache.
     Crochet : topics = [sig, poolId], mots = [devise (0 = ETH natif), montant, 0].
     Routeur 0x65050a… : topics = [sig, devise (0 = ETH), wallet], mot 0 = montant.
     Noms non verifies ; les hash et les montants le sont (ETH remis au wallet =
     Swap - crochet - routeur, au wei pres, NILF tx 0x13fb9218…). */
  FRAIS_CROCHET: '0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d',
  FRAIS_ROUTEUR: '0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92',
};

const ADR = {
  POOL_MANAGER_V4: '0x8366a39cc670b4001a1121b8f6a443a643e40951',   // sonde du 13/10 : 46 593 Swap v4 sur 30 000 blocs
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',              // docs.robinhood.com/chain/contracts (13/10)
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  ETH_NATIF: '0x0000000000000000000000000000000000000000',         // devise des piscines v4
  ETH_GT: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',            // marqueur GeckoTerminal des piscines pons-v2
  MORT: '0x000000000000000000000000000000000000dead',
  FABRIQUE_MIGRATIONS: '0xc1dd8507cf9239f1891cb3939b908a966ecca20b',
  ROUTEUR_FRAIS: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',     // le seul routeur dont l'evenement de frais est lu (revue C1)
};
/* Les routeurs dont on lit l'evenement de frais : une autre adresse qui emettrait
   la meme signature n'est pas crue. */
const ROUTEURS_FRAIS = new Set([ADR.ROUTEUR_FRAIS]);
/* L'ETH « qui compte » d'un cote de piscine : natif (v4) ou WETH (v2/v3). */
const COTES_ETH = new Set([ADR.ETH_NATIF, ADR.WETH, ADR.ETH_GT]);
const BRULES = new Set([ADR.ETH_NATIF, ADR.MORT]);

/* ---- LES SEUILS, CHACUN AVEC LA MESURE QUI L'A FIXE ----
 * Calibrage hors ligne du 13/10/2026 (smart_build/calibre/calibre_premiers.js,
 * 0 appel au noeud) sur les vies entieres de NILF et BRODIE gardees en cache par
 * la sonde du noeud (lancement -> bloc 83 886 079), avec CE code. 1re heure =
 * 35 580 blocs (0,10118 s/bloc de 47,1 M a 57,1 M, sonde). Detail et chiffres
 * dans EXPLOITATION.md, section « Smart money ».
 *   NILF   : 7 459 echanges avec beneficiaire sur 8 974 tx de Swap (83,1 %) ;
 *            1re heure : 108 acheteurs distincts, 90 a >= 0,01 ETH ;
 *   BRODIE : 8 473 sur 10 610 (79,9 %) ; 1re heure : 54 acheteurs, 42 a >= 0,01. */
const N_ACHETEURS = 50;               // demande du proprietaire : « les 50 premiers acheteurs distincts »
/* 0,01 ETH : CHOISI (poussiere : un aller-retour y coute plus en gaz qu'il ne
   pese). Ce qu'il ecarte, mesure : 18 acheteurs de la 1re heure de NILF sur 108,
   12 de BRODIE sur 54 (aucun de leurs achats n'atteint 0,01). */
const MISE_MIN_WEI = 10n ** 16n;
const TOT_S = 3600;                   // « entre dans la 1re heure » (demande du proprietaire)
const ROBOTS_S = 60;                  // « robots dans la 1re minute » (demande du proprietaire)
const PROFIL_PAYE_S = 3 * 3600;       // « profil DexScreener paye dans les 3 h » (demande du proprietaire)
const SMART_JETONS = 3;               // « gagnant sur au moins 3 jetons » (demande du proprietaire)
/* Aucun verdict sous 10 ISSUES CONNUES (PORTEFEUILLE_ASSEZ de portefeuilles.js).
   Revue C3 du 13/10 : compte en projets, 10 projets dont 2 issues connues
   rendaient « beats the base rate » (z +6,16) ; le contrôle avait 9 issues
   inconnues sur 50 entrants tôt pour PEPONS, 5 sur 42 pour BRODIE. */
const PROJETS_ASSEZ = 10;
const Z_VERDICT = 2;                  // ~95 % : Z_VERDICT de portefeuilles.js
/* ACHATS GROUPES (demande : « achats dans le meme bloc avec des montants presque
   identiques ») : >= 3 wallets, meme bloc, mises a +/- 2 %.
   Mesure du 13/10 (base de controle, 7 jetons lus, marques parmi les 50
   premiers a 1 / 2 / 5 %) : HM 9 / 12 / 21 ; astro 6 / 15 / 17 ; PEPONS
   5 / 5 / 8 ; NILF 17 / 17 / 17. L'ecart CHANGE donc le compte sur HM, astro
   et PEPONS (le premier calibrage, NILF et BRODIE seuls, disait le contraire).
   Le hasard seul en pose aussi : mises melangees entre wallets (500 tirages,
   graine fixe), 4,9 marques attendues sur 6 jetons contre 54 reelles, dont
   2,55 sur HM (au moins une dans 367 tirages sur 500). D'ou : +/- 2 % garde
   (pas d'audit pour le changer), un bloc charge (plus de 5 acheteurs) est
   montre « same-block pattern » avec son bloc, et la marque de CO-ENTREE
   (ci-dessous) rattrape les ensembles que l'ecart rate. Limite dite : des mises
   rondes x 0,99 par un meme routeur ressemblent aussi a un robot de copie. */
const GROUPE_MIN = 3;
const GROUPE_ECART = 0.02;
const BLOC_CHARGE = 5;                // au-dela de 5 acheteurs dans le bloc : « same-block pattern » (revue INI-03, 2,55 marques de hasard sur HM)
/* CO-ENTREE (revue INI-01, 13/10) : >= 3 wallets qui font leur 1er achat dans un
   MEME bloc sur >= 2 jetons lus, quelles que soient les mises. Mesure sur les 7
   jetons du controle : une seule composante, 5 wallets EOA (0xb0b7…, 0xf9d3…,
   0x7625…, 0x873a…, 0xa580…) entres ensemble dans 4 blocs sur 3 jetons (HM
   49 405 103, HM 49 405 562, PEPONS 66 204 136, TROLL 74 578 365), nonces au meme
   pas ; aucune autre (4 liaisons trouvees, toutes des paires). Sans elle, 4 des 5
   sortaient « smart » des que TROLL avait des mises ecartees comme HM et PEPONS. */
const COENTREE_MIN = 3;
const COENTREE_JETONS = 2;
/* PAIRES REPETEES (revue INI-04, 13/10) : 2 wallets, meme bloc, mises a +/- 2 %,
   dans >= 2 blocs (meme jeton ou deux jetons). Une paire unique peut etre le
   hasard ; une paire qui revient avec la meme mise ne l'est pas. Mesure : 9
   wallets sur les 300 premiers des 6 jetons (NILF 6, HM 2, TROLL 1), tous
   gagnants ; ex. 0x6db1… + 0xe5ee… a 0,099 ETH sur NILF (blocs 49 880 590 et
   49 880 769) puis sur HM (3 blocs). */
const PAIRE_BLOCS = 2;
/* RELAIS : >= 99 % des jetons achetes renvoyes a une autre adresse (hors vente)
   dans les 6 000 blocs. REMESURE le 13/10 (revue INI-11, 300 premiers des 6
   jetons du controle) : 1 relais (PEPONS #2, 0x9984…, tout renvoye 1 773 blocs
   apres) ; AUCUN wallet entre 50 % et 99 % dans les 6 000 blocs ; 6 wallets a
   >= 99 % mais apres 49 941 blocs a 22 M : les deux seuils ne sont pas contestes.
   Le « neuf » de la demande (« wallets neufs qui ne servent qu'a faire suivre »)
   n'est PAS une condition : un seul cas (nonce 10 dans sa tx d'achat, vers un
   wallet qui revend pendant des semaines) ne fixe aucun seuil. Le nonce de la
   tx d'achat est lu et MONTRE avec la marque, pour le rendre jugeable. Un envoi
   vers son propre autre wallet ressemble aussi a un relais (dit sur la page). */
const RELAIS_PART = 0.99;
const RELAIS_BLOCS = 6000;
/* RENVOI AU CREATEUR : 0 cas sur les 300 premiers de 7 jetons (13/10, revue
   INI-12) : non jugeable, gardee. Les seuls transferts vers ces adresses sont des
   frappes de migration et les retraits LP d'astro vers 0xb760. Une tx ou le
   wallet est beneficiaire d'un echange n'est jamais un renvoi. */
const COUT_CONNU_PART = 0.99;         // >= 99 % du sac recu par des achats, et <= 1 % envoye hors marche (revue C2) : seuil de communaute.js (COUT, sonde du 12/10)
/* « robots dans la 1re minute » : >= 3 acheteurs distincts dans la 1re minute,
   de n'importe quel montant. Mesure du 13/10 (revue INI-13) : 4 jetons sur 7
   (NILF 5, PEPONS 4, TROLL 18, astro 9 — au mauvais lancement) ; BRODIE 1,
   HM 2, CPU 0. Ce sont des ACHETEURS lus ; « robots » est une deduction (Not
   verified). Seul, cet ingredient ne cree pas de lien « meme recette ». */
const ROBOTS_MIN = 3;
const ALERTE_SMART_MIN = 2;           // « 2 wallets smart ou plus » (demande du proprietaire)
const ALERTE_FENETRE_S = 3600;        // « dans la meme heure » (demande du proprietaire)
const SEUIL_CAP_USD = 1e6;            // « plus de 1 M$ de capitalisation » (demande du proprietaire)
/* Liens « memes premiers acheteurs » : >= 5 des 50 premiers en commun. Mesure du
   13/10 (revue INI-14, 7 jetons, 21 paires de jetons) : BRODIE-NILF 2,
   BRODIE-HM 1, 16 paires a 0 ; les 3 qui depassent (HM-PEPONS 6, HM-TROLL 6,
   PEPONS-TROLL 7) sont portees par le groupe de 5 de la co-entree, plus 0x018f…
   (et 0xabe0… entre PEPONS et TROLL). 5 tombe dans le vide entre 2 et 6. */
const PREMIERS_COMMUNS_MIN = 5;
/* TAUX DE BASE (revue C6) : calcule SANS le wallet juge et SANS les wallets
   marques, et pas de z pour un jeton sous BASE_ASSEZ issues connues. 20 est
   CHOISI contre la mesure : base de controle relue le 14/10 (frais lus), issues
   connues hors marques parmi les entrants de la 1re heure : astro 35, TROLL 36,
   BRODIE 30, HM 30, PEPONS 29, NILF 27 — tous au-dessus ; NOVAAI 5 (passe
   reelle, lue a 24 h) — ecarte. A 20 issues, l'erreur type d'un taux de 50 %
   vaut 11 points ; a 5, 22. */
const BASE_ASSEZ = 20;
/* LANCEUR AUTOMATIQUE (revue INI-07) : >= 8 lancements en 24 h. Mesure du 13/10
   (veille reelle, 3 h 38, 630 jetons par 337 wallets) : 317 en lancent 1, 3 en
   lancent 2, 4 en lancent 3, 2 en lancent 5 ; puis 8, 9, 9 (trois wallets en
   rotation stricte sur l'usine 0xc739…), 15, 30 et six a 36-38. Le seuil tombe
   dans le vide entre 5 et 8. Au-dela : pas d'alerte jeton par jeton (un resume
   dans le rapport), et « automated launcher » plutot que « creator ». */
const LANCEUR_AUTO = 8;

// ------------------------------------------------------------ petits outils

const MOT = 64;
const adrDe = (topic) => ('0x' + String(topic).slice(-40)).toLowerCase();
const pad32 = (a) => '0x' + String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const estAdresse = (a) => /^0x[0-9a-f]{40}$/.test(String(a || ''));
const estPool4 = (a) => /^0x[0-9a-f]{64}$/.test(String(a || ''));
function mots(data) { const d = String(data || '0x').slice(2); const o = []; for (let k = 0; k + MOT <= d.length; k += MOT) o.push(d.slice(k, k + MOT)); return o; }
const u256 = (w) => BigInt('0x' + w);
const s256 = (w) => { const v = BigInt('0x' + w); return v >= 2n ** 255n ? v - 2n ** 256n : v; };
const abs = (x) => (x < 0n ? -x : x);
const num = (h) => (typeof h === 'number' ? h : parseInt(h, 16));

// ------------------------------------------------------------ decodage

/** Un journal brut du noeud -> un evenement normalise, ou null. Les Swap
 *  rendent u0/u1 = variation COTE UTILISATEUR (negatif = paye), quelle que
 *  soit la version (voir LES SIGNES DES SWAP). */
function decode(log) {
  if (!log || !Array.isArray(log.topics) || !log.topics.length) return null;
  const t0 = String(log.topics[0]).toLowerCase();
  const base = { bloc: num(log.blockNumber), tx: String(log.transactionHash).toLowerCase(), i: num(log.logIndex), adresse: String(log.address).toLowerCase() };
  const w = mots(log.data);
  if (t0 === TOPIC.TRANSFER) {
    /* ERC-20 : 3 topics et 1 mot ; un ERC-721 a 4 topics, ce n'est pas un jeton fongible */
    if (log.topics.length !== 3 || w.length < 1) return null;
    return Object.assign(base, { genre: 'transfer', jeton: base.adresse, de: adrDe(log.topics[1]), vers: adrDe(log.topics[2]), valeur: u256(w[0]) });
  }
  if (t0 === TOPIC.SWAP_V4) {
    if (log.topics.length < 3 || w.length < 3) return null;
    return Object.assign(base, { genre: 'swap', version: 4, pool: String(log.topics[1]).toLowerCase(), expediteur: adrDe(log.topics[2]),
      u0: s256(w[0]), u1: s256(w[1]), sqrtP: u256(w[2]) });
  }
  if (t0 === TOPIC.SWAP_V3) {
    if (log.topics.length < 3 || w.length < 3) return null;
    return Object.assign(base, { genre: 'swap', version: 3, pool: base.adresse, expediteur: adrDe(log.topics[1]), destinataire: adrDe(log.topics[2]),
      u0: -s256(w[0]), u1: -s256(w[1]), sqrtP: u256(w[2]) });
  }
  if (t0 === TOPIC.SWAP_V2) {
    if (log.topics.length < 3 || w.length < 4) return null;
    const [in0, in1, out0, out1] = w.slice(0, 4).map(u256);
    return Object.assign(base, { genre: 'swap', version: 2, pool: base.adresse, expediteur: adrDe(log.topics[1]), destinataire: adrDe(log.topics[2]),
      u0: out0 - in0, u1: out1 - in1, sqrtP: null });
  }
  if (t0 === TOPIC.INIT_V4) {
    if (log.topics.length < 4 || w.length < 5) return null;
    return Object.assign(base, { genre: 'init', version: 4, pool: String(log.topics[1]).toLowerCase(), c0: adrDe(log.topics[2]), c1: adrDe(log.topics[3]),
      fee: Number(u256(w[0])), hook: adrDe(w[2]), sqrtP: u256(w[3]) });
  }
  if (t0 === TOPIC.POOL_V3) {
    if (log.topics.length < 4 || w.length < 2) return null;
    return Object.assign(base, { genre: 'init', version: 3, pool: adrDe(w[1]), c0: adrDe(log.topics[1]), c1: adrDe(log.topics[2]), fee: Number(u256(String(log.topics[3]).slice(2))), hook: null });
  }
  if (t0 === TOPIC.PAIR_V2) {
    if (log.topics.length < 3 || w.length < 1) return null;
    return Object.assign(base, { genre: 'init', version: 2, pool: adrDe(w[0]), c0: adrDe(log.topics[1]), c1: adrDe(log.topics[2]), fee: null, hook: null });
  }
  if (t0 === TOPIC.FRAIS_CROCHET) {
    if (log.topics.length < 2 || w.length < 2) return null;
    return Object.assign(base, { genre: 'frais_crochet', crochet: base.adresse, pool: String(log.topics[1]).toLowerCase(), devise: adrDe(w[0]), montant: u256(w[1]) });
  }
  if (t0 === TOPIC.FRAIS_ROUTEUR) {
    if (log.topics.length < 3 || w.length < 1 || !ROUTEURS_FRAIS.has(base.adresse)) return null;
    return Object.assign(base, { genre: 'frais_routeur', routeur: base.adresse, devise: adrDe(log.topics[1]), qui: adrDe(log.topics[2]), montant: u256(w[0]) });
  }
  if (t0 === TOPIC.MIGRATOR_CREATED) {
    if (log.topics.length < 4) return null;
    return Object.assign(base, { genre: 'migration', migrateur: adrDe(log.topics[1]), ancien: adrDe(log.topics[2]), nouveau: adrDe(log.topics[3]) });
  }
  return null;
}

/** La piscine d'un jeton contre l'ETH (natif ou WETH) a partir de son evenement
 *  de naissance ; null si aucun des deux cotes n'est de l'ETH. */
function piscineEth(init, jeton) {
  if (!init || init.genre !== 'init') return null;
  const j = String(jeton).toLowerCase();
  if (init.c0 === j && COTES_ETH.has(init.c1)) return { pool: init.pool, version: init.version, ethEst0: false, hook: init.hook || null, bloc: init.bloc, tx: init.tx };
  if (init.c1 === j && COTES_ETH.has(init.c0)) return { pool: init.pool, version: init.version, ethEst0: true, hook: init.hook || null, bloc: init.bloc, tx: init.tx };
  return null;
}

/** La jambe d'un Swap pour une piscine ETH : { sens, eth, jetons } (positifs),
 *  vue de l'utilisateur ; null si les deux montants ont le meme signe. */
function jambe(swap, piscine) {
  const eth = piscine.ethEst0 ? swap.u0 : swap.u1;
  const jet = piscine.ethEst0 ? swap.u1 : swap.u0;
  if (eth < 0n && jet > 0n) return { sens: 'achat', eth: -eth, jetons: jet };
  if (eth > 0n && jet < 0n) return { sens: 'vente', eth, jetons: -jet };
  return null;
}

/** Le prix en wei d'ETH par unite brute du jeton, en fraction exacte
 *  { num, den } : sqrtPriceX96 donne token1/token0 = sqrtP^2 / 2^192. */
function prixDepuisSqrt(sqrtP, ethEst0) {
  if (!sqrtP || sqrtP <= 0n) return null;
  const carre = sqrtP * sqrtP, Q = 2n ** 192n;
  return ethEst0 ? { num: Q, den: carre } : { num: carre, den: Q };
}
/** v2 : prix spot depuis les reserves. */
function prixDepuisReserves(reserveEth, reserveJeton) {
  if (!(reserveJeton > 0n) || !(reserveEth >= 0n)) return null;
  return { num: reserveEth, den: reserveJeton };
}
const valeur = (jetons, prix) => (prix && prix.den > 0n ? (jetons * prix.num) / prix.den : null);

// ------------------------------------------------------------ les echanges

/**
 * Les echanges d'un jeton, un par transaction, chacun avec son BENEFICIAIRE.
 *   jeton      adresse
 *   piscines   [{ pool, version, ethEst0, hook }] (piscines ETH du jeton)
 *   evts       evenements decodes (Transfer du jeton + Swap des piscines),
 *              TOUS ceux des transactions concernees (recus complets ou
 *              lecture de la vie entiere)
 *   infra      adresses jamais beneficiaires (PoolManager, piscines, crochets…)
 *   txLues     Set des tx dont le RECU entier a ete lu (frais connus) ; absent =
 *              toutes (lecture par les recus)
 * Rend [{ tx, bloc, i, sens, qui, eth, ethSwap, frais, fraisLus, jetons, net }]
 * trie par (bloc, i). `eth` = ce que le WALLET paie (achat) ou recoit (vente).
 *
 * BENEFICIAIRE : le net de chaque adresse (hors infra) en jeton dans la tx ;
 * pour un achat, le plus grand net positif, a condition qu'il porte au moins la
 * MOITIE des jetons sortis du Swap (communaute.js, sonde du 11/10 ; ici le flux
 * se lit dans le Swap, pas dans le net du PoolManager : le crochet 0x332f…
 * prend 1 % des jetons ACHETES en jeton — et 1 % de l'ETH de chaque VENTE, en
 * ETH, voir FRAIS — et 700 achats de BRODIE sur 5 093 ne laissent sortir QUE
 * ce 1 % du PoolManager — routes multi-sauts ou les jetons restent dans le
 * PoolManager : sans beneficiaire, ils ne comptent pas).
 * FRAIS (revue C1) : sur une vente, la retenue du crochet en ETH (devise 0) et
 * les frais du routeur en ETH sont RETRANCHES du Swap ; sur un achat, les frais
 * du routeur en ETH sont AJOUTES. Une retenue du crochet en ETH sur un achat n'a
 * jamais ete vue (0 sur les recus lus) : elle n'est pas comptee.
 */
function echanges({ jeton, piscines, evts, infra, txLues }) {
  const j = String(jeton).toLowerCase();
  const P = new Map(piscines.map((p) => [String(p.pool).toLowerCase(), p]));
  const exclus = new Set([ADR.POOL_MANAGER_V4, ...BRULES, ...[...P.keys()].filter(estAdresse), ...piscines.map((p) => p.hook).filter(Boolean), ...(infra || [])].map((a) => String(a).toLowerCase()));
  const parTx = new Map();
  for (const e of evts) {
    if (!e) continue;
    if (e.genre === 'transfer' && e.jeton !== j) continue;
    if (e.genre === 'swap' && !P.has(e.pool)) continue;
    if (e.genre === 'frais_crochet' && !(P.has(e.pool) && P.get(e.pool).hook === e.crochet)) continue;
    if (e.genre !== 'transfer' && e.genre !== 'swap' && e.genre !== 'frais_crochet' && e.genre !== 'frais_routeur') continue;
    let g = parTx.get(e.tx);
    if (!g) { g = { tx: e.tx, bloc: e.bloc, i: e.i, swaps: [], transferts: [], crochet: 0n, routeur: 0n }; parTx.set(e.tx, g); }
    if (e.genre === 'frais_crochet') { if (e.devise === ADR.ETH_NATIF) g.crochet += e.montant; continue; }
    if (e.genre === 'frais_routeur') { if (e.devise === ADR.ETH_NATIF) g.routeur += e.montant; continue; }
    if (e.i < g.i) g.i = e.i;
    (e.genre === 'swap' ? g.swaps : g.transferts).push(e);
  }
  const out = [];
  for (const g of parTx.values()) {
    if (!g.swaps.length) continue;
    let eth = 0n, jet = 0n;
    for (const s of g.swaps) {
      const p = P.get(s.pool);
      const e = p.ethEst0 ? s.u0 : s.u1, t = p.ethEst0 ? s.u1 : s.u0;
      eth += e; jet += t;
    }
    let sens = null;
    if (eth < 0n && jet > 0n) sens = 'achat';
    else if (eth > 0n && jet < 0n) sens = 'vente';
    if (!sens) continue;          // aller-retour dans la meme tx : ni achat ni vente
    const nets = new Map();
    for (const t of g.transferts) {
      if (!exclus.has(t.de)) nets.set(t.de, (nets.get(t.de) || 0n) - t.valeur);
      if (!exclus.has(t.vers)) nets.set(t.vers, (nets.get(t.vers) || 0n) + t.valeur);
    }
    let qui = null, meilleur = 0n;
    for (const [a, n] of nets) {
      const v = sens === 'achat' ? n : -n;
      if (v > meilleur) { meilleur = v; qui = a; }
    }
    const flux = abs(jet);
    if (!qui || meilleur * 2n < flux) continue;     // personne ne porte la moitie du flux
    const ethSwap = abs(eth);
    const frais = sens === 'vente' ? g.crochet + g.routeur : g.routeur;
    const ethWallet = sens === 'vente' ? (ethSwap > frais ? ethSwap - frais : 0n) : ethSwap + frais;
    out.push({ tx: g.tx, bloc: g.bloc, i: g.i, sens, qui, eth: ethWallet, ethSwap, frais, fraisLus: txLues ? txLues.has(g.tx) : true, jetons: flux, net: meilleur });
  }
  out.sort((a, b) => a.bloc - b.bloc || a.i - b.i);
  return out;
}

/** Les N premiers acheteurs DISTINCTS, chacun a son 1er achat d'au moins
 *  MISE_MIN_WEI. `exclus` : le createur et ses adresses (sa propre mise va dans
 *  la recette, pas dans la liste). */
function premiersAcheteurs(trades, o) {
  const n = (o && o.n) || N_ACHETEURS;
  const mise = o && o.miseMin != null ? o.miseMin : MISE_MIN_WEI;
  const exclus = new Set(((o && o.exclus) || []).map((a) => String(a).toLowerCase()));
  const vus = new Set(), out = [];
  for (const t of trades) {
    if (t.sens !== 'achat' || t.eth < mise || exclus.has(t.qui) || vus.has(t.qui)) continue;
    vus.add(t.qui);
    out.push({ qui: t.qui, bloc: t.bloc, tx: t.tx, eth: t.eth, jetons: t.jetons });
    if (out.length >= n) break;
  }
  return out;
}

/** Les minutes apres le lancement (horodatages en secondes, lus dans les
 *  en-tetes : `blockTimestamp` des journaux vaut toujours 0x0, sonde du 11/10). */
const minutesApres = (t, t0) => (t == null || t0 == null ? null : (t - t0) / 60);

// ------------------------------------------------------------ positions et gain

/**
 * La position d'un wallet sur un jeton.
 *   trades     echanges() du jeton (achats/ventes dont il est le beneficiaire)
 *   transferts Transfer du jeton QUI LE CONCERNENT (de ou vers lui)
 * Rend { entre, sorti, achetes, vendus, recuHorsMarche, envoyeHorsMarche,
 *        coutConnu, premierAchat }.
 * Un Transfer d'une tx ou il est beneficiaire d'un echange est deja compte
 * dans l'echange ; tout autre mouvement est « hors marche » (envoi, airdrop,
 * relais) et rend le cout INCONNU au-dela de 1 % du sac (COUT_CONNU_PART).
 */
function position(qui, trades, transferts) {
  const q = String(qui).toLowerCase();
  let entre = 0n, sorti = 0n, achetes = 0n, vendus = 0n, premierAchat = null, frais = 0n, fraisLus = true;
  const txEchange = new Set();
  for (const t of trades) {
    if (t.qui !== q) continue;
    txEchange.add(t.tx);
    if (t.frais != null) frais += t.frais;
    if (t.fraisLus === false) fraisLus = false;
    if (t.sens === 'achat') { entre += t.eth; achetes += t.net; if (!premierAchat) premierAchat = { bloc: t.bloc, tx: t.tx, eth: t.eth }; }
    else { sorti += t.eth; vendus += t.net; }
  }
  const netHors = new Map();
  for (const t of transferts) {
    if (txEchange.has(t.tx)) continue;
    let d = 0n;
    if (t.vers === q) d += t.valeur;
    if (t.de === q) d -= t.valeur;
    if (d) netHors.set(t.tx, (netHors.get(t.tx) || 0n) + d);
  }
  let recuHorsMarche = 0n, envoyeHorsMarche = 0n;
  for (const d of netHors.values()) { if (d > 0n) recuHorsMarche += d; else envoyeHorsMarche -= d; }
  const total = achetes + recuHorsMarche;
  /* cout connu : >= 99 % du sac vient d'achats (en entiers : hors*100 <= total*1)
     ET au plus 1 % des jetons achetes est parti HORS MARCHE (revue C2 du 13/10 :
     un relais, un envoi a soi-meme ou une vente par une piscine non lue rendait
     le wallet « perdant » a -100 % : BRODIE #33 0x9515… envoie tout a 0x18c0…,
     PEPONS #2 0x9984… renvoie tout 1 773 blocs apres, BRODIE #48 0x242f… vend
     par une autre piscine ; ils entraient comme pertes dans le taux de base) */
  const P = BigInt(Math.round((1 - COUT_CONNU_PART) * 100));
  const coutConnu = achetes > 0n && recuHorsMarche * 100n <= total * P && envoyeHorsMarche * 100n <= achetes * P;
  return { qui: q, entre, sorti, achetes, vendus, recuHorsMarche, envoyeHorsMarche, coutConnu, premierAchat, frais, fraisLus };
}

/** GAIN = sorti - entre + solde x prix, en wei. `solde` : balanceOf lu ;
 *  `prix` : { num, den } wei par unite du jeton. null si le solde est illisible,
 *  ou si le prix manque alors qu'il reste un solde. */
function gain({ entre, sorti, solde, prix }) {
  if (solde == null) return null;                 // balanceOf illisible : on ne devine pas
  const v = solde === 0n ? 0n : valeur(solde, prix);
  if (v == null) return null;
  return sorti - entre + v;
}

/** L'issue : « inconnu » si le cout n'est pas connu (sac recu hors marche) ou
 *  le prix manque ; sinon gagnant (gain > 0) ou perdant. */
function issue(pos, g) {
  if (!pos || !pos.coutConnu || g == null) return 'inconnu';
  return g > 0n ? 'gagnant' : 'perdant';
}

// ------------------------------------------------------------ les marques d'initie

/** ACHATS GROUPES : dans un meme bloc, >= GROUPE_MIN wallets distincts dont les
 *  mises sont a +/- GROUPE_ECART les unes des autres. `achats` : [{ qui, bloc,
 *  eth, tx }]. Rend Map qui -> preuve { bloc, tx, n }. */
function marqueGroupes(achats, o) {
  const min = (o && o.min) || GROUPE_MIN;
  const ecart = o && o.ecart != null ? o.ecart : GROUPE_ECART;
  const parBloc = new Map();
  for (const a of achats) { if (!parBloc.has(a.bloc)) parBloc.set(a.bloc, []); parBloc.get(a.bloc).push(a); }
  const out = new Map();
  /* comparaison en entiers : x <= y * (1 + ecart)  <=>  x * 10000 <= y * (10000 + ecart*10000) */
  const E = BigInt(Math.round(ecart * 10000));
  for (const [bloc, l] of parBloc) {
    /* une mise par wallet : la premiere du bloc */
    const un = []; const vus = new Set();
    for (const a of l) if (!vus.has(a.qui)) { vus.add(a.qui); un.push(a); }
    if (un.length < min) continue;
    un.sort((a, b) => (a.eth < b.eth ? -1 : a.eth > b.eth ? 1 : 0));
    for (let d = 0; d < un.length; d++) {
      let f = d;
      while (f + 1 < un.length && un[f + 1].eth * 10000n <= un[d].eth * (10000n + E)) f++;
      /* n = taille REELLE du groupe dans la fenetre lue (revue INI-09 : HM bloc
         49 405 448 = 16 wallets, dont 9 parmi les 50 premiers) ; acheteursBloc =
         tous les acheteurs du bloc (un bloc charge : « same-block pattern ») */
      if (f - d + 1 >= min) for (let k = d; k <= f; k++) if (!out.has(un[k].qui)) out.set(un[k].qui, { bloc, tx: un[k].tx, n: f - d + 1, acheteursBloc: un.length, membres: un.slice(d, f + 1).map((x) => x.qui) });
    }
  }
  return out;
}

/** PAIRES REPETEES : 2 wallets dans une meme cle (bloc, ou jeton:bloc), mises a
 *  +/- GROUPE_ECART, dans >= PAIRE_BLOCS cles distinctes. `achats` : [{ qui,
 *  cle, eth, tx, bloc, jeton? }]. Rend Map qui -> preuve { avec, blocs: [{ bloc,
 *  tx, jeton }] }. */
function marquePaires(achats, o) {
  const ecart = o && o.ecart != null ? o.ecart : GROUPE_ECART;
  const E = BigInt(Math.round(ecart * 10000));
  const parCle = new Map();
  for (const a of achats) { const k = a.cle != null ? String(a.cle) : String(a.bloc); if (!parCle.has(k)) parCle.set(k, []); parCle.get(k).push(a); }
  const paires = new Map();
  for (const [cle, l] of parCle) {
    const un = []; const vus = new Set();
    for (const a of l) if (!vus.has(a.qui)) { vus.add(a.qui); un.push(a); }
    if (un.length < 2) continue;
    un.sort((a, b) => (a.eth < b.eth ? -1 : a.eth > b.eth ? 1 : 0));
    for (let d = 0; d < un.length; d++) for (let f = d + 1; f < un.length && un[f].eth * 10000n <= un[d].eth * (10000n + E); f++) {
      const [x, y] = un[d].qui < un[f].qui ? [un[d], un[f]] : [un[f], un[d]];
      const k = x.qui + ':' + y.qui;
      if (!paires.has(k)) paires.set(k, new Map());
      paires.get(k).set(cle, { bloc: x.bloc, tx: x.tx, jeton: x.jeton || null });
    }
  }
  const out = new Map();
  for (const [k, cles] of paires) {
    if (cles.size < PAIRE_BLOCS) continue;
    const [x, y] = k.split(':');
    const blocs = [...cles.values()];
    if (!out.has(x)) out.set(x, { avec: y, blocs });
    if (!out.has(y)) out.set(y, { avec: x, blocs });
  }
  return out;
}

/** CO-ENTREE : >= COENTREE_MIN wallets dont le 1er achat tombe dans un MEME bloc
 *  sur >= COENTREE_JETONS jetons, quelles que soient les mises. `premiers` :
 *  [{ wallet, jeton, bloc, tx }]. Rend Map wallet -> preuve { blocs: [{ jeton,
 *  bloc, tx }], membres: [wallets] }. */
function marqueCoentree(premiers, o) {
  const min = (o && o.min) || COENTREE_MIN;
  const parBloc = new Map();
  for (const p of premiers) {
    const k = p.jeton + ':' + p.bloc;
    if (!parBloc.has(k)) parBloc.set(k, { jeton: p.jeton, bloc: p.bloc, tx: p.tx, w: new Set() });
    parBloc.get(k).w.add(p.wallet);
  }
  const G = [...parBloc.values()].filter((g) => g.w.size >= min);
  const out = new Map();
  for (let a = 0; a < G.length; a++) for (let b = a + 1; b < G.length; b++) {
    if (G[a].jeton === G[b].jeton) continue;
    const communs = [...G[a].w].filter((x) => G[b].w.has(x));
    if (communs.length < min) continue;
    for (const w of communs) {
      if (!out.has(w)) out.set(w, { blocs: [], membres: new Set() });
      const m = out.get(w);
      for (const g of [G[a], G[b]]) if (!m.blocs.some((x) => x.jeton === g.jeton && x.bloc === g.bloc)) m.blocs.push({ jeton: g.jeton, bloc: g.bloc, tx: g.tx });
      for (const c of communs) m.membres.add(c);
    }
  }
  for (const m of out.values()) { m.membres = [...m.membres].sort(); m.blocs.sort((x, y) => x.bloc - y.bloc); }
  const jetons = (m) => new Set(m.blocs.map((x) => x.jeton)).size;
  for (const [w, m] of out) if (jetons(m) < COENTREE_JETONS) out.delete(w);
  return out;
}

/** RELAIS : le wallet renvoie >= RELAIS_PART des jetons qu'il a achetes a une
 *  autre adresse (hors piscine, hors vente) dans les RELAIS_BLOCS blocs qui
 *  suivent son 1er achat. `pos` : position() ; `sorties` : ses Transfer
 *  sortants hors echange [{ vers, valeur, bloc, tx }]. */
function marqueRelais(pos, sorties, o) {
  const part = o && o.part != null ? o.part : RELAIS_PART;
  const blocs = (o && o.blocs) || RELAIS_BLOCS;
  if (!pos || !pos.premierAchat || !(pos.achetes > 0n)) return null;
  const debut = pos.premierAchat.bloc;
  let envoye = 0n; let dernier = null; const vers = new Set();
  for (const s of sorties) {
    if (s.bloc < debut || s.bloc > debut + blocs) continue;
    envoye += s.valeur; vers.add(s.vers); dernier = s;
  }
  const P = BigInt(Math.round(part * 10000));
  if (envoye * 10000n < pos.achetes * P) return null;
  return { bloc: dernier.bloc, tx: dernier.tx, vers: [...vers], apresBlocs: dernier.bloc - debut };
}

/** RENVOI AU CREATEUR : un Transfer du jeton du wallet vers le createur (ou une
 *  de ses adresses), hors des tx ou il est beneficiaire d'un echange
 *  (`txEchange`, comme marqueRelais). */
function marqueRenvoi(qui, transferts, createurs, txEchange) {
  const C = new Set([...createurs].map((a) => String(a).toLowerCase()));
  for (const t of transferts) if (t.de === qui && C.has(t.vers) && !(txEchange && txEchange.has(t.tx))) return { bloc: t.bloc, tx: t.tx, vers: t.vers };
  return null;
}

/** FINANCE PAR LE CREATEUR : un envoi (WETH ou autre jeton lu dans les
 *  journaux) du createur vers le wallet AVANT son 1er achat. L'ETH natif ne
 *  laisse aucun journal : il n'est pas lu (le dire, ne pas le deviner). */
function marqueFinance(qui, premierBloc, financements, createurs) {
  const C = new Set([...createurs].map((a) => String(a).toLowerCase()));
  for (const f of financements) if (f.vers === qui && C.has(f.de) && f.bloc <= premierBloc) return { bloc: f.bloc, tx: f.tx, de: f.de };
  return null;
}

/** Les marques d'un wallet, en une liste [{ type, preuve }]. */
function marques({ qui, groupes, paires, relais, renvoi, finance }) {
  const l = [];
  if (groupes && groupes.has(qui)) l.push({ type: 'groupe', preuve: groupes.get(qui) });
  if (paires && paires.has(qui) && !(groupes && groupes.has(qui))) l.push({ type: 'paire', preuve: paires.get(qui) });
  if (relais) l.push({ type: 'relais', preuve: relais });
  if (renvoi) l.push({ type: 'renvoi', preuve: renvoi });
  if (finance) l.push({ type: 'finance', preuve: finance });
  return l;
}

// ------------------------------------------------------------ taux de base, score

/** Le taux de base d'un jeton : la part de gagnants parmi ses entrants de la
 *  1re heure dont l'issue est connue, SANS les wallets marques (revue C6 : les
 *  inities gagnent presque tous, ils gonflaient la reference — HM 43/48 avec,
 *  31/36 sans ; TROLL 45/49 contre 33/37 ; NILF 27/50 contre 21/33).
 *  Rend { n, gagnants, p }. */
const compteDansLaBase = (p) => !!p.tot && (p.issue === 'gagnant' || p.issue === 'perdant') && !(p.marques && p.marques.length);
function tauxBase(participations) {
  let n = 0, g = 0;
  for (const p of participations) {
    if (!compteDansLaBase(p)) continue;
    n++; if (p.issue === 'gagnant') g++;
  }
  return { n, gagnants: g, p: n ? g / n : null };
}

/**
 * Le score d'un wallet sur tous les jetons lus.
 *   parts   [{ jeton, tot, issue, gain (BigInt|null), minutes, marques: [] }]
 *   bases   Map jeton -> { n, gagnants } (tauxBase)
 * Rend { projets, connus, jugeables, gagnants, gainTotal, delaiMoyen, attendu,
 *        ecartType, z, initie, smart, verdict }.
 *
 * POURQUOI UN TAUX DE BASE : on ne lit que des jetons qui ont depasse 1 M$.
 * Entrer tot sur un survivant suffit presque a etre « gagnant sur le papier ».
 * La regle du proprietaire (>= 3 jetons gagnants, aucune marque) est gardee
 * telle quelle ; le z dit si le wallet fait MIEUX que n'importe quel entrant de
 * la 1re heure sur les memes jetons : z = (gagnants - somme p) / racine(somme
 * p(1-p)), sur les seuls jetons dont le taux est JUGEABLE (>= BASE_ASSEZ issues
 * connues, le wallet juge retire de la base : revue C6, NOVAAI 3/5 avec lui,
 * 2/4 sans). Sous PROJETS_ASSEZ issues connues jugeables, aucun verdict
 * (revue C3 : on comptait les projets, issues inconnues comprises).
 */
function score(parts, bases) {
  const tot = parts.filter((p) => p.tot);
  let gagnants = 0, gainTotal = 0n, attendu = 0, variance = 0, sommeMin = 0, nMin = 0, connus = 0, jugeables = 0, gagnantsJuges = 0;
  for (const p of tot) {
    if (p.minutes != null) { sommeMin += p.minutes; nMin++; }
    if (p.issue !== 'gagnant' && p.issue !== 'perdant') continue;
    connus++;
    const gagne = p.issue === 'gagnant';
    if (gagne) gagnants++;
    if (p.gain != null) gainTotal += p.gain;
    const b = bases && bases.get(p.jeton);
    if (!b || b.n == null) continue;
    const dedans = compteDansLaBase(p);
    const n = b.n - (dedans ? 1 : 0), g = b.gagnants - (dedans && gagne ? 1 : 0);
    if (n < BASE_ASSEZ) continue;
    const pj = g / n;
    jugeables++; if (gagne) gagnantsJuges++;
    attendu += pj; variance += pj * (1 - pj);
  }
  const initie = parts.some((p) => p.marques && p.marques.length);
  const smart = !initie && gagnants >= SMART_JETONS;
  const ecartType = Math.sqrt(variance);
  const z = ecartType > 0 ? (gagnantsJuges - attendu) / ecartType : null;
  let verdict;
  if (initie) verdict = 'initie';
  else if (jugeables < PROJETS_ASSEZ) verdict = 'pas_assez';
  else if (z != null && z >= Z_VERDICT) verdict = 'mieux_que_la_base';
  else verdict = 'comme_la_base';
  return { projets: tot.length, connus, jugeables, gagnants, gagnantsJuges, gainTotal, delaiMoyen: nMin ? sommeMin / nMin : null,
           attendu, ecartType, z, initie, smart, verdict };
}

// ------------------------------------------------------------ recette et liens

/** La recette d'un lancement : achat par le createur puis jetons brules,
 *  robots dans la 1re minute, profil DexScreener paye dans les 3 h. */
function recette({ achatCreateur, bruleParCreateur, robots, profilApresS }) {
  const r = {
    achatPuisBrule: !!(achatCreateur && bruleParCreateur),
    robots1reMinute: robots == null ? null : robots,
    profilSous3h: profilApresS == null ? null : profilApresS >= 0 && profilApresS <= PROFIL_PAYE_S,
  };
  const s = [];
  if (r.achatPuisBrule) s.push('creator-buy-then-burn');
  if (r.robots1reMinute != null && r.robots1reMinute >= ROBOTS_MIN) s.push('bots-first-minute');
  if (r.profilSous3h) s.push('paid-profile-3h');
  r.signature = s.join('+');
  return r;
}

/** Les liens entre jetons. `jetons` : [{ jeton, createur, operateur,
 *  premiers: [adresses], recette: { signature }, ancien }]. `createur` est le
 *  VRAI createur (pour une migration : celui de l'ancien jeton, revue INI-06 :
 *  l'operateur 0x84b8… faisait 10 liens « meme createur » faux entre BRODIE,
 *  NILF, HM, PEPONS et TROLL) ; `operateur` donne un lien distinct. Le lien
 *  « meme financeur » n'existe pas : rien ne lit de financeur (revue INI-05).
 *  Rend une liste [{ a, b, type, detail }] sans doublon (a < b). */
const LIENS_TYPES = ['meme_createur', 'meme_operateur_migration', 'memes_premiers', 'meme_recette', 'migration'];
function liens(jetons) {
  const out = [];
  const pousse = (a, b, type, detail) => { const [x, y] = a < b ? [a, b] : [b, a]; out.push({ a: x, b: y, type, detail }); };
  /* une recette faite du SEUL « bots-first-minute » ne relie rien (revue INI-13 :
     4 jetons sur 7 la portent ; le seul lien de ce type, astro-NILF, venait des
     « robots » d'astro comptes au mauvais lancement) */
  const recetteLiante = (sig) => !!sig && sig.split('+').some((x) => x !== 'bots-first-minute');
  for (let i = 0; i < jetons.length; i++) for (let k = i + 1; k < jetons.length; k++) {
    const A = jetons[i], B = jetons[k];
    if (A.createur && A.createur === B.createur) pousse(A.jeton, B.jeton, 'meme_createur', A.createur);
    if (A.operateur && A.operateur === B.operateur) pousse(A.jeton, B.jeton, 'meme_operateur_migration', A.operateur);
    if (A.premiers && B.premiers) {
      const S = new Set(A.premiers); const c = B.premiers.filter((x) => S.has(x));
      if (c.length >= PREMIERS_COMMUNS_MIN) pousse(A.jeton, B.jeton, 'memes_premiers', c.length);
    }
    const ra = A.recette && A.recette.signature, rb = B.recette && B.recette.signature;
    if (ra && ra === rb && recetteLiante(ra)) pousse(A.jeton, B.jeton, 'meme_recette', ra);
  }
  for (const J of jetons) if (J.ancien) pousse(J.ancien, J.jeton, 'migration', J.jeton);
  return out;
}

// ------------------------------------------------------------ le createur

/**
 * Qui a lance le jeton, et a quel titre. Tout vient d'un recu et de sa tx :
 *   migration  le jeton est le « nouveau » d'un MigratorCreated : l'expediteur
 *              est l'OPERATEUR d'une migration, pas le createur du meme
 *              (rapport verifie le 13/10 : 0x84b8… n'a cree aucun des 7)
 *   deployeur  recu.contractAddress = le jeton : creation directe
 *   lanceur    la tx frappe le jeton via une fabrique (tx.to) : rampe, launchpad
 *   inconnu    la 1re tx lue ne frappe pas le jeton : rien n'est affirme
 *              (contre-exemple PAPER, 13/10 : deploye par 0xdf76…, 1re frappe
 *              envoyee par 0x2d74…)
 */
function attribueCreateur({ jeton, tx, recu, migration }) {
  const j = String(jeton).toLowerCase();
  if (!tx || !recu) return { role: 'inconnu', qui: null, verifie: false };
  const de = String(tx.from || '').toLowerCase(), vers = tx.to ? String(tx.to).toLowerCase() : null;
  const base = { qui: de, bloc: num(recu.blockNumber), tx: String(recu.transactionHash || tx.hash).toLowerCase(), via: vers };
  if (migration) return Object.assign(base, { role: 'migration', verifie: true, ancien: migration.ancien, migrateur: migration.migrateur });
  if (recu.contractAddress && String(recu.contractAddress).toLowerCase() === j) return Object.assign(base, { role: 'deployeur', verifie: true, via: null });
  const frappe = (recu.logs || []).some((l) => String(l.address).toLowerCase() === j && String(l.topics[0]).toLowerCase() === TOPIC.TRANSFER && adrDe(l.topics[1]) === ADR.ETH_NATIF);
  if (frappe) return Object.assign(base, { role: 'lanceur', verifie: true });
  return Object.assign(base, { role: 'inconnu', verifie: false });
}

// ------------------------------------------------------------ les alertes

/** 2 wallets smart ou plus achetent le meme jeton dans une fenetre d'1 h.
 *  `achats` : [{ qui, jeton, t, bloc, tx }] ; `smart` : Set ou Map des smart.
 *  Rend [{ jeton, wallets: [{ qui, t, bloc, tx }], t0, t1 }]. */
function alertesSmart(achats, smart, o) {
  const min = (o && o.min) || ALERTE_SMART_MIN;
  const fen = (o && o.fenetre) || ALERTE_FENETRE_S;
  const S = smart instanceof Map ? smart : new Set(smart);
  const parJeton = new Map();
  for (const a of achats) {
    if (!S.has(a.qui)) continue;
    if (!parJeton.has(a.jeton)) parJeton.set(a.jeton, []);
    parJeton.get(a.jeton).push(a);
  }
  const out = [];
  for (const [jeton, l] of parJeton) {
    l.sort((a, b) => a.t - b.t || a.bloc - b.bloc);
    let meilleure = null;
    for (let d = 0; d < l.length; d++) {
      const fenetre = new Map();
      for (let f = d; f < l.length && l[f].t - l[d].t <= fen; f++) if (!fenetre.has(l[f].qui)) fenetre.set(l[f].qui, l[f]);
      if (fenetre.size >= min && (!meilleure || fenetre.size > meilleure.size)) meilleure = fenetre;
    }
    if (meilleure) {
      const w = [...meilleure.values()];
      out.push({ jeton, wallets: w, t0: Math.min(...w.map((x) => x.t)), t1: Math.max(...w.map((x) => x.t)) });
    }
  }
  return out;
}

/** Un createur DEJA CONNU lance un jeton : seulement si son role est verifie
 *  (deployeur ou lanceur) — jamais l'operateur d'une migration, jamais un
 *  « inconnu » (voir attribueCreateur), jamais un LANCEUR AUTOMATIQUE (>=
 *  LANCEUR_AUTO lancements en 24 h, `o.lancements24h` : resume quotidien a la
 *  place). `connus` : Map createur -> palmares. */
const estLanceurAuto = (n) => n != null && n >= LANCEUR_AUTO;
function alerteCreateur(creation, connus, o) {
  if (!creation || !creation.verifie || !creation.qui) return null;
  if (creation.role !== 'deployeur' && creation.role !== 'lanceur') return null;
  if (o && estLanceurAuto(o.lancements24h)) return null;
  const p = connus.get(creation.qui);
  if (!p) return null;
  return { createur: creation.qui, jeton: creation.jeton, palmares: p, bloc: creation.bloc, tx: creation.tx, role: creation.role };
}

// ------------------------------------------------------------ les textes

const esc = (x) => String(x == null ? '' : x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const court = (a) => (a ? String(a).slice(0, 6) + '…' + String(a).slice(-4) : '?');
const milliers = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** wei -> « 1.234 ETH » (4 chiffres significatifs au plus, signe garde). */
function eth(w) {
  if (w == null) return '?';
  const neg = w < 0n; const a = neg ? -w : w;
  const x = Number(a / 10n ** 12n) / 1e6;
  const s = x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(3) : x >= 0.001 ? x.toFixed(4) : x > 0 ? '<0.001' : '0';
  return (neg ? '-' : '') + s + ' ETH';
}
function usd(u) {
  if (u == null || !isFinite(u)) return '?';
  if (u >= 1e9) return '$' + (u / 1e9).toFixed(2) + 'B';
  if (u >= 1e6) return '$' + (u / 1e6).toFixed(2) + 'M';
  if (u >= 1e3) return '$' + Math.round(u / 1e3) + 'k';
  return '$' + Math.round(u);
}
const liensDe = (explorer) => ({
  tx: (h) => `${explorer}/tx/${h}`,
  adresse: (a) => `${explorer}/address/${a}`,
  dex: (j) => `https://dexscreener.com/robinhood/${j}`,
});
/** Le pied commun : deux sections, toujours separees. */
function sections(verifies, nonVerifies) {
  const l = [];
  if (verifies.length) l.push('<b>Verified</b> (read on chain):', ...verifies.map((x) => '• ' + x));
  if (nonVerifies.length) l.push('<b>Not verified</b> (estimated or from an outside source):', ...nonVerifies.map((x) => '• ' + x));
  return l.join('\n');
}
const zTexte = (s) => (s.z == null ? 'z n/a' : 'z ' + (s.z >= 0 ? '+' : '') + s.z.toFixed(1));
function verdictTexte(s) {
  if (s.verdict === 'initie') return 'insider mark — never smart';
  if (s.verdict === 'pas_assez') return `no verdict under ${PROJETS_ASSEZ} known outcomes (${s.jugeables != null ? s.jugeables : s.connus != null ? s.connus : 0} so far)`;
  if (s.verdict === 'mieux_que_la_base') return 'beats the base rate';
  return 'no better than the base rate';
}

/** L'offre en UNITES (Number) depuis l'offre brute et les decimales lues :
 *  exacte a 0, 2, 6, 9, 18 decimales (revue C7 : l'ancienne expression
 *  divisait le pic par 10^(6 - decimales) sous 6 decimales). */
function unites(offre, decimales) {
  if (offre == null || decimales == null) return null;
  return Number((BigInt(offre) * 10n ** 6n) / 10n ** BigInt(Math.max(0, Number(decimales)))) / 1e6;
}

/** Une quantite brute -> « 973.3M » (decimales lues sur le contrat). */
function quantite(brut, decimales) {
  const d = BigInt(Math.max(0, Number(decimales) || 0));
  const v = Number(BigInt(brut) * 1000n / 10n ** d) / 1000;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v * 100) / 100);
}

/** Qui a lance le jeton, en phrases (texte brut, anglais) : { v: [Verified],
 *  nv: [Not verified] }. Jamais « developer of » pour un operateur de
 *  migration (rapport verifie le 13/10). `j` : { jeton, symbole, createur:
 *  { adresse, role, bloc, tx, via }, ancien: { jeton, createur, bloc, tx } }. */
function phrasesCreateur(j) {
  const v = [], nv = [];
  const sym = j.symbole || court(j.jeton);
  const c = j.createur;
  const ou = (x) => (x && x.bloc != null ? ` (block ${milliers(x.bloc)}${x.tx ? ', tx ' + court(x.tx) : ''})` : '');
  if (!c || !c.adresse) { nv.push(`the creator of ${sym} was not read`); return { v, nv }; }
  if (c.role === 'migration') {
    let p = `wallet ${court(c.adresse)} sent the migration of ${sym}${ou(c)}`;
    if (j.ancien && j.ancien.createur) p += `; the old token ${court(j.ancien.jeton)} was created by ${court(j.ancien.createur)}${ou(j.ancien)}`;
    v.push(p);
    nv.push('the wallet that runs a migration did not create the original token');
  } else if (c.role === 'deployeur') v.push(`wallet ${court(c.adresse)} deployed ${sym}${ou(c)}`);
  else if (c.role === 'lanceur') v.push(`wallet ${court(c.adresse)} launched ${sym} through ${court(c.via)}${ou(c)}`);
  else nv.push(`wallet ${court(c.adresse)} sent the first transaction read for ${sym}; that it deployed the contract is not verified`);
  return { v, nv };
}

/** Un drapeau rouge, en une phrase « Verified ». */
function phraseDrapeau(d, symbole) {
  if (d && d.type === 'sortie_de_dead') return `${quantite(d.valeur, d.decimales)} ${symbole || 'tokens'} moved out of 0x…dead (block ${milliers(d.bloc)}, tx ${court(d.tx)}) — a burn address cannot sign`;
  return null;
}

/** L'alerte « 2 smart ou plus sur le meme jeton dans l'heure » (HTML Telegram). */
function texteAlerteSmart(al, ctx) {
  const L = liensDe(ctx.explorer);
  const sym = esc(ctx.symbole || court(al.jeton));
  const v = [], nv = [];
  for (const w of al.wallets) {
    v.push(`wallet <a href="${L.adresse(w.qui)}">${court(w.qui)}</a> received ${sym} in a buy (block ${milliers(w.bloc)}, <a href="${L.tx(w.tx)}">tx ${court(w.tx)}</a>)`);
    const s = ctx.scores && ctx.scores.get(w.qui);
    if (s) nv.push(`${court(w.qui)}: early and up on ${s.gagnants} of ${s.projets} tokens over $1M (${zTexte(s)} vs the base rate; ${esc(verdictTexte(s))}); gains are priced at the last swap read`);
  }
  nv.push('“smart” is the owner’s rule (early and up on 3+ tokens, no insider mark), not a prediction');
  /* sous le seuil, le titre le dit (revue C8 : le verdict n'apparaissait que dans
     la partie Not verified) */
  const sansVerdict = al.wallets.some((w) => { const s = ctx.scores && ctx.scores.get(w.qui); return !s || s.verdict === 'pas_assez'; });
  return `<b>Smart wallets on ${sym}${sansVerdict ? ' (owner’s rule, no verdict yet)' : ''}</b>\n${al.wallets.length} smart wallets bought within ${Math.max(1, Math.round((al.t1 - al.t0) / 60))} min.\n` +
    sections(v, nv) + `\n<a href="${L.dex(al.jeton)}">DexScreener</a> · alert only, nothing is bought`;
}

/** L'alerte « un createur deja connu lance un jeton ». */
function texteAlerteCreateur(al, ctx) {
  const L = liensDe(ctx.explorer);
  const p = al.palmares || {};
  const sym = esc(ctx.symbole || court(al.jeton));
  const role = al.role === 'deployeur' ? 'deployed' : 'launched (through ' + court(ctx.via) + ')';
  const v = [`wallet <a href="${L.adresse(al.createur)}">${court(al.createur)}</a> ${role} ${sym} (block ${milliers(al.bloc)}, <a href="${L.tx(al.tx)}">tx ${court(al.tx)}</a>)`];
  if (p.lancements != null) v.push(`${p.lancements} earlier launch${p.lancements === 1 ? '' : 'es'} by this wallet were read`);
  if (p.retraits) v.push(`${p.retraits} of them had 90%+ of their liquidity removed`);
  if (p.drapeaux) v.push(`${p.drapeaux} red flag${p.drapeaux === 1 ? '' : 's'} on its tokens (see the page)`);
  const nv = [];
  if (p.reussites != null) nv.push(`${p.reussites} of its tokens closed a day above $1M (GeckoTerminal daily close × supply)`);
  return `<b>Known creator launched ${sym}</b>\n` + sections(v, nv) + `\n<a href="${L.dex(al.jeton)}">DexScreener</a> · alert only, nothing is bought`;
}

module.exports = {
  TOPIC, ADR, COTES_ETH, BRULES,
  N_ACHETEURS, MISE_MIN_WEI, TOT_S, ROBOTS_S, PROFIL_PAYE_S, SMART_JETONS, PROJETS_ASSEZ, Z_VERDICT,
  GROUPE_MIN, GROUPE_ECART, BLOC_CHARGE, COENTREE_MIN, COENTREE_JETONS, PAIRE_BLOCS, RELAIS_PART, RELAIS_BLOCS, COUT_CONNU_PART, ROBOTS_MIN, ALERTE_SMART_MIN, ALERTE_FENETRE_S,
  SEUIL_CAP_USD, PREMIERS_COMMUNS_MIN, BASE_ASSEZ, LANCEUR_AUTO, LIENS_TYPES, ROUTEURS_FRAIS,
  adrDe, pad32, estAdresse, estPool4, decode, piscineEth, jambe, prixDepuisSqrt, prixDepuisReserves, valeur,
  echanges, premiersAcheteurs, minutesApres, position, gain, issue,
  marqueGroupes, marquePaires, marqueCoentree, marqueRelais, marqueRenvoi, marqueFinance, marques,
  tauxBase, compteDansLaBase, score, recette, liens, attribueCreateur, alertesSmart, alerteCreateur, estLanceurAuto,
  esc, court, eth, usd, milliers, quantite, unites, sections, verdictTexte, zTexte, phrasesCreateur, phraseDrapeau, texteAlerteSmart, texteAlerteCreateur,
};
