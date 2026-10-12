'use strict';
/*
 * ==================== LA COMMUNAUTE $SWOGE SUR TELEGRAM ====================
 *
 * ---- la demande (proprietaire, 11/10/2026) ----
 *
 * « Ca serait pas mal d ajouter ca aux notifs Telegram quand il y a une paper
 * hand et un believer ou nouveaux — Suivi de la communaute : nombre de
 * detenteurs jour apres jour, nouveaux detenteurs, part de l offre en dehors
 * des pools. Ce sont les chiffres qui montrent une vraie croissance. Genere
 * une photo expres aussi. »
 *
 * Trois annonces sur le canal PUBLIC (TG_CHAT_ID, comme les depots et les
 * mises) — 🆕 New holder, 💎 Believer, 🧻 Paper hand —, chacune avec sa ligne
 * de communaute, et un releve quotidien a heure fixe. Une image dediee par
 * genre, generee UNE fois.
 *
 * ---- ETEINT PAR DEFAUT ----
 *
 *   TG_COMMUNAUTE vide      rien : aucune minuterie, aucune requete, aucun fichier
 *   TG_COMMUNAUTE=observe   lit la chaine, calcule, JOURNALISE ce qu il annoncerait,
 *                           n envoie rien et ne genere aucune image (0 $)
 *   TG_COMMUNAUTE=1         annonce sur le canal public, genere les quatre images
 *   autre valeur            inerte, et la ligne de demarrage le dit
 *   TG_COMMUNAUTE_HEURE     heure du releve quotidien, Europe/Paris (defaut 13:00)
 *   TG_COMMUNAUTE_EXCLUS    adresses de la maison en plus (virgules) : jamais detenteurs
 *
 * ---- D OU VIENNENT LES CHIFFRES : LE NOEUD OFFICIEL, PAS BLOCKSCOUT ----
 *
 * La demande disait « Blockscout, gratuit et sans cle ». Sonde du 11/10/2026
 * vers 23:13 UTC, curl et fetch Node : /api/v2/tokens/<jeton>, /counters,
 * /api/v2/stats et /api?module=token rendent TOUS HTTP 403
 * `cf-mitigated: challenge` (defi Cloudflare, « Just a moment… »). Le depot le
 * savait (ai_colonie.js HORS_SERVICE.blockscout ; osint.js : « le contourner
 * est interdit »). On ne le contourne pas : on lit le noeud officiel
 * (cfg.RPC_URL, gratuit, sans cle), qui donne tout — eth_getLogs pour les
 * Transfer, eth_getCode, eth_call, les en-tetes de bloc. Le prix vient de
 * DexScreener (sans cle). Les liens /tx/ et /address/ de l explorateur restent
 * dans les messages : ce sont des pages pour des HUMAINS.
 *
 * Mesures du noeud (sonde du 11/10/2026) :
 *  - eth_getLogs : 10 000 000 blocs au plus par requete (message exact :
 *    « only 10000000 are allowed for this request ; narrow the block range »),
 *    10 000 lignes au plus ; 800 a 1 100 ms par appel ;
 *  - l historique entier du $SWOGE (frappe unique au bloc 3 747 598) : 8 305
 *    Transfer en 10 a 16 appels, ~20 s ;
 *  - le noeud n est PAS une archive (« historical state … is not available ») :
 *    le solde d avant un achat se deduit en REJOUANT les Transfer. Le rejeu
 *    tombe juste : paire rejouee 191 267 201,66 = balanceOf ; 0x…dEaD rejoue
 *    13 409 118,44 = lu ; 713 adresses a solde > 0 = holder_count de GoPlus ;
 *  - `blockTimestamp` des journaux vaut toujours 0x0 : l heure se lit dans les
 *    en-tetes (0,10354 s par bloc, 864 000 blocs = 89 463 s du 10/10 22:24 au
 *    11/10 23:15 UTC) ;
 *  - debit : ~250 appels unitaires a 1 s d ecart, 0 refus ; lots de 100
 *    eth_getCode a 2 s : 6 refus 429 sur 14 ; lots de 25 a 1,5 s : 1 refus sur
 *    30. D ou 1 appel par seconde, lots de 20 a 2 s, recul sur 429. Ce noeud
 *    est partage avec la colonie.
 *
 * ---- CE QUE LES MOTS VEULENT DIRE ICI ----
 *
 * DETENTEUR : une adresse de PERSONNE (sans code, ou deleguee EIP-7702 —
 *   code 0xef0100…) qui tient AU MOINS 1 000 $SWOGE, hors maison. Sonde du
 *   11/10 : 713 adresses a solde > 0 (c est le chiffre de GoPlus et de
 *   Blockscout), mais 536 des 541 adresses entre 1 et 1 000 jetons tiennent
 *   EXACTEMENT 278,294 $SWOGE recus d un seul envoyeur (0xe20bb824…, 537
 *   envois fin aout) et n ont jamais achete : de la poussiere d airdrop. Au
 *   seuil de 1 000 : 121 detenteurs. Compter les soldes > 0 gonflait la
 *   communaute de 470 %. C est pourquoi notre chiffre (121) differe des
 *   chiffres publics (713) : nous ne comptons ni la poussiere, ni les piscines,
 *   ni l adresse de brulage, ni les contrats, ni la maison.
 *   EIP-7702 : 57 portefeuilles delegues sont des personnes, dont 31 a 1 000
 *   ou plus (26 % des 121) ; « a du code = contrat » les aurait perdus.
 * PISCINES : TROUVEES, pas devinees. Tout contrat qui tient du $SWOGE est
 *   interroge (token0()/token1()) : il est piscine si l un des deux est le
 *   $SWOGE ; une non-piscine echoue a token0 (verifie). Plus le PoolManager v4
 *   (PM4, miroir.js), qui garde les fonds de tous les pools v4 et n a pas de
 *   token0. Sonde du 11/10 : cinq adresses — v2 SWOGE/WETH 0x2dc0… (191,27 M),
 *   v3 SWOGE/SWOGEBET 0xc129… (118,24 M), PoolManager v4 0x8366… (47 987),
 *   deux v3 SWOGE/SWV4TEST 0x1fec… et 0xc84b… (509,93 chacune).
 * OFFRE EN CIRCULATION : le frappe moins le brule. Brule = ce qu ont recu
 *   0x0 (net des frappes), 0x…dEaD et 0x…01 a 0x…09 (meme liste que
 *   ai_colonie.js). Sonde : 1 000 000 000 frappes, 13 409 118,44 brules (tout
 *   a 0x…dEaD, rien a 0x0), donc 986 590 881,56 en circulation.
 * PART HORS PISCINES : 1 − (solde des piscines / circulation). 68,62 % le
 *   11/10 vers 23:20 UTC, 59,83 % le 03/10 a minuit, 0 % au lancement (le
 *   milliard entier etait dans la paire). Le coffre du casino (0x5593…,
 *   15,2 M, 1,54 %) n est ni piscine ni detenteur : il est HORS piscines (ce
 *   sont des depots de joueurs), mais ne compte pas comme detenteur.
 * NOUVEAU DETENTEUR DU JOUR : une personne passee de moins de 1 000 a 1 000 ou
 *   plus pendant la journee de Paris EN ACHETANT a une piscine de marche
 *   (« solde 0 avant », au seuil de poussiere pres). Le releve dit aussi
 *   combien le sont pour la PREMIERE fois. Relecture du 12/10 : compter tout
 *   passage du seuil laissait un envoi de 1 000 jetons a N adresses (~0,05 $
 *   chacune) ajouter N « nouveaux » — l airdrop de 0xe20bb824… (537 envois de
 *   278,294) n est reste sous le seuil que par hasard. Les passages par simple
 *   envoi (airdrop, portefeuille a portefeuille, retrait du casino,
 *   conversion) sont comptes A PART (« moved in »), comme les sorties autres
 *   qu une vente (« moved out » : depot au casino, envoi, conversion) : le
 *   releve les montre, « New » et « Left » ne comptent que le marche.
 *
 * ---- QUI A ACHETE : LE BENEFICIAIRE, JAMAIS LE SIGNATAIRE ----
 *
 * Sonde du 11/10 : dans 59 echanges sur 120 (7 jours), l adresse qui signe
 * n est pas l acheteur (relais, agregateurs). On regroupe les Transfer par
 * transaction, on calcule le net de chaque adresse ; le net des piscines dit
 * le sens (negatif = achat, positif = vente) ; le BENEFICIAIRE est la
 * personne (hors piscines, contrats, maison) qui a le plus grand net dans ce
 * sens, a condition qu il porte au moins la moitie du flux des piscines
 * (verifie sur les 120 : 0 echange sans beneficiaire). Les routeurs ont un
 * net nul et disparaissent seuls ; les deux portefeuilles de frais
 * d interface (0x5a3482…, 0xc06ebb…), qui recoivent ~0,875 % de chaque
 * vente, ne deviennent jamais de faux « New holder » ; une route
 * ETH → SWOGE → SWOGEBET a un net de piscines nul : rien n est annonce.
 * Validation : sur 24 h, la paire donne des jetons dans 19 tx et en recoit
 * dans 8 — exactement les comptes de DexScreener et GeckoTerminal.
 * Une transaction qui ajoute ou retire de la liquidite (Mint/Burn v2,
 * Mint/Burn/Collect v3, ModifyLiquidity v4 sur une piscine) n est ni un
 * achat ni une vente : elle est comptee a part, jamais annoncee. On le lit
 * dans le RECU de la transaction (voir LOT_RECUS), jamais par une requete sur
 * le PoolManager v4 entier.
 * Le sens ne se lit que sur les piscines de MARCHE (l autre jeton est du WETH,
 * de l USDG ou de l ETH natif) : un echange $SWOGE ↔ $SWOGEBET ou ↔ jeton du
 * launchpad est une conversion, jamais une paper hand (voir VALEUR).
 *
 * ---- LE GRAND LIVRE EST RECOUPE AVEC LA CHAINE ----
 *
 * Le noeud repond [] SANS erreur pour une plage au-dela de sa pointe (relecture
 * du 12/10) : deux repliques decalees pourraient faire sauter des Transfer au
 * curseur, et les chiffres publics deriveraient en silence. Avant tout envoi, et
 * au moins une fois par heure, le solde rejoue des piscines et de 0x…dEaD est
 * compare a balanceOf AU BLOC DU CURSEUR (le noeud garde l etat recent : lu a
 * pointe-50 et pointe-1000, refuse a pointe-100 000, sonde du 12/10 vers 01:20
 * UTC). Un ecart : rien ne part, le tic est rejoue depuis le disque ; un ecart
 * qui persiste au tic suivant : le grand livre est reconstruit depuis la frappe.
 *
 * Les seuils d annonce, le plafond et l heure du releve sont plus bas, chacun
 * avec la mesure qui l a fixe.
 */
const fs = require('fs');
const path = require('path');

const E18 = 10n ** 18n;
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/* Les evenements de liquidite, calcules (ethers.utils.id) depuis leurs
   signatures ; une transaction qui en porte un sur une piscine n est ni un
   achat ni une vente. */
const TOPICS_LIQUIDITE = [
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f', // v2 Mint(address,uint256,uint256)
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496', // v2 Burn(address,uint256,uint256,address)
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', // v3 Mint(address,address,int24,int24,uint128,uint256,uint256)
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', // v3 Burn(address,int24,int24,uint128,uint256,uint256)
  '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0', // v3 Collect(address,address,int24,int24,uint128,uint128)
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec', // v4 ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)
];
const TOPIC_MODIFY_V4 = TOPICS_LIQUIDITE[5];
const SEL_TOKEN0 = '0x0dfe1681', SEL_TOKEN1 = '0xd21220a7', SEL_BALANCE = '0x70a08231';
/* Le PoolManager Uniswap v4 de Robinhood Chain (PM4, miroir.js) : il garde les
   fonds de TOUS les pools v4, dont au moins un $SWOGE (GoPlus, pool id
   0x603dbe46…). Il n a pas de token0 : on le connait par son adresse. */
const PM4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
/* ---- UN ACHAT OU UNE VENTE, C EST CONTRE DE LA VALEUR ----
 * Relecture du 12/10/2026 : echanger son $SWOGE contre du $SWOGEBET (piscine
 * v3 0xc129…) etait annonce « 🧻 Paper hand » pendant que swogebet_achats.js
 * annoncait la MEME transaction « 🎰 New $SWOGEBET buy » — deux messages
 * publics contradictoires. Et revendre un jeton du launchpad contre du $SWOGE
 * devenait « Believer ». Sur toute l histoire (sonde du 11/10) : 10 ventes
 * partielles vers la v3 SWOGEBET, 2 « believers » et 2 « paper hands » via les
 * piscines de jetons de test (0x49ee9527…, la maison) ; 0 sur les 7 derniers
 * jours — mais ce lot fait justement monter le $SWOGEBET.
 * Regle : le SENS d un echange ne se lit que sur les piscines dont l autre
 * jeton est une valeur hors de l ecosysteme — WETH (miroir.js), USDG (x402.js),
 * l ETH natif d un pool v4. Une piscine $SWOGE/$SWOGEBET ou $SWOGE/jeton du
 * launchpad est une CONVERSION : comptee (`genre_conversion`), jamais annoncee.
 * Pour le PoolManager v4 (plusieurs pools derriere une adresse), on lit le recu :
 * si un autre jeton ERC-20 que le $SWOGE, le WETH ou l USDG entre ou sort du
 * PoolManager dans la transaction, c est une conversion. */
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const VALEUR = new Set([WETH, USDG]);
/* La paire DexScreener (v2 SWOGE/WETH) : la source du prix. */
const PAIRE_PRIX = '0x2dc0fb72d9284228046cc95910eeaabebfe48456';
/* Frappe unique du $SWOGE (sonde du 11/10 : 1 G vers le contrat, puis vers la
   paire au bloc 3 747 766 — lancement equitable). Le rejeu part de la. */
const BLOC_FRAPPE = 3747598;
const FENETRE_LOGS = 10000000;                   // limite du noeud (message du noeud, 11/10)
const ZERO = '0x0000000000000000000000000000000000000000';
const MORT = '0x000000000000000000000000000000000000dead';
const BRULES = new Set([ZERO, MORT]);
for (let i = 1; i <= 9; i++) BRULES.add('0x' + String(i).padStart(40, '0'));

/* ---- LE SEUIL DE DETENTEUR : 1 000 $SWOGE ----
 * Sonde du 11/10/2026 : 0 adresse dans [1 ; 100), 541 dans [100 ; 1 000) dont
 * 536 tiennent exactement l airdrop de 278,294 sans avoir jamais achete, 11
 * dans [1 000 ; 10 000), 110 au-dela. 1 000 jetons ~ 0,05 $ au cours du jour :
 * c est la marche au-dessus de la poussiere, pas un tri par richesse. */
const SEUIL_DETENTEUR = 1000n * E18;

/* ---- CE QUI EST ANNONCE ----
 * Rejeu des 7 derniers jours par CE module (scratchpad, journaux reels du
 * 11/10, prix de chaque echange tire de sa jambe WETH) — chiffres dans
 * EXPLOITATION.md, « Communaute $SWOGE sur Telegram ».
 *  - New holder : achat qui fait passer une personne de moins de 1 000 a
 *    1 000 ou plus. Celle qui a deja tenu 1 000 ou plus un jour est annoncee
 *    « welcome back » : la regle du proprietaire est « solde 0 avant », et le
 *    dire evite de presenter un ancien comme un nouveau.
 *  - Believer : achat par une personne qui tenait deja 1 000 ou plus.
 *  - Paper hand : vente qui laisse moins de 1 000 (27 des 28 paper hands des
 *    7 jours retombaient a 0 pile, la 28e a 0,00x jeton).
 *  - Vente PARTIELLE : NON annoncee, comptee dans le releve. Sur 7 jours : 5
 *    ventes partielles (6 %, 15 %, 50 %, 50 %, 51 % du sac) ; le vendeur reste
 *    detenteur, l appeler « paper hand » serait faux ; 2 des 5 ont ete suivies
 *    d une sortie totale (0x1d4342 deux minutes plus tard, 0x1f2d92 cinq heures
 *    plus tard), qui, elle, est annoncee.
 * Montants minimaux en DOLLARS (jetons × cours DexScreener) : un seuil en
 * jetons change de sens quand le cours bouge (+20 % sur 24 h le 11/10).
 * Tailles mesurees (sonde, 7 jours, jambe WETH × 2 533 $) : entrees mediane
 * 48,7 $ (p25 25,3), believers 38,0 $ (p25 19,4), paper hands 77,3 $ (p25
 * 48,6, minimum 11,95). Au rejeu, 10 $ ecarte 5 premieres entrees sur 26 (de
 * 1,44 a 6,49 $) et 2 retours sur 22 ; 25 $ ecarte 14 believers sur 39 —
 * surtout les micro-achats repetes de 0xb67a60… (9 sur 13 sous 25 $) — et 3
 * paper hands sur 28. */
const MIN_USD = { nouveau: 10, retour: 10, believer: 25, paper: 25 };
/* ---- UNE ANNONCE PAR ADRESSE ET PAR FAMILLE TOUTES LES 24 H ----
 * Familles : entree (new holder et welcome back), believer, paper hand.
 * Rejeu de CE module sur les 7 jours du 04/10 23:18 au 11/10 23:20 UTC (120
 * evenements de marche, 40 adresses, seuils 10/25/25 $, plafond 4/h) :
 *   - sans recharge                        88 annonces, 12,6 par jour ;
 *   - 24 h par adresse, tous genres        51, 7,3 par jour — mais 14 des 28
 *     paper hands cachees, presque toutes parce que le meme portefeuille venait
 *     d etre accueilli : la sortie, qu on nous demande, disparaissait ;
 *   - 24 h par adresse ET par famille      68 messages, 9,7 par jour : 67
 *     annonces (21 new, 12 welcome back, 15 believers, 19 paper hands) + 1
 *     message groupe (2 evenements), 4 au plus dans une heure ; ecartes : 24
 *     sous le seuil, 22 par la recharge. Retenu : chaque genre demande garde
 *     sa voix, et le flipper 0x93229b… (17 evenements, huit allers-retours en
 *     7 jours) ne parle qu une fois par jour et par sens.
 *   Plus le releve quotidien : 7 messages. A revoir avec un mois de donnees
 *   (le mode observe compte chaque ecart par genre : sousSeuil_believer…). */
const RECHARGE_MS = 24 * 3600 * 1000;
const familleDe = (g) => (g === 'nouveau' || g === 'retour' ? 'entree' : g);
/* Au plus 4 annonces par heure d horloge ; au-dela, UN message groupe a la fin
   de l heure. Pic brut mesure : 9 evenements dans une meme heure (7 au-dessus
   de 50 $) ; apres seuils et recharge, le rejeu de 7 jours n a depasse 4 qu une
   fois (2 evenements regroupes en un message). Le plafond tient la rafale
   d un lancement sans couper une journee ordinaire. */
const PLAFOND_HEURE = 4;
/* Un evenement traite plus de 30 min apres son bloc n est pas annonce (il est
   compte) : apres une coupure, le rattrapage ne deverse pas des heures
   d echanges d un coup. Un tic normal traite un bloc en ~65 s (tic 60 s +
   50 blocs de marge) ; un redeploiement Railway prend quelques minutes. */
const RETARD_MAX_MS = 30 * 60 * 1000;
const TIC_MS = 60 * 1000;
const CONFIRMATIONS = 50;                         // ~5 s de marge sous la pointe
const CADENCE_MS = 103.54;                        // 0,10354 s par bloc (sonde du 11/10)
const ESPACE_RPC_MS = 1000;                       // 1 appel par seconde : 0 refus sur ~250 (sonde)
const LOT_CODES = 20, ESPACE_LOTS_MS = 2000;      // lots de 100 : 6 refus sur 14 ; de 25 : 1 sur 30
/* ---- LA LIQUIDITE ET LE SENS SE LISENT DANS LES RECUS ----
 * Relecture du 12/10/2026 : demander les evenements de liquidite par
 * eth_getLogs sur [toutes les piscines] ramenait ceux du PoolManager v4, donc
 * de TOUS les pools v4 de la chaine — 9 520 evenements en 100 000 blocs, 1 433
 * pools v4 distincts, 0 pour le $SWOGE ; ~596 000 journaux (~488 Mo, ~+960 Mo
 * de tas) a la construction, dans le processus du casino. Et le noeud limite a
 * 100 000 blocs toute requete a plusieurs valeurs par position (« narrow the
 * block range, or send one value per position »). On lit donc le RECU des
 * seules transactions ou une piscine du $SWOGE bouge : ~17 par jour (120
 * evenements de marche en 7 jours, sonde du 11/10). Sonde du 12/10 vers 01:20
 * UTC : un recu = 44 ms, 12,7 Ko ; un lot de 2 recus = 54 ms, sans refus. Lots
 * de 20, comme les codes. */
const LOT_RECUS = 20;
const RECUL_429_MS = 5000;                        // puis double a chaque refus
const PRIX_TTL_MS = 10 * 60 * 1000;
const PRIX_VIEUX_MS = 6 * 3600 * 1000;            // au-dela, pas de prix = pas d annonce
const REESSAI_CONSTRUCTION_MS = 10 * 60 * 1000;
/* ---- L HEURE DU RELEVE : 13:00 Europe/Paris ----
 * La tranche 12-15 h de Paris est la plus active de la semaine mesuree (30
 * evenements de marche sur 120 du 04/10 au 11/10, contre 4 entre 6 et 9 h ;
 * sur 30 jours : 19 echanges a 12 h, 17 a 14 h et a 15 h, 1 seul a 9 h) : le
 * releve part quand le public est la. La veille est close depuis 13 h, donc
 * definitive. 13:00 a Paris = 07:00 a New York, et il ne croise pas le
 * premier post X (09:00 New York = 15:00 Paris). Un releve rate (serveur
 * coupe) part au plus 3 h apres l heure, sinon le jour est saute. */
const HEURE_RELEVE = '13:00';
const FUSEAU = 'Europe/Paris';
const RELEVE_RETARD_MAX_MS = 3 * 3600 * 1000;
const JOURS_RELEVE = 7;

/* ---- LES IMAGES ----
 * Une par genre, generee UNE fois avec le generateur des posts X et son
 * controle des pattes (x_post.genereImageVerifiee), gardee sur le volume.
 * 0,22 $ l image (6 893 jetons de sortie a 32 $ le million, mesure du
 * 18/09/2026, x_post.js) ; le controle de vision coute moins d un centime.
 * Au plus 2 appels de genereImageVerifiee par genre POUR LA VIE DU VOLUME
 * (chacun : 2 generations au plus) : 0,88 $ nominal, 3,52 $ au pire. Les
 * essais sont comptes AVANT l appel. Dossier a part : x_post.purgeImages
 * efface les PNG de x_images au-dela des 60 derniers. Noms versionnes :
 * Telegram garde une image par URL, 404 compris (incident Bonanza) — changer
 * de dessin, c est changer de version. */
const VERSION_IMAGES = 'v1';
const ESSAIS_IMAGE_MAX = 2;
const COUT_IMAGE_USD = 0.22;
const USD_PAR_JETON_IMAGE = 32e-6;
const SCENES = {
  nouveau: { nom: 'communaute-nouveau',
    prompt: 'bursting through a paper banner at a surprise welcome party thrown for him, confetti cannons firing on both sides, a small wrapped gift box held between his paws, beaming',
    monde: 'a festive living room at night, warm string lights, cream and gold balloons, streamers frozen mid-air' },
  believer: { nom: 'communaute-believer',
    prompt: 'holding an enormous glowing cut diamond against his chest with both paws, calm and unshakable, eyes half closed in quiet confidence',
    monde: 'a dark bank vault, one spotlight from above, the diamond scattering sparks of light across brushed steel walls, deep blue and silver' },
  paper: { nom: 'communaute-paper',
    prompt: 'a single sheet of paper slipping out of his paw and flying away in the wind, he watches it go with a relaxed shrug, more loose sheets swirling around him',
    monde: 'a windy rooftop at dusk, dozens of paper sheets whirling through the air, orange and violet sky, city lights coming on below' },
  releve: { nom: 'communaute-releve',
    prompt: 'standing proudly beside a large blackboard, pointing with one paw at the tallest bar of a simple chalk bar chart whose bars rise steadily from left to right; the chart is drawn in chalk with no digits, no letters and no axis labels',
    monde: 'a bright classroom in the morning, sunlight through tall windows, chalk dust floating in the light, warm wood and a green board' },
};
const GENRES_IMAGE = ['nouveau', 'believer', 'paper', 'releve'];
const imageDuGenre = (g) => (g === 'retour' ? 'nouveau' : g);
const NOM_IMAGE = /^[0-9A-Za-z_-]{1,40}$/;

const VERSION_ETAT = 1;
const HEURE_MS = 3600 * 1000;
const JOUR_MS = 24 * HEURE_MS;

// ------------------------------------------------------------ les reglages

function config(env) {
  const e = env || process.env;
  const brut = String(e.TG_COMMUNAUTE || '').trim();
  const mode = brut === '' ? 'off' : brut === 'observe' ? 'observe' : brut === '1' ? 'annonce' : 'inconnu';
  const h = String(e.TG_COMMUNAUTE_HEURE || HEURE_RELEVE).trim();
  const heure = /^([01]?\d|2[0-3]):[0-5]\d$/.test(h) ? h : HEURE_RELEVE;
  const exclus = String(e.TG_COMMUNAUTE_EXCLUS || '').split(/[\s,;]+/).map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  return { brut, mode, heure, heureBrute: h, exclus };
}

// ------------------------------------------------------------ petits outils

const adrDe = (topic) => ('0x' + String(topic).slice(26)).toLowerCase();
const hex = (n) => '0x' + Number(n).toString(16);
const absB = (x) => (x < 0n ? -x : x);
const jetons = (b) => Number(b / 10n ** 12n) / 1e6;
function fmtJetons(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  return Math.round(n).toLocaleString('en-US');
}
const fmtUsd = (u) => (u >= 1 ? '$' + Math.round(u).toLocaleString('en-US') : '&lt;$1');   // HTML de Telegram : jamais un « < » nu
const court = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const signe = (n) => (n > 0 ? '+' + n : n === 0 ? '±0' : String(n));
function xp() { return require('./x_post'); }
function jourParis(t) { return xp().heureLocale(t, FUSEAU).jour; }
/** Minuit (heure de Paris) du jour `jour` (AAAA-MM-JJ), en ms UTC. Paris est a
 *  UTC+1 ou UTC+2 : minuit y tombe a 23:00 ou 22:00 UTC la veille. */
function minuitParis(jour) {
  const [y, m, d] = jour.split('-').map(Number);
  for (const decalage of [2, 1]) {
    const t = Date.UTC(y, m - 1, d) - decalage * HEURE_MS;
    const l = xp().heureLocale(t, FUSEAU);
    if (l.jour === jour && l.minutes === 0) return t;
  }
  return Date.UTC(y, m - 1, d) - HEURE_MS;
}
function jourPlus(jour, n) {
  const [y, m, d] = jour.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const jourCourt = (j) => MOIS[Number(j.slice(5, 7)) - 1] + ' ' + j.slice(8, 10);

// ------------------------------------------------------------ l instance

/**
 * `deps` :
 *   tg            { notify(texte), notifyPhoto(urlOuNull, legende) } (telegram.js)
 *   prendre       fetch (noeud, DexScreener, OpenAI via x_post)
 *   horloge()     l heure (Date.now)
 *   dors(ms)      l attente (les essais la rendent instantanee)
 *   dossier       DATA_DIR
 *   maison()      les adresses de la maison (Set ou tableau) : jamais detenteurs
 *   rpcUrl, publicUrl, explorer, jeton   (config.js par defaut)
 *   imageCle      OPENAI_API_KEY est posee (sa PRESENCE, jamais sa valeur)
 *   genereImage(prompt)  remplace x_post.genereImageVerifiee (essais)
 *   minuteries    false : aucun setInterval (les essais appellent tic)
 *   env           remplace process.env pour la configuration (essais)
 */
function cree(deps0) {
  const cfgG = require('./config');
  const deps = Object.assign({
    horloge: () => Date.now(),
    dors: (ms) => new Promise((r) => setTimeout(r, ms)),
    prendre: (...a) => fetch(...a),
    dossier: cfgG.DATA_DIR,
    rpcUrl: cfgG.RPC_URL,
    publicUrl: cfgG.PUBLIC_URL,
    explorer: cfgG.EXPLORER,
    jeton: cfgG.SWOGE_TOKEN,
    maison: () => [],
  }, deps0 || {});
  const C = config(deps.env);
  const JETON = String(deps.jeton).toLowerCase();
  const FICHIER = path.join(deps.dossier, 'communaute.json');
  const DOSSIER_IMAGES = path.join(deps.dossier, 'communaute_images');
  const exclusEnv = new Set(C.exclus);

  // ---------------------------------------------------------- l etat
  let S = null;
  function etatNeuf() {
    return { v: VERSION_ETAT, construit: false, curseur: 0, soldes: new Map(), codes: {}, pools: new Set(), autres: {},
             deja: new Set(), jours: {}, photos: {}, horaires: [], ancres: [], annonces: {}, dernier: {},
             heure: null, releves: {}, prix: null, compteurs: {}, appels: 0, refus429: 0, jourCourant: null, controleH: null };
  }
  /* Ce qu une (re)construction garde de l etat precedent : ce qui a deja ete
     DIT (annonces, recharges, releves), les compteurs et le cours. Tout ce qui
     se deduit de la chaine (livre, codes, piscines, photos) repart de zero. */
  const GARDES_CONSTRUCTION = ['annonces', 'dernier', 'releves', 'compteurs', 'appels', 'refus429', 'prix'];
  function versDisque() {
    const soldes = {};
    for (const [a, b] of S.soldes) if (b !== 0n) soldes[a] = b.toString(16);
    return JSON.stringify({ v: S.v, construit: S.construit, curseur: S.curseur, soldes, codes: S.codes,
      pools: [...S.pools], autres: S.autres, deja: [...S.deja], jours: S.jours, photos: S.photos, horaires: S.horaires,
      ancres: S.ancres, annonces: S.annonces, dernier: S.dernier, heure: S.heure, releves: S.releves,
      prix: S.prix, compteurs: S.compteurs, appels: S.appels, refus429: S.refus429, jourCourant: S.jourCourant,
      controleH: S.controleH });
  }
  function depuisDisque(j) {
    const s = etatNeuf();
    if (!j || j.v !== VERSION_ETAT) return s;
    Object.assign(s, j);
    s.soldes = new Map(Object.entries(j.soldes || {}).map(([a, h]) => [a, h.startsWith('-') ? -BigInt('0x' + h.slice(1)) : BigInt('0x' + h)]));
    s.pools = new Set(j.pools || []);
    s.deja = new Set(j.deja || []);
    return s;
  }
  function litEtat() {
    try { return depuisDisque(JSON.parse(fs.readFileSync(FICHIER, 'utf8'))); }
    catch (e) { return etatNeuf(); }
  }
  /* Ecrit en une fois (fichier temporaire puis renommage) : soldes, curseur et
     annonces marquees voyagent ENSEMBLE — une coupure entre deux ne peut ni
     rejouer un Transfer deux fois, ni re-annoncer. */
  function ecritEtat() {
    fs.mkdirSync(deps.dossier, { recursive: true });
    const tmp = FICHIER + '.tmp';
    fs.writeFileSync(tmp, versDisque());
    fs.renameSync(tmp, FICHIER);
  }
  const compte = (k, n) => { S.compteurs[k] = (S.compteurs[k] || 0) + (n === undefined ? 1 : n); };
  /* Le journal des images vit dans SON fichier : la generation tourne en
     arriere-plan pendant qu un tic a peut-etre deja applique la moitie de ses
     Transfer en memoire ; ecrire tout l etat a ce moment-la figerait un grand
     livre a moitie avance sous l ancien curseur. */
  const JOURNAL_IMAGES = path.join(DOSSIER_IMAGES, 'journal.json');
  function litImages() { try { return JSON.parse(fs.readFileSync(JOURNAL_IMAGES, 'utf8')) || {}; } catch (e) { return {}; } }
  function ecritImages(j) {
    fs.mkdirSync(DOSSIER_IMAGES, { recursive: true });
    fs.writeFileSync(JOURNAL_IMAGES + '.tmp', JSON.stringify(j, null, 1));
    fs.renameSync(JOURNAL_IMAGES + '.tmp', JOURNAL_IMAGES);
  }

  // ---------------------------------------------------------- le noeud
  let dernierAppel = 0, echecsCodes = 0;
  async function rpcBrut(corps) {
    let derniere = '429';
    for (let essai = 0; essai < 5; essai++) {
      const attente = dernierAppel + ESPACE_RPC_MS - Date.now();
      if (attente > 0) await deps.dors(attente);
      dernierAppel = Date.now();
      S.appels++;
      let r, j;
      try {
        r = await deps.prendre(deps.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(corps), signal: AbortSignal.timeout(60000) });
        j = await r.json().catch(() => null);
      } catch (e) {
        derniere = String((e && e.message) || e).slice(0, 80);
        await deps.dors(RECUL_429_MS * 2 ** essai);
        continue;
      }
      const msg = (x) => String((x && x.error && x.error.message) || '');
      const limite = r.status === 429 || (j && !Array.isArray(j) && /too many requests|rate limit/i.test(msg(j)))
        || (Array.isArray(j) && j.some((x) => /too many requests|rate limit/i.test(msg(x))));
      if (limite) { S.refus429++; await deps.dors(RECUL_429_MS * 2 ** essai); continue; }
      /* Relecture du 12/10 : UNE reponse 503 sans JSON faisait echouer toute la
         construction (sans reessai). Une page d erreur de passerelle est une
         panne passagere, comme un 429 : on recule et on redemande. */
      if (!j || r.status >= 500) { compte('pannesNoeud'); derniere = 'HTTP ' + (r && r.status) + (j ? '' : ' sans JSON'); await deps.dors(RECUL_429_MS * 2 ** essai); continue; }
      return j;
    }
    throw new Error('noeud : abandon apres 5 refus ou pannes (' + derniere + ')');
  }
  async function rpc(method, params) {
    const j = await rpcBrut({ jsonrpc: '2.0', id: 1, method, params });
    if (j.error) { const e = new Error(String(j.error.message || 'erreur')); e.code = j.error.code; throw e; }
    return j.result;
  }
  /** Un lot : rend les resultats dans l ordre des appels ({ result } ou { error }). */
  async function lot(appels) {
    if (!appels.length) return [];
    const j = await rpcBrut(appels.map((a, i) => ({ jsonrpc: '2.0', id: i + 1, method: a[0], params: a[1] })));
    const parId = new Map((Array.isArray(j) ? j : [j]).map((x) => [x.id, x]));
    return appels.map((a, i) => parId.get(i + 1) || { error: { message: 'absent du lot' } });
  }
  const TROP = /exceeds limit|only \d+ are allowed|narrow the block range|query returned more than|too many results|response size/i;
  async function lisLogs(de, a, filtre) {
    const out = [];
    for (let x = de; x <= a; x += FENETRE_LOGS) {
      const y = Math.min(a, x + FENETRE_LOGS - 1);
      out.push(...await lisPlage(x, y, filtre));
    }
    return out;
  }
  async function lisPlage(de, a, filtre) {
    try {
      return await rpc('eth_getLogs', [Object.assign({ fromBlock: hex(de), toBlock: hex(a) }, filtre)]) || [];
    } catch (e) {
      if (!TROP.test(e.message) || a - de < 1000) throw e;
      const m = Math.floor((de + a) / 2);
      return (await lisPlage(de, m, filtre)).concat(await lisPlage(m + 1, a, filtre));
    }
  }
  const filtreJeton = () => ({ address: JETON, topics: [TOPIC_TRANSFER] });
  async function pointe() {
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    return { bloc: parseInt(b.number, 16), t: parseInt(b.timestamp, 16) * 1000 };
  }
  /** Le recoupement (voir l en-tete) : balanceOf des piscines et de 0x…dEaD AU
   *  BLOC `bloc`, contre le livre rejoue. Un lot de 5 a 6 appels. Rend { lus,
   *  ecarts } ; un element illisible (etat trop ancien, replique en retard)
   *  n est pas un ecart : on ne conclut pas sur une panne. */
  async function controleLivre(bloc) {
    const qui = [...S.pools, MORT];
    const rep = await lot(qui.map((a) => ['eth_call', [{ to: JETON, data: SEL_BALANCE + a.slice(2).padStart(64, '0') }, hex(bloc)]]));
    let lus = 0;
    const ecarts = [];
    rep.forEach((x, k) => {
      if (!x || x.error || typeof x.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(x.result) || x.result.length < 3) return;
      lus++;
      const chaine = BigInt(x.result), livre = solde(qui[k]);
      if (chaine !== livre) ecarts.push(`${court(qui[k])} chaine ${jetons(chaine)} livre ${jetons(livre)}`);
    });
    compte(lus ? 'controles' : 'controlesIllisibles');
    return { lus, ecarts };
  }

  // ---------------------------------------------------------- le temps des blocs
  /* Ancres (bloc, ms) relues dans les en-tetes ; entre deux, interpolation
     lineaire ; au-dela, la cadence mesuree. */
  function tempsDe(b) {
    const A = S.ancres;
    if (!A.length) return null;
    if (b >= A[A.length - 1][0]) return A[A.length - 1][1] + (b - A[A.length - 1][0]) * CADENCE_MS;
    if (b <= A[0][0]) return A[0][1] - (A[0][0] - b) * CADENCE_MS;
    for (let i = 1; i < A.length; i++) if (b <= A[i][0]) {
      const [b0, t0] = A[i - 1], [b1, t1] = A[i];
      return t0 + (b - b0) * (t1 - t0) / (b1 - b0);
    }
    return null;
  }
  function blocDe(t) {
    const A = S.ancres;
    if (t >= A[A.length - 1][1]) return Math.floor(A[A.length - 1][0] + (t - A[A.length - 1][1]) / CADENCE_MS);
    if (t <= A[0][1]) return Math.floor(A[0][0] - (A[0][1] - t) / CADENCE_MS);
    for (let i = 1; i < A.length; i++) if (t <= A[i][1]) {
      const [b0, t0] = A[i - 1], [b1, t1] = A[i];
      return Math.floor(b0 + (t - t0) * (b1 - b0) / (t1 - t0));
    }
    return A[A.length - 1][0];
  }
  function ancre(bloc, t) {
    if (S.ancres.length && S.ancres[S.ancres.length - 1][0] >= bloc) return;
    S.ancres.push([bloc, t]);
    /* on garde une ancre par heure environ sur 10 jours, plus la derniere */
    if (S.ancres.length > 2) {
      const garde = [];
      for (const x of S.ancres) {
        if (garde.length && x[1] - garde[garde.length - 1][1] < HEURE_MS && x !== S.ancres[S.ancres.length - 1]) continue;
        garde.push(x);
      }
      S.ancres = garde.filter((x, i) => i === garde.length - 1 || x[1] >= t - 10 * JOUR_MS);
    }
  }

  // ---------------------------------------------------------- qui est qui
  const solde = (a) => S.soldes.get(a) || 0n;
  function maisonSet() {
    let m;
    try { m = deps.maison(); } catch (e) { m = []; }
    const s = new Set();
    for (const a of (m || [])) if (a) s.add(String(a).toLowerCase());
    for (const a of exclusEnv) s.add(a);
    return s;
  }
  let MAISON = new Set();
  const exclu = (a) => S.pools.has(a) || BRULES.has(a) || a === JETON || MAISON.has(a) || S.codes[a] === 'c';
  const personne = (a) => S.codes[a] === 'p' && !exclu(a);

  /** Ce que rend token0()/token1() : une adresse, « rien » (revert explicite ou
   *  reponse vide : pas une piscine), ou undefined (panne : on ne conclut pas). */
  function lisJeton(x) {
    if (!x) return undefined;
    if (typeof x.result === 'string') return x.result.length >= 66 ? ('0x' + x.result.slice(26, 66)).toLowerCase() : 'rien';
    const e = x.error || {};
    return (e.code === 3 || /revert/i.test(String(e.message || ''))) ? 'rien' : undefined;
  }
  /** Le code des adresses inconnues, par lots ; un contrat est aussitot
   *  interroge (token0/token1) : piscine si l un des deux est le $SWOGE.
   *  Relecture du 12/10 : le code « contrat » etait ecrit AVANT la lecture de
   *  token0/token1 ; une lecture ratee (un 503, une erreur d element) laissait
   *  la paire v2 classee « pas une piscine » POUR TOUJOURS (100 % hors
   *  piscines, plus aucune annonce). Desormais un contrat n entre dans
   *  `S.codes` qu avec son verdict ; sans verdict il reste inconnu, et la
   *  construction refuse de conclure (rend la liste des indecis). */
  async function apprendCodes(adresses) {
    const inconnues = [...new Set(adresses)].filter((a) => !(a in S.codes) && !BRULES.has(a) && a !== JETON);
    const contrats = [], indecis = [];
    for (let i = 0; i < inconnues.length; i += LOT_CODES) {
      const morceau = inconnues.slice(i, i + LOT_CODES);
      if (i > 0) await deps.dors(ESPACE_LOTS_MS);
      const rep = await lot(morceau.map((a) => ['eth_getCode', [a, 'latest']]));
      rep.forEach((x, k) => {
        if (x.error || typeof x.result !== 'string') { indecis.push(morceau[k]); return; }   // reessaye au prochain passage
        const code = x.result.toLowerCase();
        /* EIP-7702 (0xef0100 + adresse deleguee) : un portefeuille de personne. */
        if (code === '0x' || code.startsWith('0xef0100')) S.codes[morceau[k]] = 'p';
        else if (morceau[k] === PM4) { S.codes[PM4] = 'c'; S.pools.add(PM4); S.autres[PM4] = null; }
        else contrats.push(morceau[k]);
      });
    }
    for (let i = 0; i < contrats.length; i += LOT_CODES / 2) {
      const morceau = contrats.slice(i, i + LOT_CODES / 2);
      if (i > 0) await deps.dors(ESPACE_LOTS_MS);
      const rep = await lot(morceau.flatMap((a) => [['eth_call', [{ to: a, data: SEL_TOKEN0 }, 'latest']],
                                                     ['eth_call', [{ to: a, data: SEL_TOKEN1 }, 'latest']]]));
      morceau.forEach((a, k) => {
        const t = [lisJeton(rep[2 * k]), lisJeton(rep[2 * k + 1])];
        /* un verdict demande DEUX reponses (adresse, revert ou vide), jamais une
           panne : il faut aussi l AUTRE jeton, qui dit si la piscine est un marche */
        if (t[0] === undefined || t[1] === undefined) { indecis.push(a); return; }
        S.codes[a] = 'c';
        if (t[0] === JETON || t[1] === JETON) {
          S.pools.add(a); S.autres[a] = t[0] === JETON ? t[1] : t[0];
          compte('piscinesTrouvees'); console.log(`[communaute] piscine trouvee : ${a} (token0 ${t[0]}, token1 ${t[1]})`);
        }
      });
    }
    return indecis;
  }

  // ---------------------------------------------------------- les chiffres
  function chiffres() {
    let n = 0, pools = 0n, frappe = 0n, brule = 0n, brut = 0, poussiere = 0;
    for (const [a, b] of S.soldes) {
      if (a === ZERO) { frappe = -b; continue; }
      /* `brut` : toute adresse a solde > 0, piscines, brulage et contrats
         compris — ce que comptent GoPlus et Blockscout (713 le 11/10, egal au
         rejeu). `poussiere` : les personnes sous le seuil (536 des 541 du 11/10
         tiennent l airdrop de 278,294). Le releve les CALCULE a l envoi : des
         chiffres ecrits en dur deviendraient faux sans que rien ne le dise. */
      if (b > 0n) brut++;
      if (BRULES.has(a)) { brule += b; continue; }
      if (S.pools.has(a)) pools += b;
      else if (b >= SEUIL_DETENTEUR && personne(a)) n++;
      else if (b > 0n && personne(a)) poussiere++;
    }
    const circulation = frappe - brule;
    const horsPools = circulation > 0n ? 100 * (1 - Number(pools * 1000000n / circulation) / 1e6) : null;
    return { detenteurs: n, horsPools, circulation: jetons(circulation), brule: jetons(brule), pools: jetons(pools), brut, poussiere };
  }
  function ecart24h(n, now) {
    let ref = null;
    for (const h of S.horaires) if (h.t <= now - 24 * HEURE_MS + 5 * 60000) ref = h;
    return ref ? n - ref.n : null;
  }
  function jourDe(cle) {
    const j = S.jours[cle] || (S.jours[cle] = { entrees: [], premieres: [], sorties: [], partielles: 0, achats: 0, ventes: 0 });
    if (!j.recus) j.recus = [];
    if (!j.partis) j.partis = [];
    return j;
  }
  const distinctesPersonnes = (l) => new Set((l || []).filter((a) => personne(a))).size;
  function ligneCommunaute(now) {
    const c = chiffres();
    const d = ecart24h(c.detenteurs, now);
    const nouveaux = distinctesPersonnes((S.jours[jourParis(now)] || {}).entrees);
    return `👥 ${c.detenteurs} holders${d === null ? '' : ` (${signe(d)} in 24h)`} · 🆕 ${nouveaux} new today` +
           (c.horsPools === null ? '' : ` · 🌊 ${c.horsPools.toFixed(1)}% of supply outside pools`);
  }

  // ---------------------------------------------------------- une transaction
  /** Applique les Transfer d une transaction au grand livre ; rend le net de
   *  chaque adresse et son solde d avant. */
  function applique(tx) {
    const net = new Map();
    for (const l of tx.logs) {
      const de = adrDe(l.topics[1]), vers = adrDe(l.topics[2]), v = BigInt(l.data === '0x' ? 0 : l.data);
      net.set(de, (net.get(de) || 0n) - v);
      net.set(vers, (net.get(vers) || 0n) + v);
    }
    const avant = new Map();
    for (const a of net.keys()) avant.set(a, solde(a));
    for (const [a, d] of net) {
      if (d === 0n) continue;
      const s = solde(a) + d;
      if (s === 0n) S.soldes.delete(a); else S.soldes.set(a, s);
    }
    return { net, avant };
  }
  /** Le genre d une transaction deja appliquee (voir l en-tete). `marche` : les
   *  piscines qui, DANS cette transaction, echangent le $SWOGE contre de la
   *  valeur (voir VALEUR et lisRecu) ; les autres sont des conversions. */
  function classe(net, avant, marche) {
    let poolNet = 0n, ecoNet = 0n;
    for (const [a, d] of net) if (S.pools.has(a)) { if (marche && marche.has(a)) poolNet += d; else ecoNet += d; }
    if (poolNet === 0n) return ecoNet === 0n ? null : { genre: 'conversion', achat: ecoNet < 0n };
    const achat = poolNet < 0n, flux = absB(poolNet);
    let qui = null, q = 0n;
    for (const [a, d] of net) {
      if (!personne(a) || (achat ? d <= 0n : d >= 0n)) continue;
      if (absB(d) > q) { qui = a; q = absB(d); }
    }
    if (!qui || q * 2n < flux) return { genre: 'sansBeneficiaire', achat };
    const av = avant.get(qui), ap = solde(qui);
    let genre;
    if (achat) genre = av >= SEUIL_DETENTEUR ? 'believer' : ap < SEUIL_DETENTEUR ? 'poussiere' : (S.deja.has(qui) ? 'retour' : 'nouveau');
    else genre = av < SEUIL_DETENTEUR ? 'poussiere' : ap < SEUIL_DETENTEUR ? 'paper' : 'partielle';
    return { genre, achat, qui, q: jetons(q), avant: jetons(av), apres: jetons(ap) };
  }
  /** Les passages du seuil, comptes par jour de Paris (le releve et « new today »).
   *  `k` : le genre de la transaction. Une ENTREE (« new ») est un achat a une
   *  piscine de marche dont la personne est le beneficiaire ; une SORTIE
   *  (« left ») est une paper hand. Tout autre passage du seuil (airdrop,
   *  envoi, depot ou retrait du casino, conversion, liquidite) est range dans
   *  `recus` / `partis` : il change le compte des detenteurs, pas « new » ni
   *  « left » (relecture du 12/10 : un depot au coffre etait compte « Left »,
   *  un airdrop de 1 000 jetons aurait ete compte « new »). */
  function passages(net, avant, t, k) {
    const j = jourDe(jourParis(t));
    for (const a of net.keys()) {
      const av = avant.get(a), ap = solde(a);
      const parMarche = !!(k && k.qui === a);
      if (av < SEUIL_DETENTEUR && ap >= SEUIL_DETENTEUR) {
        if (parMarche && k.achat) { j.entrees.push(a); if (!S.deja.has(a)) j.premieres.push(a); }
        else j.recus.push(a);
      } else if (av >= SEUIL_DETENTEUR && ap < SEUIL_DETENTEUR) {
        if (parMarche && !k.achat) j.sorties.push(a); else j.partis.push(a);
      }
      if (ap >= SEUIL_DETENTEUR) S.deja.add(a);
    }
  }
  function regroupe(logs, apres) {
    const txs = [], par = new Map();
    const tri = logs.filter((l) => !l.removed && parseInt(l.blockNumber, 16) > apres)
      .sort((x, y) => (parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16)) ||
                      (parseInt(x.transactionIndex, 16) - parseInt(y.transactionIndex, 16)) ||
                      (parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16)));
    for (const l of tri) {
      if (!par.has(l.transactionHash)) { const tx = { h: l.transactionHash, b: parseInt(l.blockNumber, 16), logs: [] }; par.set(l.transactionHash, tx); txs.push(tx); }
      par.get(l.transactionHash).logs.push(l);
    }
    return txs;
  }
  function netSeul(tx) {
    const net = new Map();
    for (const l of tx.logs) {
      const de = adrDe(l.topics[1]), vers = adrDe(l.topics[2]), v = BigInt(l.data === '0x' ? 0 : l.data);
      net.set(de, (net.get(de) || 0n) - v); net.set(vers, (net.get(vers) || 0n) + v);
    }
    return net;
  }
  /** Ce qu un recu dit d une transaction : liquidite sur une piscine du $SWOGE ?
   *  quelles piscines y sont un MARCHE (voir VALEUR) ? */
  function lisRecu(logs, net) {
    let liq = false;
    const autresPM4 = new Set();      // les jetons ERC-20 (hors $SWOGE) qui entrent dans le PoolManager ou en sortent
    for (const l of logs) {
      const a = String(l.address || '').toLowerCase(), tp = (l.topics || []).map((x) => String(x).toLowerCase());
      if (TOPICS_LIQUIDITE.includes(tp[0]) && S.pools.has(a)) {
        /* Le PoolManager porte les ModifyLiquidity de TOUS les pools v4 : il ne
           compte que si le $SWOGE entre ou sort du PoolManager dans CETTE
           transaction. Une transaction qui melangerait un echange v4 $SWOGE et
           une liquidite v4 d un autre pool serait tue — le cote sur. */
        if (a !== PM4 || (tp[0] === TOPIC_MODIFY_V4 && (net.get(PM4) || 0n) !== 0n)) liq = true;
      }
      /* Transfer ERC-20 (3 sujets ; un Transfer de NFT de position en a 4) */
      if (tp[0] === TOPIC_TRANSFER && tp.length === 3 && a !== JETON && (adrDe(tp[1]) === PM4 || adrDe(tp[2]) === PM4)) autresPM4.add(a);
    }
    const marche = new Set();
    for (const p of S.pools) {
      if (p === PM4) { if (![...autresPM4].some((x) => !VALEUR.has(x))) marche.add(p); }
      else if (VALEUR.has(S.autres[p])) marche.add(p);
    }
    return { liq, marche };
  }
  /** Les recus des transactions ou une piscine du $SWOGE bouge (voir LOT_RECUS) :
   *  Map hash → { liq, marche }. Un recu illisible fait echouer l appel (le tic
   *  reprendra au meme curseur) : sans lui on ne sait ni le sens ni la liquidite. */
  async function examine(txs) {
    const out = new Map();
    const cand = txs.filter((tx) => { for (const [a, d] of netSeul(tx)) if (d !== 0n && S.pools.has(a)) return true; return false; });
    for (let i = 0; i < cand.length; i += LOT_RECUS) {
      const morceau = cand.slice(i, i + LOT_RECUS);
      if (i > 0) await deps.dors(ESPACE_LOTS_MS);
      const rep = await lot(morceau.map((tx) => ['eth_getTransactionReceipt', [tx.h]]));
      rep.forEach((x, k) => {
        if (!x || x.error || !x.result || !Array.isArray(x.result.logs)) throw new Error('recu illisible pour ' + morceau[k].h + ' : ' + String((x && x.error && x.error.message) || 'vide').slice(0, 80));
        out.set(morceau[k].h, lisRecu(x.result.logs, netSeul(morceau[k])));
      });
    }
    if (cand.length) compte('recus', cand.length);
    return out;
  }
  const SANS_RECU = { liq: false, marche: new Set() };
  /** Classe une transaction deja appliquee, recu a l appui (null si rien ne bouge). */
  function genreDe(tx, net, avant, recus, enDirect) {
    const r = recus.get(tx.h) || SANS_RECU;
    if (r.liq) { if (enDirect) compte('liquidite'); return null; }
    return classe(net, avant, r.marche);
  }
  async function prepare(txs) {
    const adresses = [];
    for (const tx of txs) for (const [a, d] of netSeul(tx)) if (d !== 0n) adresses.push(a);
    /* un code rate une fois (lot en erreur) est redemande tant que l adresse tient le seuil */
    for (const [a, b] of S.soldes) if (b >= SEUIL_DETENTEUR && !(a in S.codes)) adresses.push(a);
    await apprendCodes(adresses);
    /* Un code qui manque encore (lot en erreur) ferait classer l acheteur
       « sans beneficiaire » et perdre l annonce pour toujours : on abandonne
       le tic, il reprendra au meme curseur. */
    const manque = adresses.filter((a) => !(a in S.codes) && !BRULES.has(a) && a !== JETON);
    /* … mais pas indefiniment : une adresse que le noeud refuserait toujours
       bloquerait tout. Au 5e tic d affilee, on passe (elle ne compte pas). */
    if (manque.length && ++echecsCodes < 5) throw new Error(`code inconnu pour ${manque.length} adresse(s) : tic reporte (${echecsCodes}/5)`);
    if (manque.length) console.log(`[communaute] ${manque.length} code(s) illisible(s) 5 tics de suite : on continue, ces adresses ne comptent pas`);
    echecsCodes = 0;
    return examine(txs);
  }

  // ---------------------------------------------------------- la construction
  /* Une fois dans la vie du volume (ensuite : le fichier), ou apres un ecart
     persistant avec la chaine. Rien n est annonce sur l historique. Cout au
     rejeu (voir EXPLOITATION) : ~10-16 eth_getLogs, ~36 lots de getCode,
     quelques lots token0/token1, 1 lot d en-tetes, ~8 lots de recus (les
     echanges des 8 derniers jours), 1 lot de balanceOf. Elle travaille sur un
     etat NEUF (voir tic) : ratee, elle ne laisse rien derriere elle. */
  let constructionsIndecises = 0;
  async function construit() {
    const t0 = Date.now(), appels0 = S.appels;
    const tip = await pointe();
    const now = deps.horloge();
    /* ancres : la pointe et un en-tete par jour sur 9 jours */
    const blocs = [];
    for (let k = 9; k >= 1; k--) if (tip.bloc - k * 864000 > 0) blocs.push(tip.bloc - k * 864000);
    const en = await lot(blocs.map((b) => ['eth_getBlockByNumber', [hex(b), false]]));
    S.ancres = [];
    en.forEach((x) => { if (x.result) S.ancres.push([parseInt(x.result.number, 16), parseInt(x.result.timestamp, 16) * 1000]); });
    S.ancres.push([tip.bloc, tip.t]);
    const jusqua = tip.bloc - CONFIRMATIONS;
    const logs = await lisLogs(BLOC_FRAPPE, jusqua, filtreJeton());
    const txs = regroupe(logs, 0);
    /* Les bornes : fins des 8 derniers jours de Paris, heures pleines des 26 dernieres heures. */
    const aujourdhui = jourParis(now);
    const finsJour = [];
    for (let k = JOURS_RELEVE + 1; k >= 1; k--) { const j = jourPlus(aujourdhui, -k); finsJour.push({ jour: j, t: minuitParis(jourPlus(j, 1)) }); }
    const debutFenetre = blocDe(minuitParis(jourPlus(aujourdhui, -JOURS_RELEVE)));
    const heures = [];
    for (let k = 26; k >= 1; k--) heures.push(Math.floor(now / HEURE_MS) * HEURE_MS - (k - 1) * HEURE_MS);
    /* Passe A : soldes finaux, et toute adresse passee au-dessus du seuil dans la fenetre. */
    const soldesA = new Map(), fenetre = new Set();
    for (const tx of txs) for (const [a, d] of netSeul(tx)) {
      if (d === 0n) continue;
      const av = soldesA.get(a) || 0n, s = av + d; soldesA.set(a, s);
      /* AVANT ou APRES : un detenteur qui ne fait que VENDRE dans la fenetre
         (solde nul aujourd hui) doit avoir son code, sinon les photos d avant
         sa sortie l oublient (rejeu du 11/10 : 99 au lieu de 101 le 03/10). */
      if (tx.b >= debutFenetre && (s >= SEUIL_DETENTEUR || av >= SEUIL_DETENTEUR)) fenetre.add(a);
    }
    MAISON = maisonSet();
    const indecis = await apprendCodes([...soldesA].filter(([, b]) => b > 0n).map(([a]) => a).concat([...fenetre]));
    if ((soldesA.get(PM4) || 0n) > 0n && S.codes[PM4] === 'c') { S.pools.add(PM4); S.autres[PM4] = null; }
    /* Refuser de conclure plutot que figer des photos fausses : une adresse sans
       verdict pourrait etre une piscine (relecture du 12/10). Au 5e essai
       d affilee on passe (une adresse que le noeud refuserait toujours ne doit
       pas tout bloquer) : les tics la redemandent tant qu elle tient le seuil. */
    if (indecis.length && ++constructionsIndecises < 5) throw new Error(`${indecis.length} adresse(s) sans verdict (code ou token0/token1) : construction refusee (${constructionsIndecises}/5)`);
    if (indecis.length) console.log(`[communaute] ${indecis.length} adresse(s) sans verdict 5 constructions de suite : on conclut, elles seront redemandees`);
    constructionsIndecises = 0;
    if (!S.pools.has(PAIRE_PRIX)) throw new Error('la paire du prix ' + PAIRE_PRIX + ' n est pas reconnue comme piscine : construction refusee');
    const recus = await examine(txs.filter((tx) => tx.b >= debutFenetre));
    /* Passe B : le rejeu complet, codes et piscines connus. */
    S.soldes = new Map(); S.deja = new Set(); S.jours = {}; S.photos = {}; S.horaires = [];
    let iJ = 0, iH = 0;
    const photo = (jour, t) => {
      const c = chiffres(), jj = S.jours[jour] || {};
      S.photos[jour] = { detenteurs: c.detenteurs, horsPools: c.horsPools, entrees: distinctesPersonnes(jj.entrees),
                         premieres: distinctesPersonnes(jj.premieres), sorties: distinctesPersonnes(jj.sorties),
                         recus: distinctesPersonnes(jj.recus), partis: distinctesPersonnes(jj.partis),
                         partielles: jj.partielles || 0, t, reconstruit: true };
    };
    const bornes = (b) => {
      while (iJ < finsJour.length && blocDe(finsJour[iJ].t) < b) { photo(finsJour[iJ].jour, finsJour[iJ].t); iJ++; }
      while (iH < heures.length && blocDe(heures[iH]) < b) { S.horaires.push({ t: heures[iH], n: chiffres().detenteurs }); iH++; }
    };
    for (const tx of txs) {
      bornes(tx.b);
      const { net, avant } = applique(tx);
      if (tx.b >= debutFenetre) {
        const t = tempsDe(tx.b);
        const k = genreDe(tx, net, avant, recus, false);
        if (k && k.genre === 'partielle') jourDe(jourParis(t)).partielles++;
        if (k && (k.genre === 'nouveau' || k.genre === 'retour' || k.genre === 'believer')) jourDe(jourParis(t)).achats++;
        if (k && (k.genre === 'paper' || k.genre === 'partielle')) jourDe(jourParis(t)).ventes++;
        passages(net, avant, t, k);
      } else {
        for (const a of net.keys()) if (solde(a) >= SEUIL_DETENTEUR) S.deja.add(a);
      }
    }
    bornes(Infinity);
    /* Le livre rejoue doit tomber sur la chaine au bloc du curseur, sinon on ne
       publie rien de ce qu il dit (un journal manquant dans une fenetre). */
    const ctl = await controleLivre(jusqua);
    if (ctl.ecarts.length) throw new Error('livre rejoue different de la chaine au bloc ' + jusqua + ' : ' + ctl.ecarts.join(' ; '));
    S.controleH = ctl.lus ? Math.floor(now / HEURE_MS) : null;
    S.curseur = jusqua;
    S.construit = true;
    S.heure = { cle: Math.floor(now / HEURE_MS), n: 0, surplus: {} };
    const c = chiffres();
    compte('constructions');
    console.log(`[communaute] construit en ${Math.round((Date.now() - t0) / 1000)} s · ${logs.length} Transfer · ${S.appels - appels0} appels au noeud (${S.refus429} refus 429) · ` +
      `${c.detenteurs} detenteurs (>= 1 000 $SWOGE, personnes hors maison) · ${c.horsPools === null ? '?' : c.horsPools.toFixed(2)} % hors ${S.pools.size} piscines · brule ${Math.round(c.brule)}`);
  }

  // ---------------------------------------------------------- le prix
  async function prixUsd(now) {
    if (S.prix && now - S.prix.t < PRIX_TTL_MS) return S.prix.usd;
    try {
      const r = await deps.prendre('https://api.dexscreener.com/latest/dex/pairs/robinhood/' + PAIRE_PRIX, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const p = (j && (j.pairs || (j.pair ? [j.pair] : []))) || [];
      const v = p[0] ? Number(p[0].priceUsd) : NaN;
      if (v > 0) { S.prix = { usd: v, t: now }; return v; }
    } catch (e) { /* le dernier cours connu, s il n est pas trop vieux */ }
    return S.prix && now - S.prix.t < PRIX_VIEUX_MS ? S.prix.usd : null;
  }

  // ---------------------------------------------------------- les annonces
  const lienAdr = (a) => `<a href="${deps.explorer}/address/${a}">${court(a)}</a>`;
  const lienTx = (h) => `<a href="${deps.explorer}/tx/${h}">view tx ↗</a>`;
  function texte(ev) {
    const usd = ev.usd === null ? '' : ` (~${fmtUsd(ev.usd)})`;
    let tete, corps;
    if (ev.genre === 'nouveau' || ev.genre === 'retour') {
      tete = '🆕 <b>New holder</b>' + (ev.genre === 'retour' ? ' · welcome back' : '');
      corps = `${lienAdr(ev.qui)} bought <b>${fmtJetons(ev.q)} $SWOGE</b>${usd}`;
    } else if (ev.genre === 'believer') {
      tete = '💎 <b>Believer</b>';
      corps = `${lienAdr(ev.qui)} bought <b>${fmtJetons(ev.q)} $SWOGE</b> more${usd} · now holds ${fmtJetons(ev.apres)}`;
    } else {
      tete = '🧻 <b>Paper hand</b>';
      corps = `${lienAdr(ev.qui)} sold <b>${fmtJetons(ev.q)} $SWOGE</b>${usd} and left`;
    }
    return `${tete}\n${corps}\n${ev.ligne}\n${lienTx(ev.h)}`;
  }
  function urlImage(genre) {
    const nom = genre + '-' + VERSION_IMAGES;
    try { if (!fs.statSync(path.join(DOSSIER_IMAGES, nom + '.png')).isFile()) return null; } catch (e) { return null; }
    return `${String(deps.publicUrl || '').replace(/\/+$/, '')}/communaute/image/${nom}.png`;
  }
  /** Ce qui part : envoye en mode « 1 », seulement journalise en observation. */
  function envoie(image, legende, quoi) {
    if (C.mode === 'annonce') {
      const url = image ? urlImage(image) : null;
      compte('envoyes');
      deps.tg.notifyPhoto(url, legende);
    } else {
      compte('observes');
      console.log(`[communaute] OBSERVATION · ${quoi} : ` + legende.replace(/<[^>]*>/g, '').replace(/\n/g, ' | '));
    }
  }
  function nomGroupe(s) {
    const achats = (s.nouveau || 0) + (s.retour || 0) + (s.believer || 0);
    const parts = [];
    if (achats) {
      const det = [];
      if (s.nouveau || s.retour) det.push(`${(s.nouveau || 0) + (s.retour || 0)} new holder${(s.nouveau || 0) + (s.retour || 0) > 1 ? 's' : ''}`);
      if (s.believer) det.push(`${s.believer} believer${s.believer > 1 ? 's' : ''}`);
      parts.push(`${achats} buy${achats > 1 ? 's' : ''} (${det.join(', ')})`);
    }
    if (s.paper) parts.push(`${s.paper} paper hand${s.paper > 1 ? 's' : ''}`);
    return parts.join(' · ');
  }
  /** Le tri d un evenement annoncable : retard, prix, montant, recharge, plafond. */
  async function trie(ev, now, aEnvoyer) {
    /* chaque raison est comptee PAR GENRE (ex. recharge_paper) : c est ce que
       le mode observe donne a lire avant d allumer */
    const ecarte = (raison) => { compte(raison + '_' + ev.genre); };
    if (S.annonces[ev.h]) return ecarte('dejaAnnonce');
    if (now - ev.t > RETARD_MAX_MS) return ecarte('retard');
    const p = await prixUsd(now);
    if (p === null) return ecarte('sansPrix');
    ev.usd = ev.q * p;
    if (ev.usd < MIN_USD[ev.genre]) return ecarte('sousSeuil');
    const cleR = ev.qui + '|' + familleDe(ev.genre);
    if (S.dernier[cleR] && now - S.dernier[cleR] < RECHARGE_MS) return ecarte('recharge');
    S.dernier[cleR] = now;
    S.annonces[ev.h] = now;
    const cle = Math.floor(now / HEURE_MS);
    if (!S.heure || S.heure.cle !== cle) videHeure(now, aEnvoyer);
    if (S.heure.n >= PLAFOND_HEURE) { S.heure.surplus[ev.genre] = (S.heure.surplus[ev.genre] || 0) + 1; return ecarte('regroupe'); }
    S.heure.n++;
    ecarte('annonce');
    aEnvoyer.push({ image: imageDuGenre(ev.genre), legende: texte(ev), quoi: ev.genre });
  }
  /** L heure a tourne : le surplus de l heure finie part en UN message. */
  function videHeure(now, aEnvoyer) {
    const cle = Math.floor(now / HEURE_MS);
    if (S.heure && S.heure.cle !== cle) {
      const s = S.heure.surplus || {};
      const n = Object.values(s).reduce((x, y) => x + y, 0);
      /* un surplus reste en plan par une coupure ne part pas des heures plus
         tard sous « the last hour » : il est compte, pas annonce */
      if (n > 0 && cle - S.heure.cle > 1) compte('groupesPerimes');
      else if (n > 0) {
        compte('messagesGroupes');
        aEnvoyer.push({ image: null, quoi: 'groupe', legende: `📊 <b>+${n} more in the last hour</b>\n${nomGroupe(s)}\n${ligneCommunaute(now)}` });
      }
    }
    if (!S.heure || S.heure.cle !== cle) S.heure = { cle, n: 0, surplus: {} };
  }

  // ---------------------------------------------------------- le releve quotidien
  function texteReleve(now) {
    const c = chiffres();
    const d = ecart24h(c.detenteurs, now);
    const auj = jourParis(now);
    const lignes = [];
    let somme = { entrees: 0, premieres: 0, sorties: 0, partielles: 0, recus: 0, partis: 0 }, premier = null, dernierN = null;
    for (let k = JOURS_RELEVE; k >= 1; k--) {
      const j = jourPlus(auj, -k), p = S.photos[j], pv = S.photos[jourPlus(j, -1)];
      if (!p) { lignes.push(`${jourCourt(j)}  ${'–'.padStart(4)}`); continue; }
      if (premier === null && pv) premier = pv.detenteurs;
      if (premier === null) premier = p.detenteurs;
      dernierN = p.detenteurs;
      const delta = pv ? `(${signe(p.detenteurs - pv.detenteurs)})` : '';
      lignes.push(`${jourCourt(j)}  ${(String(p.detenteurs).padStart(4) + ' ' + delta).padEnd(11)}${String(p.entrees).padStart(4)}${String(p.sorties).padStart(6)}  ${p.horsPools === null ? '–' : p.horsPools.toFixed(1) + '%'}`);
      somme.entrees += p.entrees; somme.premieres += p.premieres; somme.sorties += p.sorties; somme.partielles += p.partielles || 0;
      somme.recus += p.recus || 0; somme.partis += p.partis || 0;
    }
    const croissance = premier !== null && dernierN !== null ? dernierN - premier : null;
    /* « New » et « Left » ne comptent que le MARCHE (voir passages) ; les
       autres passages du seuil sont dits « by transfer ». La poussiere et le
       compte brut sont calcules ici (relecture du 12/10 : « ~540 » et « ~700 »
       etaient ecrits en dur, les chiffres du 11/10). */
    return `📈 <b>$SWOGE community · daily report</b>\n` +
      `<b>${c.detenteurs}</b> holders now${d === null ? '' : ` (${signe(d)} in 24h)`} · <b>${c.horsPools === null ? '?' : c.horsPools.toFixed(1)}%</b> of supply outside pools\n` +
      `<pre>${'Day'.padEnd(8)}${'Holders'.padEnd(11)}${'New'.padStart(4)}${'Left'.padStart(6)}  Outside pools\n${lignes.join('\n')}</pre>\n` +
      `7 days: <b>${croissance === null ? '?' : signe(croissance)}</b> holders · ${somme.entrees} new (${somme.premieres} first-time) · ${somme.sorties} left · ${somme.partielles} partial sells · ${somme.recus} in / ${somme.partis} out by transfer\n` +
      `<i>Holder = a wallet with 1,000+ $SWOGE. New = bought from the market to 1,000+, Left = sold to the market below 1,000; airdrops, wallet moves, casino deposits and $SWOGEBET swaps count as transfers. ` +
      `Not counted: pools, the burn address, contracts, house wallets and ${c.poussiere.toLocaleString('en-US')} wallets under 1,000 (mostly airdrop dust) — trackers that count every balance show ${c.brut.toLocaleString('en-US')}.</i>`;
  }
  function releveDu(now, aEnvoyer) {
    const cr = xp().creneauDu(now, [C.heure], FUSEAU);
    if (!cr || S.releves[cr.jour]) return;
    const prevu = minuitParis(cr.jour) + (Number(C.heure.split(':')[0]) * 60 + Number(C.heure.split(':')[1])) * 60000;
    /* au changement d heure, `prevu` peut differer d une heure : on se fie au creneau */
    if (now - prevu > RELEVE_RETARD_MAX_MS + HEURE_MS) { S.releves[cr.jour] = { saute: now }; compte('relevesSautes'); console.log(`[communaute] releve du ${cr.jour} saute : plus de 3 h de retard`); return; }
    S.releves[cr.jour] = { t: now };
    compte('releves');
    aEnvoyer.push({ image: 'releve', legende: texteReleve(now), quoi: 'releve' });
  }
  /* `now` est l heure de la CHAINE traitee (un echange, ou le curseur), jamais
     en arriere : un Transfer de 23:59:58 traite apres un tic de 00:00:30 ne
     doit pas rouvrir la veille. */
  function photosDuJour(now) {
    const auj = jourParis(now);
    if (!S.jourCourant) { S.jourCourant = auj; return; }
    if (S.jourCourant >= auj) return;
    const fini = S.jourCourant, c = chiffres(), jj = S.jours[fini] || {};
    S.photos[fini] = { detenteurs: c.detenteurs, horsPools: c.horsPools, entrees: distinctesPersonnes(jj.entrees),
                       premieres: distinctesPersonnes(jj.premieres), sorties: distinctesPersonnes(jj.sorties),
                       recus: distinctesPersonnes(jj.recus), partis: distinctesPersonnes(jj.partis),
                       partielles: jj.partielles || 0, t: now };
    S.jourCourant = auj;
    const garde = (o, n) => { const k = Object.keys(o).sort(); for (const x of k.slice(0, Math.max(0, k.length - n))) delete o[x]; };
    garde(S.photos, 40); garde(S.jours, 12); garde(S.releves, 40);
  }
  function horaire(now) {
    const h = Math.floor(now / HEURE_MS) * HEURE_MS;
    if (!S.horaires.length || S.horaires[S.horaires.length - 1].t < h) S.horaires.push({ t: h, n: chiffres().detenteurs });
    S.horaires = S.horaires.filter((x) => x.t >= now - 50 * HEURE_MS);
  }
  function purge(now) {
    for (const a of Object.keys(S.dernier)) if (now - S.dernier[a] >= RECHARGE_MS) delete S.dernier[a];
    const k = Object.keys(S.annonces);
    if (k.length > 500) { k.sort((x, y) => S.annonces[x] - S.annonces[y]); for (const x of k.slice(0, k.length - 500)) delete S.annonces[x]; }
  }

  // ---------------------------------------------------------- le tic
  let enCours = false, prochainEssai = 0, ecartsLivre = 0;
  async function tic() {
    if (C.mode !== 'observe' && C.mode !== 'annonce') return { fait: 'off' };
    if (enCours) return { fait: 'occupe' };
    enCours = true;
    const aEnvoyer = [];
    try {
      if (!S) S = litEtat();
      MAISON = maisonSet();
      const now = deps.horloge();
      if (!S.construit) {
        if (now < prochainEssai) return { fait: 'attente' };
        /* La construction travaille sur un etat NEUF, qui ne garde que ce qui a
           deja ete dit (GARDES_CONSTRUCTION). Ratee, on revient a l ancien :
           aucun code, aucune piscine a moitie lus ne survit (relecture du 12/10 :
           un seul 503 figeait la paire hors des piscines pour toujours). */
        const ancien = S;
        S = etatNeuf();
        for (const k of GARDES_CONSTRUCTION) if (ancien[k] !== undefined) S[k] = ancien[k];
        try { await construit(); }
        catch (e) {
          ancien.appels = S.appels; ancien.refus429 = S.refus429; ancien.compteurs = S.compteurs;
          S = ancien;
          prochainEssai = now + REESSAI_CONSTRUCTION_MS;
          console.log('[communaute] construction ratee, nouvel essai dans 10 min : ' + String(e && e.message).slice(0, 200));
          return { fait: 'echec', erreur: e.message };
        }
        S.jourCourant = jourParis(now);
        ecritEtat();
        return { fait: 'construit', ...chiffres() };
      }
      const tip = await pointe();
      ancre(tip.bloc, tip.t);
      const jusqua = tip.bloc - CONFIRMATIONS;
      let n = 0, nTx = 0;
      if (jusqua > S.curseur) {
        const txs = regroupe(await lisLogs(S.curseur + 1, jusqua, filtreJeton()), S.curseur);
        nTx = txs.length;
        const recus = await prepare(txs);
        for (const tx of txs) {
          const t = tip.t - (tip.bloc - tx.b) * CADENCE_MS;
          /* la photo d une journee finie se prend AVANT le premier echange du
             lendemain, pas au tic suivant : sinon elle compte deja la nuit */
          photosDuJour(t);
          const { net, avant } = applique(tx);
          const k = genreDe(tx, net, avant, recus, true);
          if (k) {
            compte('genre_' + k.genre);
            const jj = jourDe(jourParis(t));
            if (k.genre === 'partielle') jj.partielles++;
            if (k.genre === 'nouveau' || k.genre === 'retour' || k.genre === 'believer') jj.achats++;
            if (k.genre === 'paper' || k.genre === 'partielle') jj.ventes++;
          }
          passages(net, avant, t, k);
          if (k && (k.genre === 'nouveau' || k.genre === 'retour' || k.genre === 'believer' || k.genre === 'paper')) {
            n++;
            await trie(Object.assign({ h: tx.h, t, ligne: ligneCommunaute(now), usd: null }, k), now, aEnvoyer);
          }
        }
        S.curseur = jusqua;
      }
      videHeure(now, aEnvoyer);
      /* la journee se ferme quand la chaine TRAITEE passe minuit (le curseur),
         pas quand l horloge du serveur y passe : un echange de 23:59:58 encore
         sous les 50 blocs de marge appartient a la veille */
      photosDuJour(tip.t - (tip.bloc - S.curseur) * CADENCE_MS);
      horaire(now);
      releveDu(now, aEnvoyer);
      purge(now);
      /* Le recoupement avec la chaine (voir l en-tete) : quand un echange vient
         d etre lu, avant tout envoi, et au moins une fois par heure. Un ecart :
         rien ne part, ce tic est rejoue depuis le disque. Un ecart qui persiste
         au tic suivant : le livre du disque est faux, on reconstruit. */
      const heureC = Math.floor(now / HEURE_MS);
      if (nTx || aEnvoyer.length || S.controleH !== heureC) {
        const ctl = await controleLivre(S.curseur);
        if (ctl.ecarts.length) {
          if (++ecartsLivre >= 2) {
            S = litEtat();
            S.construit = false;
            compte('reconstructions');
            ecritEtat();
            ecartsLivre = 0;
            console.log(`[communaute] livre different de la chaine deux tics de suite (${ctl.ecarts.join(' ; ')}) : reconstruction depuis la frappe, rien d annonce d ici la`);
            return { fait: 'reconstruction', ecarts: ctl.ecarts };
          }
          throw new Error('livre different de la chaine au bloc ' + S.curseur + ' (' + ctl.ecarts.join(' ; ') + ') : rien n est envoye, tic rejoue');
        }
        /* illisible (etat trop ancien, replique en retard) : on ne conclut pas
           sur une panne ; compte `controlesIllisibles`, nouvel essai a l heure
           suivante ou au prochain envoi */
        ecartsLivre = 0;
        S.controleH = heureC;
      }
      ecritEtat();                                   // AVANT tout envoi : rien ne part deux fois
      for (const m of aEnvoyer) envoie(m.image, m.legende, m.quoi);
      return { fait: 'tic', evenements: n, envoyes: aEnvoyer.length };
    } catch (e) {
      /* L etat en memoire a peut-etre applique une partie des Transfer : on le
         relit du disque (dernier etat entier) au prochain tic, qui reprendra
         au curseur ecrit — jamais un Transfer applique deux fois. */
      S = null;
      const m = String((e && e.message) || e).slice(0, 160);
      console.log('[communaute] tic : ' + m);
      return { fait: 'erreur', erreur: m };
    } finally { enCours = false; }
  }

  // ---------------------------------------------------------- les images
  async function images() {
    if (C.mode !== 'annonce' || !deps.imageCle) return { fait: 'rien' };
    const gen = deps.genereImage || ((p) => xp().genereImageVerifiee(p, deps.prendre, 2));
    const J = litImages();
    const faites = [];
    for (const g of GENRES_IMAGE) {
      const nom = g + '-' + VERSION_IMAGES, f = path.join(DOSSIER_IMAGES, nom + '.png');
      if (fs.existsSync(f)) continue;
      const j = J[nom] || (J[nom] = { essais: 0, jetons: 0, coutUsd: 0 });
      if (j.essais >= ESSAIS_IMAGE_MAX) continue;
      j.essais++; j.quand = new Date(deps.horloge()).toISOString();
      ecritImages(J);                                // l essai est compte AVANT l appel
      try {
        const r = await gen(xp().promptImage(SCENES[g], 'communaute-' + g + '-' + VERSION_IMAGES));
        fs.mkdirSync(DOSSIER_IMAGES, { recursive: true });
        fs.writeFileSync(f + '.tmp', r.png); fs.renameSync(f + '.tmp', f);
        j.jetons += r.jetons || 0;
        j.coutUsd = Math.round(((r.jetons ? r.jetons * USD_PAR_JETON_IMAGE : COUT_IMAGE_USD)) * 1000) / 1000;
        j.pattes = r.controle || null; j.fichier = nom + '.png'; delete j.erreur;
        faites.push(g);
        console.log(`[communaute] image ${nom} generee (essai ${j.essais}/${ESSAIS_IMAGE_MAX}, ${r.jetons || '?'} jetons ~ ${j.coutUsd} $, ${j.pattes || 'controle ?'})`);
      } catch (e) {
        j.erreur = String((e && e.message) || e).slice(0, 160);
        console.log(`[communaute] image ${nom} ratee (essai ${j.essais}/${ESSAIS_IMAGE_MAX}, au pire ${j.essais * 2 * COUT_IMAGE_USD} $) : ${j.erreur} — annonce en texte seul`);
      }
      ecritImages(J);
    }
    return { fait: 'images', faites };
  }

  function ligneDemarrage() {
    if (C.mode === 'off') return '[communaute] ETEINT (TG_COMMUNAUTE vide) : aucune requete, aucune annonce';
    if (C.mode === 'inconnu') return `[communaute] TG_COMMUNAUTE=${C.brut} inconnu (« observe » ou « 1 ») : RIEN ne tourne`;
    const base = `releve de la chaine toutes les ${TIC_MS / 1000} s (noeud officiel, 0 cle), releve quotidien ${C.heure} ${FUSEAU}` +
      (C.heureBrute !== C.heure ? ` (TG_COMMUNAUTE_HEURE=${C.heureBrute} illisible)` : '') +
      `, detenteur >= 1 000 $SWOGE, seuils new ${MIN_USD.nouveau} $ / believer ${MIN_USD.believer} $ / paper ${MIN_USD.paper} $, 1 annonce par adresse et par famille en 24 h, ${PLAFOND_HEURE}/h, rien au-dela de 30 min de retard` +
      (C.exclus.length ? `, ${C.exclus.length} adresse(s) exclue(s) en plus` : '');
    if (C.mode === 'observe') return `[communaute] OBSERVATION (TG_COMMUNAUTE=observe) : ${base} — n annonce rien, aucune image`;
    return `[communaute] ANNONCES ARMEES (TG_COMMUNAUTE=1) sur le canal public : ${base} ; images ${deps.imageCle ? 'generees une fois (OPENAI_API_KEY posee)' : 'absentes : OPENAI_API_KEY non posee, texte seul'}`;
  }

  return {
    config: C, tic, images, ligneDemarrage,
    etat: () => { if (!S) S = litEtat(); return S; },
    journalImages: () => litImages(),
    chiffres: () => { if (!S) S = litEtat(); return chiffres(); },
    texteReleve: (now) => { if (!S) S = litEtat(); return texteReleve(now); },
    ligneCommunaute: (now) => { if (!S) S = litEtat(); return ligneCommunaute(now); },
  };
}

/**
 * Le branchement (server.js). Inerte — aucune minuterie, aucune requete,
 * aucun fichier — si TG_COMMUNAUTE est vide ou inconnu. Rend
 * { tic, images, arrete, actif, instance }.
 */
function planifie(deps) {
  const I = cree(deps);
  console.log(I.ligneDemarrage());
  const inerte = { tic: async () => ({ fait: 'off' }), images: async () => ({ fait: 'rien' }), arrete() {}, actif: false, instance: I };
  if (I.config.mode !== 'observe' && I.config.mode !== 'annonce') return inerte;
  let minuterie = null, premier = null;
  if (!deps || deps.minuteries !== false) {
    /* Les images d abord, en arriere-plan et l une apres l autre ; le premier
       tic 20 s apres le demarrage, puis toutes les 60 s. */
    I.images().catch((e) => console.log('[communaute] images : ' + (e && e.message)));
    premier = setTimeout(() => { I.tic(); }, 20000); if (premier.unref) premier.unref();
    minuterie = setInterval(() => { I.tic(); }, TIC_MS); if (minuterie.unref) minuterie.unref();
  }
  return { tic: () => I.tic(), images: () => I.images(), actif: true, instance: I,
           arrete() { if (minuterie) clearInterval(minuterie); if (premier) clearTimeout(premier); minuterie = premier = null; } };
}

/** L image d un genre, pour la route publique ; null si le nom est douteux ou absent. */
function litImage(nom, dossier) {
  if (!NOM_IMAGE.test(String(nom || ''))) return null;
  try { return fs.readFileSync(path.join(dossier || require('./config').DATA_DIR, 'communaute_images', nom + '.png')); }
  catch (e) { return null; }
}

module.exports = {
  config, cree, planifie, litImage,
  SEUIL_DETENTEUR, MIN_USD, RECHARGE_MS, PLAFOND_HEURE, RETARD_MAX_MS, TIC_MS, CONFIRMATIONS, CADENCE_MS,
  HEURE_RELEVE, FUSEAU, JOURS_RELEVE, PM4, PAIRE_PRIX, BLOC_FRAPPE, FENETRE_LOGS, BRULES, TOPIC_TRANSFER, TOPICS_LIQUIDITE,
  TOPIC_MODIFY_V4, WETH, USDG, VALEUR, LOT_RECUS,
  SCENES, GENRES_IMAGE, VERSION_IMAGES, ESSAIS_IMAGE_MAX, COUT_IMAGE_USD, ESPACE_RPC_MS, LOT_CODES, ESPACE_LOTS_MS,
  minuitParis, jourParis, fmtJetons,
};
