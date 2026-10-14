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
 *
 * ---- LA SUITE (proprietaire, 12/10/2026) ----
 *
 * « Une notif une fois par jour en plus : combien de holders, believers,
 * jeets et nouveaux, en resume, et combien de pour-cent la chart a pris depuis
 * une semaine. Et les notifs quand quelqu un vend ou achete : dire s il
 * rajoute dans son wallet, s il lui en reste encore, s il a vendu en gain ou a
 * perte. Nouveau wallet, ou s il est relie a d autres : combien il a en tout
 * et ses wallets quand il achete. »
 *
 * Sonde du 12/10/2026, 03:26-03:46 UTC, noeud officiel seulement (8 326
 * Transfer, 5 723 Sync de la paire v2, bloc 86 356 865) ; chaque regle porte
 * sa mesure plus bas. En bref :
 *  - le RESUME est le releve de 13:00, enrichi (deux messages repeteraient le
 *    compte des detenteurs) : dernieres 24 h, 7 jours, et le cours sur 7 jours
 *    lu sur la CHAINE (Sync de la paire v2 en ETH, × ETH/USD d une piscine v3
 *    WETH/USDG pour le $) — voir COURS ;
 *  - le GAIN OU LA PERTE d une vente se lit contre le prix d achat moyen de CE
 *    portefeuille, rejoue depuis la frappe avec la jambe WETH de chaque achat
 *    (Sync de la paire = Transfer WETH dans 5 723 tx sur 5 723) — voir COUT ;
 *    sans prix d achat connu, on l ecrit : « unknown » ;
 *  - un portefeuille NEUF : il a signe lui-meme, nonce de la tx d achat <= 2,
 *    premiere apparition sur le $SWOGE — voir NEUF ;
 *  - des portefeuilles RELIES : au moins 1 000 $SWOGE envoyes directement de
 *    l un a l autre (aucune piscine dans la tx), carrefours coupes, « not
 *    proof of a single owner » — voir LIENS ;
 *  - les ventes PARTIELLES s annoncent desormais (>= 25 $ et >= 10 % du sac,
 *    famille a part) — voir MIN_USD.
 * Trois verifications du 12/10 (non-regression, mutations, relecture) : la
 * migration s arrete au curseur de l ancien etat (rien d avale pendant le
 * redeploiement), la poussiere ne relie plus, un achat garde en partie ne
 * double plus le prix moyen, le releve tient sous 1 024 signes a l envoi, les
 * 7 jours comptent des portefeuilles, le % du cours est arrondi comme les
 * autres — chaque regle porte sa mesure la ou elle vit.
 * « Jeets » du proprietaire = nos « paper hands » (vente qui laisse moins de
 * 1 000) : les annonces disent deja « Paper hand », le resume garde le meme mot
 * pour la meme chose.
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

/* ---- COURS : LE % DU GRAPHIQUE SUR 7 JOURS, LU SUR LA CHAINE ----
 * Sync(uint112,uint112) de la paire v2 (token0 = WETH, token1 = $SWOGE :
 * 0x0bd7… < 0x8a16…, tri v2, et cours_chaine.js) : prix en ETH = reserve0 /
 * reserve1, apres chaque echange. Le % compare le DERNIER Sync (maintenant) au
 * dernier Sync anterieur a maintenant − 168 h (le prix spot a cet instant : pas
 * d echange = prix inchange en ETH). Sonde du 12/10 vers 03:40 UTC : 1,15739e-8
 * → 1,48707e-8 ETH, +28,49 % ; au meme instant DexScreener donne 1,487e-8
 * (h1 +1,28 contre +1,37 ; h6 −20,79 contre −20,69). Sur ce jeton le
 * chiffre depend fortement de l instant de reference (h6 −20,8 %) : la
 * definition est ecrite telle quelle, « now vs. 7×24 h ago ».
 * En $ : × ETH/USD de la piscine v3 WETH/USDG 0x52e65b17… (20,3 M$ de
 * liquidite, 98,9 M$ de volume 24 h ; token0 WETH 18 decimales, token1 USDG 6,
 * lus par decimals() sur la chaine), sqrtPriceX96 du dernier Swap dans les
 * 3 000 blocs (~5 min) avant chaque instant : 1 eth_getLogs, ~0,9 s, 28 Swap
 * dans la fenetre (sonde, p2_prix.js). Le 12/10 : 2 703,06 → 2 543,15 $, soit +20,88 % en $
 * (DexScreener : ETH 2 540,69 au meme instant). Ecartes : GeckoTerminal (sa
 * cloture horaire est un prix d EXECUTION, 2,4 % d ecart au spot, et son
 * quota est partage avec la colonie), DexScreener (pas de champ 7 jours).
 * Construction : 9 eth_getLogs sur la paire seule (Sync, une valeur par
 * position) depuis la frappe, 5 724 journaux, 3,16 Mo, 8,9 s, 0 refus. En
 * regime : 0 appel, le Sync est dans le recu deja lu ; le releve fait 2
 * eth_getLogs par jour sur la v3 WETH/USDG. Sans ETH/USD lisible : le % en
 * ETH seul ; sans Sync anterieur a −168 h : pas de ligne. */
const TOPIC_SYNC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';   // Sync(uint112,uint112)
const TOPIC_SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'; // Swap(address,address,int256,int256,uint160,uint128,int24)
const PISCINE_ETH_USD = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca';   // v3 WETH/USDG
const DECIMALES_USDG = 6;
const FENETRE_ETH_USD = 3000;
/* garde de vraisemblance sur un ETH/USD lu (un Swap mal forme ne fait pas un % faux) */
const ETH_USD_MIN = 100, ETH_USD_MAX = 100000;
const COURS_GARDE_MS = 8 * 24 * 3600 * 1000;   // 8 jours de Sync, plus le dernier d avant

/* ---- COUT : LE PRIX D ACHAT MOYEN D UN PORTEFEUILLE ----
 * Rejoue depuis la frappe : un achat de marche ou SEULE la paire v2 bouge et
 * dont le portefeuille est le beneficiaire ajoute (jetons recus, WETH entre
 * dans la paire) ; toute autre entree est a cout INCONNU (envoi, airdrop,
 * conversion, v4 en ETH natif, achat partage entre deux piscines) ; toute
 * sortie retire au prorata. Prix de vente = WETH sorti de la paire / jetons
 * cedes par le vendeur.
 * Sonde du 12/10 : 77 ventes en 30 jours, toutes par la v2 ; la part du sac a
 * cout connu vaut = 100 % pour 68, >= 99 % pour 69, >= 90 % pour 69, 0 % pour
 * 6 (sacs recus par envoi). Seuil 99 % : 69 ventes sur 77 ont un prix d achat
 * (90 %), 33 sur 36 en 7 jours (92 %) ; 41 en gain, 28 en perte, mediane
 * +2,6 %. L historique ENTIER est necessaire : avec 8 jours seulement, 27 sur
 * 36 (75 %).
 * En ETH, pas en $ : converti avec la cloture ETH du jour, le signe change pour
 * 5 ventes sur 69 (−20,1 % en ETH = +12,6 % en $) — on ecrit « in ETH ».
 * LES FRAIS D INTERFACE (relecture du 12/10, tx ou seule la paire v2 bouge,
 * net du beneficiaire / net de la paire) : a la VENTE ils sont pris en $SWOGE
 * au vendeur (0x5a3482…, 0xc06ebb…, 0x4acb6c…) — son net depasse le flux de
 * la paire de 0,5 a 2 % dans 34 ventes sur 79 en 30 jours, de 1,0101 au plus
 * sur les 2 206 ventes de l histoire ; le prix de vente ci-dessus les COMPTE
 * (gain ou perte net pour le vendeur, ~0,9 point de moins). A l ACHAT le net de
 * l acheteur vaut le flux (123 achats sur 124 en 30 jours, jamais au-dessus sur
 * 3 494) : des frais d achat pris en ETH AVANT la paire, s il y en a, ne se
 * voient pas. Pres de zero le signe ne dit donc rien : 11 ventes sur 69 dans
 * ±1 % ; on ecrit « about break-even » dans ±1 %.
 * ACHAT GARDE EN PARTIE (mutant du 12/10 : un achat dont la moitie repart dans
 * la meme tx doublait le prix moyen, puis « Sold at a loss: -50% » pour une
 * revente au meme prix) : l acheteur n est credite que de SA part de la jambe
 * ETH, jambe × min(gardes, flux) / flux ; ce qu il recoit au-dela du flux est
 * a cout inconnu. Histoire : 48 achats sur 3 494 sous 0,999 du flux (min
 * 0,874), 1 sur 124 en 30 jours (0,990). VENTE MELEE : un vendeur qui cede
 * plus que le flux × (1 + FRAIS_VENTE_MAX) a envoye des jetons ailleurs dans
 * la meme tx — prix de vente illisible, dit tel quel (0 vente sur 2 206 au-dela
 * de 1,05 ; frais mesures 1,0101 au plus). Un vendeur qui cede MOINS que le
 * flux (un second vendeur dans la tx, 0 sur 2 206) : prix = jambe / flux. */
const PART_CONNUE_MIN = 0.99;
const EQUILIBRE_PCT = 1;
const FRAIS_VENTE_MAX = 0.05;

/* ---- NEUF : UN PORTEFEUILLE QUI N A JAMAIS SERVI ----
 * Le nonce de la TX D ACHAT = le nombre de transactions signees avant elle,
 * exact a l instant de l achat (le noeud n est pas une archive :
 * eth_getTransactionCount refuse au-dela de pointe − 1 000 blocs, sonde du
 * 12/10). Il ne dit rien d un achat RELAYE : 67 achats sur 123 en 30 jours
 * (54 %) sont signes par un autre (EntryPoint 4337, solveurs) ; 9 acheteurs
 * relayes ont un nonce de 1 et achetent pourtant souvent. Donc « Fresh wallet »
 * seulement si l acheteur a SIGNE (receipt.from), nonce <= 2, et premiere
 * apparition sur le $SWOGE (9 acheteurs a nonce <= 2 y etaient deja).
 * Premieres entrees qui signent, 30 jours : nonces 0, 0, 0, 2, 6, 52, 80, 350,
 * 418, 496, 798, 1 445 — la coupure tombe entre 2 et 6. Resultat : 4 acheteurs
 * sur 49 en 30 jours. Cout : 1 eth_getTransactionByHash par candidat ANNONCE
 * (~0,4 par jour). */
const NONCE_NEUF_MAX = 2;

/* ---- LIENS : DES PORTEFEUILLES RELIES PAR UNE PREUVE SUR LA CHAINE ----
 * Un Transfer $SWOGE direct de personne a personne dans une transaction qui ne
 * touche AUCUNE piscine. Ni les piscines, ni les contrats (routeurs,
 * agregateurs), ni la maison, ni le brule, ni le signataire d un achat relaye
 * (31 signataires pour 67 achats relayes, 17 servent plusieurs acheteurs) ne
 * font un lien. Sonde du 12/10, historique entier : 161 envois reels hors
 * airdrop, 103 couples, 79 envois vers un portefeuille qui apparait pour la
 * premiere fois (le profil d un deplacement vers son propre portefeuille).
 * Degres (voisins personnes distincts) : 147 a 1, 14 a 2, 6 a 3, puis trois
 * carrefours — l envoyeur de l airdrop 0xe20bb824… (537), un collecteur
 * 0x960b… (7), un robot 0x0e66… (6). Sans plafond, un groupe de 20 enchaine par
 * ces carrefours ; plafond de degre <= 5 : 73 groupes (62 paires, 7 triplets,
 * 2 de 4, 2 de 5), acheteurs relies 7 sur 49 en 30 jours, 3 sur 35 en 7 jours.
 * Un lien prouve un transfert, pas un meme proprietaire (cadeau, paiement,
 * OTC) : relecture du 12/10, 164 envois directs (hors airdrop et maison), 79
 * vers un portefeuille NEUF, 85 vers un portefeuille deja vu. Le texte dit
 * « linked by direct $SWOGE transfers » et, apres le total, « not proof of a
 * single owner » — jamais « same owner ».
 * LA POUSSIERE NE FAIT PAS UN LIEN (mutant du 12/10 : un tiers qui envoyait
 * 0,000001 $SWOGE a un acheteur entrait dans sa ligne 🔗 et dans son total —
 * une action de l envoyeur seul). Un envoi ne relie que s il porte au moins
 * SEUIL_LIEN = 1 000 $SWOGE, le seuil de detenteur. Mesure (histoire entiere,
 * 164 envois) : 0 envoi nul, 1 seul sous 1 000 (0,03 jeton, juillet), 3 a
 * 1 000 pile (envois d essai vers un portefeuille neuf, gardes), mediane
 * 8,7 M, p10 673 049. Un envoi plus petit mais non nul compte pour le DEGRE
 * (le distributeur de l airdrop, 537 envois de 278,294, reste un carrefour ;
 * un poudreur qui vise plus de 5 adresses en devient un) ; un Transfer de 0
 * jeton (faisable sans la signature de l envoyeur) ne compte pour rien.
 * Reste possible, et dit : envoyer 1 000 jetons (~0,05 $) a un acheteur pour
 * apparaitre dans sa ligne — au plus 5 cibles avant d etre un carrefour.
 * Affichage : le groupe (au plus 5 portefeuilles, la taille maximale mesuree),
 * le total, 3 adresses courtes au plus. 0 appel en regime. */
const DEGRE_MAX = 5;
const GROUPE_MAX = 5;
const SEUIL_LIEN = 1000n * E18;                  // = SEUIL_DETENTEUR (plus bas)

/* La version de l etat qui porte tout ce qui precede : un etat ecrit avant (sans
   couts, liens, cours) est RECONSTRUIT une fois, en gardant ce qui a deja ete
   dit (annonces, recharges, releves) — jamais remis a neuf (VERSION_ETAT).
   3 (12/10/2026) : `tenue` (voir TENUE) — un etat au schema 2 n a pas l heure
   d entree de ses detenteurs, il est reconstruit une fois.
   4 (13/10/2026) : l entree devient { t, b, h, q, comment, de, origine, n, qa }
   (voir ENTREE) — un etat au schema 3 n a que l heure (un nombre), ni la tx ni le
   chemin : il est reconstruit une fois depuis la frappe (~3 min sans annonce,
   bornee au curseur de l ancien etat comme les migrations d avant). Tant que
   la reconstruction n a pas abouti, un nombre se lit comme { t } : la duree
   reste dite, la ligne d entree ne l est pas (rien d invente). */
const SCHEMA = 4;

/* ---- TENUE : DEPUIS QUAND IL TENAIT (12/10/2026) ----
 * Le proprietaire, sur une annonce « Paper hand » : « tu pourrais rajouter ca
 * fait combien de jours qu il hold, ou une phrase drole ». `tenue` : adresse →
 * l heure (ms) ou elle a PASSE le seuil de detenteur pour la derniere fois,
 * par n importe quel chemin (achat, envoi, airdrop) ; effacee quand elle
 * redescend sous le seuil. Une paper hand dit donc depuis combien de temps elle
 * tenait CETTE fois (« and left after 12 days »), lu AVANT l effacement.
 * L heure d un bloc ancien ne s extrapole pas depuis la pointe : mesure du
 * 12/10 sur le RPC officiel, de la frappe (07/07) a la pointe en 10 segments,
 * la cadence moyenne varie de 100,13 a 102,42 ms/bloc ; extrapoler a 103,54 ms
 * depuis la pointe tombe 62,6 h trop tot au bloc 3 700 000. La construction pose
 * donc des ancres reelles depuis la frappe (une tous les ~10 jours, ANCRE_PAS),
 * en plus des 9 quotidiennes : ~9 eth_getBlockByNumber de plus, dans le meme
 * lot. Deux segments voisins different d au plus 0,9 ms/bloc, soit ~2 h sur
 * 10 jours au pire : au-dela de 48 h la duree s ecrit en JOURS arrondis. */
const ANCRE_PAS = 8640000;                        // ~10 jours a ~100 ms/bloc

/* ---- ENTREE : QUAND ET COMMENT IL ETAIT ENTRE (13/10/2026) ----
 * Le proprietaire, sur l annonce « 0x7a1d…165f sold 21.7M $SWOGE (~$745) and
 * left after 9 days » : « donne le wallet ou ca a ete achete, la ca a ete
 * transfere d un wallet vers un autre et ensuite il a seulement vendu ; dis a
 * quelle heure, comme ca on retrouve la TX dans l explorateur ».
 * Sonde du 13/10 (RPC officiel, 93 appels, 0 refus ; pointe 87 402 126 a 09:20
 * UTC ; 8 394 Transfer, 5 746 Sync depuis la frappe) :
 *  - le cas : l entree de 0x7a1d…165f (tx 0x1963a383…, 2026-10-03 22:03:01 UTC)
 *    est un ACHAT a la paire v2 : paire → 0x09215a47… → 0xb92fe925… → 0x7a1d,
 *    les deux intermediaires sont des contrats (22 390 et 4 720 octets de code,
 *    net nul), la tx est signee par un relais. L explorateur montre le jeton
 *    arriver « de 0xb92fe925… » : c est le dernier saut d un routeur, pas un
 *    autre wallet ;
 *  - 118 detenteurs (personnes >= 1 000) : 86 entres par un achat (72,9 %), 18
 *    par envoi d une personne (15,3 %) dont 17 d un portefeuille entre lui-meme
 *    par un achat (16 a un saut, 1 a deux), 14 autrement (11 portefeuilles de
 *    frais passes a 1 000 dans l echange d un autre, un echange $SWOGEBET
 *    partage avec un contrat, un retrait de liquidite v4 — launchpad, 20 pools —
 *    et un retrait du coffre du casino) ;
 *  - 53 paper hands en 30 jours : entree par achat 48 (90,6 %), par envoi d un
 *    portefeuille qui avait achete 3 (5,7 %), autre 2, inconnue 0 ; aucune
 *    entree par achat dont le sac serait venu ensuite surtout par envoi (0/53) ;
 *  - l heure gardee est INTERPOLEE entre les ancres (voir TENUE) : sur 140 blocs
 *    d entree et d origine, minute juste pour 27 seulement, ecart median 1,7
 *    min, maximum 54 min. « UTC a la minute » se LIT donc dans l en-tete du bloc,
 *    au moment d annoncer : un lot de 1 ou 2 eth_getBlockByNumber par paper hand
 *    qui part (~2,7 par jour), rien pour celles que les seuils taisent.
 * L entree d un detenteur (S.tenue) : { t (ms, l heure gardee), b (bloc), h
 * (tx), q, comment, de, origine, n, qa }. `q` : ce que la tx d entree lui a
 * apporte (son net, en wei, une chaine). `comment` : « achat » si la personne
 * est le BENEFICIAIRE d un achat de marche dans cette tx (la regle de classe, la
 * meme que les annonces) ; « envoi » si la tx ne touche aucune piscine et n a
 * qu UNE adresse a net negatif, une personne, `de` ; absent sinon (frais pris
 * dans l echange d un autre, conversion, liquidite, contrat ou maison qui
 * envoie, plusieurs envoyeurs) — l heure et la tx restent, le comment ne
 * s invente pas. Hors de la fenetre des recus (8 jours), la construction classe
 * sans recu : piscines de marche par S.autres (WETH, USDG ; pas le v4), la
 * liquidite de la paire par ses Sync — comme le prix d achat moyen (COUT).
 * Relecture du 13/10 (cache de la relecture, toute l histoire rejouee, 0 appel ;
 * script correctifs/mesure_regles.js) :
 *  - L ENVOYEUR (A1, E5). « Le plus grand net negatif » pouvait nommer un wallet
 *    qui n avait rien envoye a l entrant : P1 envoie a X, P2 a Q dans la meme tx
 *    (un lot de relais, un bundle 4337 — 17 detenteurs entres par EntryPoint),
 *    Q etait annonce « received from P1 ». Un SEUL net negatif, par la
 *    conservation des jetons, est la source de tout ce qui arrive dans la tx,
 *    routeurs a net nul compris. Mesure : 144 entrees par envoi sous l ancienne
 *    regle, 144 sous la nouvelle (0 perdue) ; 0 tx sans piscine a plusieurs nets
 *    negatifs dans les 8 394 de l histoire.
 *  - L ORIGINE A UN SAUT (E2). `origine` : { h, b, t, qui, part, n } de l achat
 *    qui a fait entrer l envoyeur, lu AVANT que l envoi ne l efface. `n` et `qa`
 *    de l envoyeur : ses achats pendant la tenue apres l entree, et tout ce
 *    qu ils lui ont apporte, entree comprise. `part` : « entiere » si son achat
 *    d entree couvre ce qu il envoie (q >= recu) ; « achats » si ses achats de la
 *    tenue le couvrent ensemble (n plus) ; « partie » sinon. Mesure, 137
 *    entrees a un saut d un acheteur dans l histoire : 54 entiere, 82 achats
 *    (tous couverts par la somme), 1 partie ; detenteurs actuels : 2 sur 16 pas
 *    en entier (0x5520… ← 0x7509…, deux achats ; 0xd0f7… ← 0xeb22…, trois) ;
 *    paper hands des 30 jours : 0 sur 3. Avant, « who bought on X » pointait le
 *    premier achat seul dans 83 cas sur 137.
 *  - DEUX SAUTS OU PLUS (E1). L origine de l envoyeur n est reprise que s il
 *    etait entre par envoi d un sac ENTIER (part « entiere ») et que sa tx
 *    d entree lui avait apporte au moins ce qu il envoie ; sinon la ligne
 *    s arrete a « received from ». Cas reel du 07/08 : 0x176a… entre par 35 097
 *    jetons venus de 0x1d1c… (origine 0x2197…), achete lui-meme 757 728 en 5 tx,
 *    envoie 792 826 a 0x838a… qui vend : l annonce nommait 0x2197… pour un sac
 *    achete a 95,6 % par 0x176a…. Mesure : 6 origines a plusieurs sauts dans
 *    l histoire, 5 gardees, la seule retiree est 0x838a…. « first » est ote : le
 *    lien n est pas toujours le premier achat de l acheteur (faux 2 fois sur 6).
 * Le texte : une ligne 📥 sous « and left after », jamais d accusation : on
 * decrit une tx et des wallets. Sans entree connue : aucune ligne. L envoyeur
 * et l acheteur d origine repassent par personne() au moment d annoncer (A2) :
 * une adresse devenue maison ou exclue (COMPTES_MAISON, TG_COMMUNAUTE_EXCLUS,
 * deployeur V4) n y est jamais nommee, comme dans les liens (groupe). */

/* ---- LES PISCINES, DETAILLEES (12/10/2026) ----
 * Le proprietaire, sur « 67.5% of supply outside pools » : « alors que je vois
 * 20 % qui restent dans le pool ; ce wallet 0xc129… contient du swoge car c est
 * quand t achetes du swogebet ». Mesure du 12/10 sur le RPC officiel :
 * circulation 986 590 882 (brule 13 409 118), paire v2 SWOGE/WETH 203 633 333
 * (20,64 %), v3 $SWOGEBET/SWOGE 0xc129… 116 754 480 (11,83 %), PoolManager v4
 * 47 987 (0,00 %) : 32,48 % en piscines, 67,52 % dehors — le chiffre etait
 * juste, le libelle ne disait pas que la piscine $SWOGEBET en est une. La
 * ligne dit donc chaque famille par l AUTRE jeton de la piscine (S.autres) :
 * WETH → « ETH », $SWOGEBET → « $SWOGEBET », le reste (PoolManager v4, USDG,
 * jetons du launchpad) → « other » ; une famille sous 0,05 % ne s ecrit pas.
 * Meme soir, le proprietaire : « rajoute combien il reste dans le pool
 * disponible a acheter » — le $SWOGE des piscines contre WETH, la ou l on
 * achete avec de l ETH (203,6 M le 12/10). Un AMM ne vend pas tout son stock au
 * meme prix : c est ce qu il contient, pas ce qu un achat obtiendrait. */
const SWOGEBET = '0xc0aed547862fba5d7d9fbf3cb14204cd756c8bea';  // = config.SWOGEBET_TOKEN, swogebet_achats.js
const PART_POOL_MIN = 0.05;

/* ---- LA PHRASE DE LA PAPER HAND (12/10/2026) ----
 * Meme demande. Une phrase moqueuse, jamais une insulte ni un mot grossier : le
 * bot parle au nom du projet sur le canal PUBLIC et vise un portefeuille reel.
 * Elle suit ce qui est LU (gain, perte, ou inconnu) pour ne jamais dire « sold
 * low » a quelqu un qui a vendu en gain ; choisie par le hash de la tx, donc la
 * meme a chaque rejeu. */
const BLAGUES_PAPER = {
  gain: ['Took the profit and skipped the rest of the workout. 🏋️',
         'Cashed out at the warm-up. The doge keeps lifting. 💪',
         'Sold the gym membership right before the gains. 🐕'],
  perte: ['Bought high, sold low. Leg day skipped again. 🦵',
          'Paper hands fold, swole hands hold. 💎',
          'Thanks for the cheap bags, ser. 🙏'],
  autre: ['One less hand, more doge for the rest of us. 🐕',
          'Paper hands detected. The pack keeps lifting. 💪',
          'Left the gym after the warm-up. 🏋️'],
};

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
 *  - Vente PARTIELLE (vente qui laisse 1 000 ou plus) : le vendeur reste
 *    detenteur, l appeler « paper hand » serait faux. Muette jusqu au 12/10 ;
 *    le proprietaire demande « s il lui en reste encore ». Sonde du 12/10, 30
 *    jours : 29 partielles (0,97 par jour, 3 au plus par jour), mediane 167 $,
 *    p25 25 $ ; 7 sous 25 $, 6 sous 10 % du sac (de 0 a 42 $) ; 16 sur 29
 *    suivies d une sortie totale du meme portefeuille, dont 7 en moins de
 *    24 h. Simulation 30 jours (10/10/25/25 $, recharge, 4/h) : production
 *    106 annonces (3,5/jour) ; partielles >= 25 $ ET >= 10 % du sac, FAMILLE
 *    A PART : 125 (4,2/jour, +19) ; >= 25 % du sac : 120, mais perd des ventes
 *    reelles (20 % a 99 $, 15 % a 167 $) ; meme famille que les paper hands :
 *    6 sorties totales de PLUS cachees (12 au lieu de 6) — rejete. Sur 7
 *    jours : 70 → 74 annonces. Retenu : >= 25 $ et >= 10 % du sac, sa famille.
 * Montants minimaux en DOLLARS (jetons × cours DexScreener) : un seuil en
 * jetons change de sens quand le cours bouge (+20 % sur 24 h le 11/10).
 * Tailles mesurees (sonde, 7 jours, jambe WETH × 2 533 $) : entrees mediane
 * 48,7 $ (p25 25,3), believers 38,0 $ (p25 19,4), paper hands 77,3 $ (p25
 * 48,6, minimum 11,95). Au rejeu, 10 $ ecarte 5 premieres entrees sur 26 (de
 * 1,44 a 6,49 $) et 2 retours sur 22 ; 25 $ ecarte 14 believers sur 39 —
 * surtout les micro-achats repetes de 0xb67a60… (9 sur 13 sous 25 $) — et 3
 * paper hands sur 28. */
const MIN_USD = { nouveau: 10, retour: 10, believer: 25, paper: 25, partielle: 25 };
const PARTIELLE_PART_MIN = 0.10;                  // part du sac vendue (voir plus haut)
/* les genres qui s annoncent, et ceux qui entrent dans le resume */
const GENRES_ANNONCES = new Set(['nouveau', 'retour', 'believer', 'paper', 'partielle']);
const EVTS_GARDE_MS = 8 * 24 * 3600 * 1000;
/* ---- UNE ANNONCE PAR ADRESSE ET PAR FAMILLE TOUTES LES 24 H ----
 * Familles : entree (new holder et welcome back), believer, paper hand, et
 * depuis le 12/10 vente partielle (sa famille : une partielle ne fait pas taire
 * la sortie totale qui suit — 0x1d4342, deux minutes plus tard, le 07/10).
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
/* La lecture FACULTATIVE des en-tetes d une paper hand (voir ENTREE) : 2 essais
   de 10 s au plus, 2 s entre les deux, rien apres le dernier. Relecture du
   13/10 : avec les 5 essais de 60 s et le recul de 5 a 80 s (rpcBrut), un noeud
   qui pend bloquait le tic ~455 s par paper hand, jusqu a 4 par tic (PLAFOND_HEURE)
   — tout l envoi, releve compris, retarde d ~30 min. Desormais ~24 s au pire
   par paper hand. Mesure du 13/10 (20 lots de 2 en-tetes au RPC officiel, 1 par
   seconde) : mediane 76 ms, 90e centile 134 ms, max 237 ms, 1 refus 429 sur 20
   — d ou un second essai : sans lui, ~1 ligne sur 20 perdrait son heure. */
const LECTURE_COURTE = { essais: 2, delaiMs: 10000, reculMs: 2000 };
/* l en-tete lu doit tomber a moins de 2 h de l heure gardee (relecture du 13/10,
   A3) : un noeud fautif (bon numero, horodatage 0 ou demesure) ecrivait
   « Jan 1, 1970 » ou « NaN » sur le canal. Ecart mesure entre l heure gardee et
   l en-tete : 54 min au plus sur 140 blocs (voir ENTREE). */
const ECART_ENTETE_MAX_MS = 2 * 3600 * 1000;
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
/* une vente partielle porte l image du papier qui s envole : aucune image
   nouvelle (le proprietaire paie chaque generation) */
const imageDuGenre = (g) => (g === 'retour' ? 'nouveau' : g === 'partielle' ? 'paper' : g);
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
/** Un pourcentage signe : une decimale sous 10 %, entier au-dela. */
function pct(x) {
  const a = Math.abs(x);
  const s = a < 10 ? a.toFixed(1) : Math.round(a).toLocaleString('en-US');
  return (x < 0 && s !== '0.0' ? '-' : '+') + s + '%';
}
const pluriel = (n, mot, pl) => `${n} ${n === 1 ? mot : (pl || mot + 's')}`;
/** Une duree de tenue lisible (voir TENUE) : minutes sous 2 h, heures sous
 *  48 h, jours arrondis au-dela (l interpolation des ancres vaut ~2 h). */
function dureeTenue(ms) {
  const min = Math.round(ms / 60000);
  if (min < 120) return pluriel(Math.max(1, min), 'minute');
  if (ms < 48 * 3600000) return pluriel(Math.round(ms / 3600000), 'hour');
  return pluriel(Math.round(ms / 86400000), 'day');
}
/** Une entree lue dans S.tenue (voir ENTREE) : un nombre (etat du schema 3) ne
 *  porte que l heure, { t } ; un objet sans heure lisible ne vaut rien. */
function entreeDe(x) {
  if (typeof x === 'number') return isFinite(x) ? { t: x } : null;
  if (!x || typeof x !== 'object' || typeof x.t !== 'number' || !isFinite(x.t)) return null;
  return x;
}
/** « Oct 3, 22:03 UTC » : l heure d un bloc en UTC, a la minute (jamais l heure
 *  locale du serveur) ; l annee seulement si elle differe de celle de `ref`. */
function heureUtc(t, ref) {
  const d = new Date(t);
  const an = typeof ref === 'number' && new Date(ref).getUTCFullYear() !== d.getUTCFullYear() ? `, ${d.getUTCFullYear()}` : '';
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MOIS[d.getUTCMonth()]} ${d.getUTCDate()}${an}, ${hh}:${mm} UTC`;
}
/** Le detail des piscines (voir LES PISCINES, DETAILLEES) : « · pools: 20.6% ETH · 11.8% $SWOGEBET ». */
function detailPools(parts) {
  if (!parts) return '';
  const l = [];
  if (parts.eth >= PART_POOL_MIN) l.push(`${parts.eth.toFixed(1)}% ETH`);
  if (parts.swogebet >= PART_POOL_MIN) l.push(`${parts.swogebet.toFixed(1)}% $SWOGEBET`);
  if (parts.autre >= PART_POOL_MIN) l.push(`${parts.autre.toFixed(1)}% other`);
  return l.length ? ` · pools: ${l.join(' · ')}` : '';
}
/** La phrase d une paper hand (voir BLAGUES_PAPER) : sa famille suit le gain
 *  ou la perte LUS, le choix le hash de la tx. */
function blaguePaper(ev) {
  const lu = ev && ev.venteLue && typeof ev.pnl === 'number' && isFinite(ev.pnl) && Math.abs(ev.pnl) >= EQUILIBRE_PCT;
  const l = BLAGUES_PAPER[lu ? (ev.pnl > 0 ? 'gain' : 'perte') : 'autre'];
  const h = /^0x[0-9a-fA-F]{6,}/.test(String(ev && ev.h)) ? parseInt(String(ev.h).slice(-6), 16) : 0;
  return l[h % l.length];
}
/** Prix en ETH d un Sync de la paire v2 (token0 = WETH, token1 = $SWOGE). */
function prixDeSync(data) {
  if (!/^0x[0-9a-fA-F]{128}/.test(String(data))) return null;
  const d = String(data).slice(2);
  const r0 = BigInt('0x' + d.slice(0, 64)), r1 = BigInt('0x' + d.slice(64, 128));
  return r1 > 0n ? Number(r0 * E18 / r1) / 1e18 : null;
}
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
    /* `schema` 1 = un etat d avant le 12/10 (le champ manquait) : la
       construction pose SCHEMA. `couts` : adresse → [jetons a cout connu, ETH
       payes pour eux, jetons a cout inconnu] (voir COUT). `liens` : adresse →
       voisins par envoi direct, DEGRE_MAX + 1 au plus (voir LIENS). `vus` :
       toute adresse deja passee dans un Transfer (voir NEUF). `coursW` :
       [heure, prix en ETH] du dernier Sync de chaque minute (voir COURS).
       `evts` : [heure, genre, adresse] des evenements de marche (resume 24 h). */
    return { v: VERSION_ETAT, schema: 1, construit: false, curseur: 0, soldes: new Map(), codes: {}, pools: new Set(), autres: {},
             deja: new Set(), jours: {}, photos: {}, horaires: [], ancres: [], annonces: {}, dernier: {},
             heure: null, releves: {}, prix: null, compteurs: {}, appels: 0, refus429: 0, jourCourant: null, controleH: null,
             couts: {}, liens: {}, vus: new Set(), coursW: [], evts: [], tenue: {} };
  }
  /* Ce qu une (re)construction garde de l etat precedent : ce qui a deja ete
     DIT (annonces, recharges, releves), les compteurs et le cours. Tout ce qui
     se deduit de la chaine (livre, codes, piscines, photos) repart de zero. */
  /* `heure` aussi (non-regression du 12/10) : remis a zero, il rouvrait le
     plafond de 4/h dans l heure de la bascule et perdait le message groupe d un
     surplus en attente. */
  const GARDES_CONSTRUCTION = ['annonces', 'dernier', 'releves', 'compteurs', 'appels', 'refus429', 'prix', 'heure'];
  function versDisque() {
    const soldes = {};
    for (const [a, b] of S.soldes) if (b !== 0n) soldes[a] = b.toString(16);
    return JSON.stringify({ v: S.v, construit: S.construit, curseur: S.curseur, soldes, codes: S.codes,
      pools: [...S.pools], autres: S.autres, deja: [...S.deja], jours: S.jours, photos: S.photos, horaires: S.horaires,
      ancres: S.ancres, annonces: S.annonces, dernier: S.dernier, heure: S.heure, releves: S.releves,
      prix: S.prix, compteurs: S.compteurs, appels: S.appels, refus429: S.refus429, jourCourant: S.jourCourant,
      controleH: S.controleH, schema: S.schema, couts: S.couts, liens: S.liens, vus: [...S.vus], coursW: S.coursW, evts: S.evts, tenue: S.tenue });
  }
  function depuisDisque(j) {
    const s = etatNeuf();
    if (!j || j.v !== VERSION_ETAT) return s;
    Object.assign(s, j);
    s.soldes = new Map(Object.entries(j.soldes || {}).map(([a, h]) => [a, h.startsWith('-') ? -BigInt('0x' + h.slice(1)) : BigInt('0x' + h)]));
    s.pools = new Set(j.pools || []);
    s.deja = new Set(j.deja || []);
    s.vus = new Set(j.vus || []);
    s.tenue = j.tenue && typeof j.tenue === 'object' ? j.tenue : {};
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
  /** `court` : LECTURE_COURTE pour une lecture facultative (moins d essais, un
   *  delai court, aucun recul apres le dernier) ; absent : 5 essais, comme avant. */
  async function rpcBrut(corps, court) {
    let derniere = '429';
    const essais = court ? court.essais : 5;
    const recule = async (essai) => {
      if (!court) { await deps.dors(RECUL_429_MS * 2 ** essai); return; }
      if (essai + 1 < essais) await deps.dors(court.reculMs);
    };
    for (let essai = 0; essai < essais; essai++) {
      const attente = dernierAppel + ESPACE_RPC_MS - Date.now();
      if (attente > 0) await deps.dors(attente);
      dernierAppel = Date.now();
      S.appels++;
      let r, j;
      try {
        r = await deps.prendre(deps.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(corps), signal: AbortSignal.timeout(court ? court.delaiMs : 60000) });
        j = await r.json().catch(() => null);
      } catch (e) {
        derniere = String((e && e.message) || e).slice(0, 80);
        await recule(essai);
        continue;
      }
      const msg = (x) => String((x && x.error && x.error.message) || '');
      const limite = r.status === 429 || (j && !Array.isArray(j) && /too many requests|rate limit/i.test(msg(j)))
        || (Array.isArray(j) && j.some((x) => /too many requests|rate limit/i.test(msg(x))));
      if (limite) { S.refus429++; await recule(essai); continue; }
      /* Relecture du 12/10 : UNE reponse 503 sans JSON faisait echouer toute la
         construction (sans reessai). Une page d erreur de passerelle est une
         panne passagere, comme un 429 : on recule et on redemande. */
      if (!j || r.status >= 500) { compte('pannesNoeud'); derniere = 'HTTP ' + (r && r.status) + (j ? '' : ' sans JSON'); await recule(essai); continue; }
      return j;
    }
    throw new Error('noeud : abandon apres ' + essais + ' refus ou pannes (' + derniere + ')');
  }
  async function rpc(method, params) {
    const j = await rpcBrut({ jsonrpc: '2.0', id: 1, method, params });
    if (j.error) { const e = new Error(String(j.error.message || 'erreur')); e.code = j.error.code; throw e; }
    return j.result;
  }
  /** Un lot : rend les resultats dans l ordre des appels ({ result } ou { error }). */
  async function lot(appels, court) {
    if (!appels.length) return [];
    const j = await rpcBrut(appels.map((a, i) => ({ jsonrpc: '2.0', id: i + 1, method: a[0], params: a[1] })), court);
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
    let n = 0, pools = 0n, frappe = 0n, brule = 0n, brut = 0, poussiere = 0, pEth = 0n, pBet = 0n, pAutre = 0n, nEth = 0;
    for (const [a, b] of S.soldes) {
      if (a === ZERO) { frappe = -b; continue; }
      /* `brut` : toute adresse a solde > 0, piscines, brulage et contrats
         compris — ce que comptent GoPlus et Blockscout (713 le 11/10, egal au
         rejeu). `poussiere` : les personnes sous le seuil (536 des 541 du 11/10
         tiennent l airdrop de 278,294). Le releve les CALCULE a l envoi : des
         chiffres ecrits en dur deviendraient faux sans que rien ne le dise. */
      if (b > 0n) brut++;
      if (BRULES.has(a)) { brule += b; continue; }
      if (S.pools.has(a)) {
        pools += b;
        const o = a === PM4 ? null : S.autres[a];
        if (o === WETH) { pEth += b; if (b > 0n) nEth++; } else if (o === SWOGEBET) pBet += b; else pAutre += b;
      } else if (b >= SEUIL_DETENTEUR && personne(a)) n++;
      else if (b > 0n && personne(a)) poussiere++;
    }
    const circulation = frappe - brule;
    const horsPools = circulation > 0n ? 100 * (1 - Number(pools * 1000000n / circulation) / 1e6) : null;
    const part = (x) => (circulation > 0n ? Number(x * 1000000n / circulation) / 1e4 : null);
    const partsPools = circulation > 0n ? { eth: part(pEth), swogebet: part(pBet), autre: part(pAutre) } : null;
    return { detenteurs: n, horsPools, partsPools, resteEth: jetons(pEth), piscinesEth: nEth,
             circulation: jetons(circulation), brule: jetons(brule), pools: jetons(pools), brut, poussiere };
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
    if (!j.believers) j.believers = [];
    return j;
  }
  const distinctesPersonnes = (l) => new Set((l || []).filter((a) => personne(a))).size;
  /** La photo d une journee finie (construction et regime : la meme). Une photo
   *  d avant le 12/10 n a pas de `believers` : le releve ecrit « – », jamais 0. */
  function photoDe(jour, t, plus) {
    const c = chiffres(), jj = S.jours[jour] || {};
    return Object.assign({ detenteurs: c.detenteurs, horsPools: c.horsPools, entrees: distinctesPersonnes(jj.entrees),
                           premieres: distinctesPersonnes(jj.premieres), sorties: distinctesPersonnes(jj.sorties),
                           recus: distinctesPersonnes(jj.recus), partis: distinctesPersonnes(jj.partis),
                           believers: distinctesPersonnes(jj.believers), partielles: jj.partielles || 0, t }, plus || {});
  }
  /** Un evenement de marche, compte dans sa journee de Paris et dans le fil des
   *  8 derniers jours (le resume des 24 h). */
  function noteJour(t, k) {
    const jj = jourDe(jourParis(t));
    if (k.genre === 'partielle') jj.partielles++;
    if (k.genre === 'nouveau' || k.genre === 'retour' || k.genre === 'believer') jj.achats++;
    if (k.genre === 'paper' || k.genre === 'partielle') jj.ventes++;
    if (k.genre === 'believer') jj.believers.push(k.qui);
    if (GENRES_ANNONCES.has(k.genre)) S.evts.push([Math.round(t), k.genre, k.qui]);
  }
  function ligneCommunaute(now) {
    const c = chiffres();
    const d = ecart24h(c.detenteurs, now);
    const nouveaux = distinctesPersonnes((S.jours[jourParis(now)] || {}).entrees);
    return `👥 ${c.detenteurs} holders${d === null ? '' : ` (${signe(d)} in 24h)`} · 🆕 ${nouveaux} new today` +
           (c.horsPools === null ? '' : `\n🌊 ${c.horsPools.toFixed(1)}% held by wallets${detailPools(c.partsPools)}`) +
           (c.resteEth >= 1 ? `\n🛒 ${fmtJetons(c.resteEth)} $SWOGE available to buy in the ETH pool${c.piscinesEth > 1 ? 's' : ''}` : '');
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
  /** Un montant en wei garde en chaine (voir ENTREE), ou null s il est illisible. */
  const wei = (x) => (typeof x === 'string' && /^\d{1,40}$/.test(x) ? BigInt(x) : null);
  /** L origine d une entree par envoi (voir ENTREE) : l entree `s` de l ENVOYEUR
   *  `env`, qui envoie `recu` (le net de l entrant). Un saut : son achat
   *  d entree, et quelle part de l envoi ses achats couvrent ; deux sauts ou
   *  plus : son origine, seulement pour un sac entier recu et renvoye. Sinon
   *  rien — la ligne s arrete a « received from ». */
  function origineDe(s, env, recu) {
    if (!s || !s.h) return undefined;
    const q = wei(s.q);
    if (q === null) return undefined;
    if (s.comment === 'achat') {
      const o = { h: s.h, b: s.b, t: s.t, qui: env };
      const qa = wei(s.qa), n = Number.isInteger(s.n) ? s.n : 0;
      if (q >= recu) o.part = 'entiere';
      else if (n > 0 && qa !== null && qa >= recu) { o.part = 'achats'; o.n = n; }
      else o.part = 'partie';
      return o;
    }
    if (s.comment === 'envoi' && s.origine && s.origine.h && s.origine.part === 'entiere' && q >= recu) return Object.assign({}, s.origine);
    return undefined;
  }
  /** L entree des detenteurs (voir TENUE et ENTREE), apres une transaction deja
   *  appliquee : posee au passage du seuil vers le haut, effacee sous le seuil ;
   *  un achat pendant la tenue y est compte (n, qa).
   *  `tx` : { h, b } ; `k` : son genre (classe), null si elle n en a pas.
   *  L entree de l ENVOYEUR est lue avant tout effacement : il peut passer sous
   *  le seuil dans la tx meme ou il envoie (un sac deplace en entier). */
  function noteTenue(net, avant, t, tx, k) {
    const neuves = new Map();
    if (typeof t === 'number' && isFinite(t)) {
      /* un envoi : aucune piscine dans la tx (comme LIENS), et UNE seule adresse a
         net negatif, une personne (voir ENTREE : 0 tx a plusieurs dans l histoire) */
      const touche = [...net.keys()].some((a) => S.pools.has(a));
      const negs = [...net].filter(([, d]) => d < 0n);
      const env = !touche && negs.length === 1 ? negs[0][0] : null;
      for (const [a, d] of net) {
        const av = avant.get(a), ap = solde(a);
        if (av >= SEUIL_DETENTEUR && ap >= SEUIL_DETENTEUR) {
          /* un achat pendant la tenue (believer) : compte, avec ce qu il apporte */
          const e = S.tenue[a];
          if (k && k.qui === a && k.achat && d > 0n && e && typeof e === 'object') {
            e.n = (Number.isInteger(e.n) ? e.n : 0) + 1;
            const qa = wei(e.qa);
            if (qa !== null) e.qa = (qa + d).toString();
          }
          continue;
        }
        if (!(av < SEUIL_DETENTEUR && ap >= SEUIL_DETENTEUR)) continue;
        const e = { t: Math.round(t), q: d.toString() };
        if (tx && tx.h) { e.h = tx.h; e.b = tx.b; }
        if (k && k.qui === a && k.achat) { e.comment = 'achat'; e.n = 0; e.qa = e.q; }
        else if (env && env !== a && personne(env)) {
          e.comment = 'envoi'; e.de = env;
          const o = origineDe(entreeDe(S.tenue[env]), env, d);
          if (o) e.origine = o;
        }
        neuves.set(a, e);
      }
    }
    for (const a of net.keys()) {
      if (solde(a) < SEUIL_DETENTEUR) delete S.tenue[a];
      else if (neuves.has(a)) S.tenue[a] = neuves.get(a);
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
  function lisRecu(logs, net, signataire) {
    let liq = false;
    const autresPM4 = new Set();      // les jetons ERC-20 (hors $SWOGE) qui entrent dans le PoolManager ou en sortent
    /* La jambe ETH de la paire v2 (WETH entre dans la paire, sortant negatif) et
       son dernier Sync (le cours en ETH apres l echange) : deja dans ce recu,
       0 appel de plus (voir COURS et COUT). */
    let weth = 0n, wethVu = false, sync = null;
    for (const l of logs) {
      const a = String(l.address || '').toLowerCase(), tp = (l.topics || []).map((x) => String(x).toLowerCase());
      if (a === WETH && tp[0] === TOPIC_TRANSFER && tp.length === 3) {
        const v = BigInt(l.data && l.data !== '0x' ? l.data : 0);
        if (adrDe(tp[2]) === PAIRE_PRIX) { weth += v; wethVu = true; }
        if (adrDe(tp[1]) === PAIRE_PRIX) { weth -= v; wethVu = true; }
      }
      if (a === PAIRE_PRIX && tp[0] === TOPIC_SYNC) sync = l.data;
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
    return { liq, marche, weth: wethVu ? Number(weth) / 1e18 : null, prixW: sync ? prixDeSync(sync) : null,
             signataire: signataire ? String(signataire).toLowerCase() : null };
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
        out.set(morceau[k].h, lisRecu(x.result.logs, netSeul(morceau[k]), x.result.from));
      });
    }
    if (cand.length) compte('recus', cand.length);
    return out;
  }
  const SANS_RECU = { liq: false, marche: new Set(), weth: null, prixW: null, signataire: null };
  /** Classe une transaction deja appliquee, recu a l appui (null si rien ne bouge). */
  function genreDe(tx, net, avant, recus, enDirect) {
    const r = recus.get(tx.h) || SANS_RECU;
    if (r.liq) { if (enDirect) compte('liquidite'); return null; }
    return classe(net, avant, r.marche);
  }

  // ---------------------------------------------------------- cout, liens (voir COUT et LIENS)
  /** Le cout moyen et les liens apres une transaction deja appliquee. `jambe` :
   *  { dW: ETH entre dans la paire v2 (sortant negatif) ou null, liq }. Rend,
   *  pour le VENDEUR d une vente dont seule la paire a bouge, { qui, pnl } (pnl
   *  en % en ETH contre son prix d achat moyen, null si ce prix n est pas
   *  connu) — lu AVANT la mise a jour du cout ; null sinon (prix de vente
   *  illisible : une autre piscine a bouge, ou l ETH natif du v4). */
  function suit(net, jambe, logs) {
    const nP = net.get(PAIRE_PRIX) || 0n;
    let seule = !!(jambe && jambe.dW !== null && !jambe.liq && nP !== 0n);
    if (seule) for (const [a, d] of net) if (d !== 0n && a !== PAIRE_PRIX && S.pools.has(a)) { seule = false; break; }
    let acheteur = null, vente = null, fluxJ = 0;
    if (seule) {
      const achat = nP < 0n, flux = absB(nP);
      fluxJ = jetons(flux);
      let qui = null, q = 0n;
      for (const [a, d] of net) {
        if (!personne(a) || (achat ? d <= 0n : d >= 0n)) continue;
        if (absB(d) > q) { qui = a; q = absB(d); }
      }
      if (qui && q * 2n >= flux && (achat ? jambe.dW > 0 : jambe.dW < 0)) {
        if (achat) acheteur = qui;
        else {
          const c = S.couts[qui], qv = jetons(q);
          /* la part du sac a cout connu, rapportee au solde REEL d avant (un
             suivi incomplet abaisse la part, il ne l invente jamais) */
          const avant = jetons(solde(qui) + q);
          const connu = c && c[0] > 0 && c[0] / Math.max(c[0] + c[2], avant) >= PART_CONNUE_MIN;
          /* vente melee (voir COUT) : des jetons partis ailleurs dans la tx */
          if (qv > fluxJ * (1 + FRAIS_VENTE_MAX)) vente = { qui, lu: false, pnl: null };
          else vente = { qui, lu: true, pnl: connu ? 100 * ((-jambe.dW / Math.max(qv, fluxJ)) / (c[1] / c[0]) - 1) : null };
        }
      }
    }
    for (const [a, d] of net) {
      if (d === 0n || !personne(a)) continue;
      const c = S.couts[a] || [0, 0, 0], q = jetons(absB(d));
      if (d > 0n) {
        /* l acheteur : SA part de la jambe ETH (voir COUT, achat garde en partie) */
        if (a === acheteur && fluxJ > 0) { const k = Math.min(q, fluxJ); c[0] += k; c[1] += jambe.dW * k / fluxJ; c[2] += q - k; }
        else c[2] += q;
      } else {
        const tot = c[0] + c[2], f = tot > 0 ? Math.min(1, q / tot) : 1;
        c[0] *= 1 - f; c[1] *= 1 - f; c[2] *= 1 - f;
      }
      if (solde(a) <= 0n) delete S.couts[a]; else S.couts[a] = c;
    }
    /* un lien : un envoi direct de personne a personne, AUCUNE piscine dans la
       tx ; le degre compte tout envoi non nul, le groupe seulement les envois
       d au moins SEUIL_LIEN (voir LIENS) */
    if (logs && ![...net.keys()].some((a) => S.pools.has(a))) {
      for (const l of logs) {
        const de = adrDe(l.topics[1]), vers = adrDe(l.topics[2]), v = BigInt(l.data === '0x' ? 0 : l.data);
        if (de !== vers && personne(de) && personne(vers) && v > 0n) { const fort = v >= SEUIL_LIEN; lie(de, vers, fort); lie(vers, de, fort); }
      }
    }
    return vente;
  }
  /* Les voisins d une adresse : « b » (lien, envoi >= SEUIL_LIEN) ou « ~b »
     (poussiere : compte pour le degre, jamais pour le groupe). Au-dela de
     DEGRE_MAX + 1 voisins, on n en garde pas plus : c est un carrefour. */
  function lie(a, b, fort) {
    const l = S.liens[a] || (S.liens[a] = []);
    const faible = l.indexOf('~' + b);
    if (fort && faible >= 0) { l[faible] = b; return; }
    if (l.includes(b) || faible >= 0) return;
    if (l.length <= DEGRE_MAX) l.push(fort ? b : '~' + b);
  }
  /** Le groupe d un acheteur : ses relies (au plus GROUPE_MAX portefeuilles,
   *  lui compris, les plus proches d abord), sans carrefour ni maison. */
  function groupe(qui) {
    const ok = (a) => personne(a) && (S.liens[a] || []).length <= DEGRE_MAX;
    if (!ok(qui)) return [];
    const g = [qui];
    for (let i = 0; i < g.length && g.length < GROUPE_MAX; i++) {
      for (const b of S.liens[g[i]] || []) {
        if (g.length >= GROUPE_MAX) break;
        if (b[0] !== '~' && !g.includes(b) && ok(b)) g.push(b);
      }
    }
    return g.slice(1);
  }
  /** Le cours en ETH apres un echange (un point par minute, le dernier gagne). */
  function notePrix(t, p) {
    if (!(p > 0)) return;
    const A = S.coursW, m = Math.floor(t / 60000);
    if (A.length && Math.floor(A[A.length - 1][0] / 60000) === m) A[A.length - 1] = [Math.round(t), p];
    else if (!A.length || A[A.length - 1][0] <= t) A.push([Math.round(t), p]);
  }
  /** Les jambes de la paire v2 depuis ses Sync (construction) : hash → { dW,
   *  liq, prixW, b }. dW = reserve0 apres la tx − reserve0 avant (le dernier
   *  Sync d avant) ; reserves qui bougent dans le meme sens = de la liquidite.
   *  Sonde du 12/10 : = Transfer WETH vers et depuis la paire dans 5 723 tx sur
   *  5 723, = net $SWOGE de la paire dans 5 723 sur 5 723. */
  function jambesDeSync(logs) {
    const cle = (l) => [parseInt(l.blockNumber, 16), parseInt(l.transactionIndex, 16), parseInt(l.logIndex, 16)];
    const tri = logs.filter((l) => !l.removed).map((l) => ({ l, k: cle(l) }))
      .sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.k[2] - y.k[2]);
    const out = new Map();
    let r0p = 0n, r1p = 0n;
    for (const { l, k } of tri) {
      if (!/^0x[0-9a-fA-F]{128}/.test(String(l.data))) { compte('syncIllisible'); continue; }   // un Sync mal forme ne casse pas la construction
      const d = String(l.data).slice(2);
      const r0 = BigInt('0x' + d.slice(0, 64)), r1 = BigInt('0x' + d.slice(64, 128));
      let j = out.get(l.transactionHash);
      if (!j) { j = { r0a: r0p, r1a: r1p, b: k[0] }; out.set(l.transactionHash, j); }
      j.r0 = r0; j.r1 = r1; r0p = r0; r1p = r1;
    }
    for (const j of out.values()) {
      const dW = j.r0 - j.r0a, dS = j.r1 - j.r1a;
      j.dW = Number(dW) / 1e18;
      j.liq = (dW > 0n && dS > 0n) || (dW < 0n && dS < 0n);
      j.prixW = j.r1 > 0n ? Number(j.r0 * E18 / j.r1) / 1e18 : null;
      delete j.r0a; delete j.r1a; delete j.r0; delete j.r1;
    }
    return out;
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
     persistant avec la chaine, ou un etat d avant le 12/10 (SCHEMA). Rien
     n est annonce sur l historique. Cout au rejeu du 12/10 (construction au
     bloc 86 356 865 : 8 323 Transfer, 5 722 Sync, voir EXPLOITATION) : 75
     appels — 18 eth_getLogs (9 sur le jeton, 9 sur les Sync de la paire),
     44 lots de getCode (dont 8 pour les deux bouts des envois directs, voir
     LIENS : 24 detenteurs relies au lieu de 11 sans eux), 2 lots
     token0/token1, 1 lot d en-tetes, 7 lots de recus, 1 lot de balanceOf.
     Resultat : 121 detenteurs, 66,49 % hors 5 piscines (= la production du
     12/10 03:22), prix d achat connu pour 90 detenteurs sur 121. Elle
     travaille sur un etat NEUF (voir tic) : ratee, elle ne laisse rien
     derriere elle.
     `borne` (une MIGRATION, voir tic) : la construction s arrete au curseur de
     l ancien etat, et le tic suivant lit l ecart comme un redemarrage — sous la
     regle des 30 min. Non-regression du 12/10 : construite jusqu a la pointe,
     elle avalait comme de l histoire tout ce qui s etait passe entre le dernier
     tic de l ancien processus et la fin de la reconstruction (2 a 5 min) — la
     Paper hand 0x722d8572… de 09:37 le 09/10, annoncee par un simple
     redemarrage, disparaissait. Probabilite de perdre au moins une annonce sur
     les 74 des 7 jours reels : 2,1 % pour 3 min, 3,5 % pour 5 min. La borne
     ne recule pas de plus de 30 min (17 385 blocs a 0,10354 s) : au-dela, rien
     ne serait annonce de toute facon. */
  let constructionsIndecises = 0;
  async function construit(borne) {
    const t0 = Date.now(), appels0 = S.appels;
    const tip = await pointe();
    const now = deps.horloge();
    /* ancres : depuis la frappe une tous les ~10 jours (voir TENUE), puis un
       en-tete par jour sur 9 jours, puis la pointe — dans l ordre des blocs */
    const blocs = [];
    for (let b = BLOC_FRAPPE; b < tip.bloc - 9 * 864000 - ANCRE_PAS / 2; b += ANCRE_PAS) blocs.push(b);
    for (let k = 9; k >= 1; k--) if (tip.bloc - k * 864000 > 0) blocs.push(tip.bloc - k * 864000);
    const en = await lot(blocs.map((b) => ['eth_getBlockByNumber', [hex(b), false]]));
    S.ancres = [];
    en.forEach((x) => { if (x.result) S.ancres.push([parseInt(x.result.number, 16), parseInt(x.result.timestamp, 16) * 1000]); });
    S.ancres.push([tip.bloc, tip.t]);
    /* jamais plus de RETARD_MAX_MS derriere la pointe : un ecart plus vieux ne
       serait pas annonce (regle des 30 min), et le rejouer au tic laisserait les
       journees d entre-deux sans photo (un ancien etat arrete depuis des jours) */
    const plancher = tip.bloc - CONFIRMATIONS - Math.ceil(RETARD_MAX_MS / CADENCE_MS);
    const jusqua = borne > 0 ? Math.min(tip.bloc - CONFIRMATIONS, Math.max(borne, plancher)) : tip.bloc - CONFIRMATIONS;
    const logs = await lisLogs(BLOC_FRAPPE, jusqua, filtreJeton());
    const txs = regroupe(logs, 0);
    /* les Sync de la paire v2 depuis la frappe : la jambe ETH de chaque echange
       (le prix d achat moyen) et le cours des 8 derniers jours (voir COURS) ;
       la paire SEULE, une valeur par position */
    const syncs = await lisLogs(BLOC_FRAPPE, jusqua, { address: PAIRE_PRIX, topics: [TOPIC_SYNC] });
    const jambes = jambesDeSync(syncs);
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
    /* Les liens (voir LIENS) demandent le code des deux bouts d un envoi direct,
       meme s ils ne tiennent plus rien. Sans verdict, pas de lien : on ne
       bloque pas la construction pour ca (compte `codesLiensIndecis`). */
    const libres = [];
    for (const tx of txs) {
      const n = netSeul(tx);
      if ([...n.keys()].some((a) => S.pools.has(a))) continue;
      for (const a of n.keys()) if (!(a in S.codes) && !BRULES.has(a) && a !== JETON) libres.push(a);
    }
    const indecisLiens = await apprendCodes(libres);
    if (indecisLiens.length) compte('codesLiensIndecis', indecisLiens.length);
    const recus = await examine(txs.filter((tx) => tx.b >= debutFenetre));
    /* Passe B : le rejeu complet, codes et piscines connus. */
    S.soldes = new Map(); S.deja = new Set(); S.jours = {}; S.photos = {}; S.horaires = [];
    S.couts = {}; S.liens = {}; S.vus = new Set(); S.coursW = []; S.evts = []; S.tenue = {};
    let iJ = 0, iH = 0;
    /* hors de la fenetre des recus, le sens d une entree se lit sans recu (voir
       ENTREE) : les piscines de marche par l autre jeton, le v4 jamais */
    const marchesSansRecu = new Set([...S.pools].filter((p) => p !== PM4 && VALEUR.has(S.autres[p])));
    const photo = (jour, t) => { S.photos[jour] = photoDe(jour, t, { reconstruit: true }); };
    const bornes = (b, bH) => {
      while (iJ < finsJour.length && blocDe(finsJour[iJ].t) < b) { photo(finsJour[iJ].jour, finsJour[iJ].t); iJ++; }
      while (iH < heures.length && blocDe(heures[iH]) < (bH === undefined ? b : bH)) { S.horaires.push({ t: heures[iH], n: chiffres().detenteurs }); iH++; }
    };
    for (const tx of txs) {
      bornes(tx.b);
      const { net, avant } = applique(tx);
      const j = jambes.get(tx.h);
      const dansFenetre = tx.b >= debutFenetre;
      const r = dansFenetre ? recus.get(tx.h) : null;
      let k = null;
      if (dansFenetre) {
        const t = tempsDe(tx.b);
        k = genreDe(tx, net, avant, recus, false);
        if (k && k.qui) noteJour(t, k);
        passages(net, avant, t, k);
      } else {
        for (const a of net.keys()) if (solde(a) >= SEUIL_DETENTEUR) S.deja.add(a);
        /* le genre ne sert ici qu a l entree : une liquidite de la paire (Sync) n en a pas */
        if (!(j && j.liq)) k = classe(net, avant, marchesSansRecu);
      }
      noteTenue(net, avant, tempsDe(tx.b), tx, k);
      /* le cout de TOUT l historique (voir COUT) : la jambe des Sync, la
         liquidite par le sens des reserves, ou par le recu dans la fenetre */
      suit(net, j ? { dW: j.dW, liq: j.liq || !!(r && r.liq) } : null, tx.logs);
      for (const a of net.keys()) S.vus.add(a);
    }
    /* les journees finies AU curseur ; une journee qui finit apres lui (une
       migration bornee juste avant minuit) est photographiee par le tic, au
       premier echange du lendemain, l ecart compris (voir photosDuJour) */
    bornes(jusqua + 1, Infinity);
    /* le cours des 8 derniers jours, plus le dernier Sync d avant (voir COURS) */
    const debutCours = blocDe(now - COURS_GARDE_MS);
    let avantCours = null;
    for (const j of [...jambes.values()].sort((x, y) => x.b - y.b)) {
      if (j.prixW === null) continue;
      if (j.b < debutCours) { avantCours = j; continue; }
      if (avantCours) { notePrix(tempsDe(avantCours.b), avantCours.prixW); avantCours = null; }
      notePrix(tempsDe(j.b), j.prixW);
    }
    if (avantCours) notePrix(tempsDe(avantCours.b), avantCours.prixW);
    /* Le livre rejoue doit tomber sur la chaine au bloc du curseur, sinon on ne
       publie rien de ce qu il dit (un journal manquant dans une fenetre). */
    const ctl = await controleLivre(jusqua);
    if (ctl.ecarts.length) throw new Error('livre rejoue different de la chaine au bloc ' + jusqua + ' : ' + ctl.ecarts.join(' ; '));
    S.controleH = ctl.lus ? Math.floor(now / HEURE_MS) : null;
    S.curseur = jusqua;
    S.construit = true;
    S.schema = SCHEMA;
    if (!S.heure) S.heure = { cle: Math.floor(now / HEURE_MS), n: 0, surplus: {} };   // garde (voir GARDES_CONSTRUCTION)
    const c = chiffres();
    compte('constructions');
    let connus = 0, suivis = 0, relies = 0;
    for (const [a, x] of Object.entries(S.couts)) if (solde(a) >= SEUIL_DETENTEUR && personne(a)) { suivis++; if (x[0] / Math.max(x[0] + x[2], 1e-9) >= PART_CONNUE_MIN) connus++; }
    for (const a of Object.keys(S.liens)) if (solde(a) >= SEUIL_DETENTEUR && groupe(a).length) relies++;
    console.log(`[communaute] construit en ${Math.round((Date.now() - t0) / 1000)} s · ${logs.length} Transfer · ${syncs.length} Sync · ${S.appels - appels0} appels au noeud (${S.refus429} refus 429) · ` +
      `${c.detenteurs} detenteurs (>= 1 000 $SWOGE, personnes hors maison) · ${c.horsPools === null ? '?' : c.horsPools.toFixed(2)} % hors ${S.pools.size} piscines · brule ${Math.round(c.brule)} · ` +
      `prix d achat connu pour ${connus}/${suivis} detenteurs · ${relies} detenteurs relies · cours : ${S.coursW.length} points` +
      (jusqua < tip.bloc - CONFIRMATIONS ? ` · arretee au curseur de l ancien etat (bloc ${jusqua}, ${tip.bloc - CONFIRMATIONS - jusqua} blocs lus au tic suivant)` : ''));
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
  /** Le gain ou la perte d une vente (voir COUT) : jamais un chiffre sans les
   *  deux jambes lues. */
  const RAISONS_VENTE = { paire: ' (not sold on the v2 pair)', piscines: ' (sold through several pools)', envois: ' (tokens also sent elsewhere in the same transaction)' };
  function lignePnl(ev) {
    /* la raison dite est celle lue dans la tx (relecture du 12/10 : « not sold on
       the v2 pair » etait ecrit aussi quand la paire ET une autre piscine
       bougeaient — 0 cas en 30 jours, mais la parenthese aurait ete fausse) */
    if (!ev.venteLue) return '❔ Profit or loss unknown: sale price not readable on-chain' + (RAISONS_VENTE[ev.raisonVente] || '');
    if (ev.pnl === null || ev.pnl === undefined || !isFinite(ev.pnl)) return '❔ Profit or loss unknown: buy price unknown (tokens received by transfer or another pool)';
    if (Math.abs(ev.pnl) < EQUILIBRE_PCT) return '⚖️ About break-even (within ±1%) vs. average buy price, in ETH';
    return ev.pnl > 0 ? `💰 Sold in profit: <b>${pct(ev.pnl)}</b> vs. average buy price, in ETH`
                      : `🔻 Sold at a loss: <b>${pct(ev.pnl)}</b> vs. average buy price, in ETH`;
  }
  /** Les portefeuilles relies d un acheteur (voir LIENS), ou rien. */
  function ligneLiens(qui) {
    const g = groupe(qui);
    if (!g.length) return null;
    const tri = g.map((a) => ({ a, n: jetons(solde(a)) })).sort((x, y) => y.n - x.n);
    const total = jetons(solde(qui)) + tri.reduce((s, x) => s + x.n, 0);
    const vus = tri.slice(0, 3).map((x) => `${lienAdr(x.a)} (${fmtJetons(x.n)})`).join(', ');
    return `🔗 Linked by direct $SWOGE transfers: ${vus}${tri.length > 3 ? ` +${tri.length - 3} more` : ''} · ` +
           `<b>${fmtJetons(total)} $SWOGE</b> across ${g.length + 1} wallets (not proof of a single owner)`;
  }
  /** La ligne d entree d une paper hand (voir ENTREE) : quand (UTC, en-tete du
   *  bloc), comment (achat, ou envoi et par qui) et, pour un envoi, l achat
   *  d origine ; null sans tx d entree connue — rien d invente. L envoyeur et
   *  l acheteur d origine repassent par personne() ICI, au moment d annoncer :
   *  la maison et les exclus du jour ne sont jamais nommes (A2). */
  const HASH = /^0x[0-9a-fA-F]{64}$/, ADR = /^0x[0-9a-f]{40}$/;
  function ligneEntree(ev) {
    const e = ev.entree;
    if (!e || !HASH.test(String(e.h))) return null;
    const lien = (h, mot) => `<a href="${deps.explorer}/tx/${h}">${mot} ↗</a>`;
    const quand = typeof e.tBloc === 'number' ? `In since ${heureUtc(e.tBloc, ev.t)}` : 'Entry';
    if (e.comment === 'achat') return `📥 ${quand} · ${lien(e.h, 'bought')}`;
    if (e.comment !== 'envoi' || !ADR.test(String(e.de)) || !personne(e.de)) return `📥 ${quand} · ${lien(e.h, 'tx')}`;
    let l = `📥 ${quand} · ${lien(e.h, 'received')} from ${lienAdr(e.de)}`;
    const o = e.origine;
    if (!o || !HASH.test(String(o.h)) || !ADR.test(String(o.qui))) return l;
    const le = typeof o.tBloc === 'number' ? ` on ${heureUtc(o.tBloc, ev.t)}` : '';
    if (o.qui === e.de) {
      /* un saut : quelle part de l envoi l achat lie couvre (voir ENTREE, E2) */
      if (o.part === 'entiere') l += `, who ${lien(o.h, 'bought' + le)}`;
      else if (o.part === 'achats' && Number.isInteger(o.n) && o.n > 0) l += `, who ${lien(o.h, 'bought' + le)} and ${pluriel(o.n, 'more time')}`;
      else if (o.part === 'partie') l += `, who ${lien(o.h, 'bought part of it' + le)}`;
    } else if (o.part === 'entiere') {
      /* deux sauts ou plus : l acheteur, jamais « first » (voir ENTREE, E1) */
      if (o.qui === ev.qui) l += ` · ${lien(o.h, 'bought' + le)} by this wallet`;
      else if (personne(o.qui)) l += ` · ${lien(o.h, 'bought' + le)} by ${lienAdr(o.qui)}`;
    }
    return l;
  }
  function texte(ev) {
    const usd = ev.usd === null ? '' : ` (~${fmtUsd(ev.usd)})`;
    let tete;
    const corps = [];
    if (ev.genre === 'nouveau' || ev.genre === 'retour') {
      tete = '🆕 <b>New holder</b>' + (ev.genre === 'retour' ? ' · welcome back' : '');
      corps.push(`${lienAdr(ev.qui)} bought <b>${fmtJetons(ev.q)} $SWOGE</b>${usd}`);
      if (typeof ev.frais === 'number') corps.push(`🐣 Fresh wallet: ${ev.frais === 0 ? 'this buy is its first transaction on this chain' : `only ${pluriel(ev.frais, 'transaction')} on this chain before this buy`}`);
      const l = ligneLiens(ev.qui); if (l) corps.push(l);
    } else if (ev.genre === 'believer') {
      tete = '💎 <b>Believer</b>';
      corps.push(`${lienAdr(ev.qui)} bought <b>${fmtJetons(ev.q)} $SWOGE</b> more${usd}`);
      corps.push(`👜 Added to bag: ${fmtJetons(ev.avant)} → <b>${fmtJetons(ev.apres)} $SWOGE</b> (${pct(100 * (ev.apres / ev.avant - 1))})`);
      const l = ligneLiens(ev.qui); if (l) corps.push(l);
    } else if (ev.genre === 'partielle') {
      tete = '✂️ <b>Partial sell</b>';
      corps.push(`${lienAdr(ev.qui)} sold <b>${fmtJetons(ev.q)} $SWOGE</b>${usd}, ${Math.round(100 * ev.q / ev.avant)}% of the bag · still holds <b>${fmtJetons(ev.apres)}</b>`);
      corps.push(lignePnl(ev));
    } else {
      tete = '🧻 <b>Paper hand</b>';
      const apresTenue = typeof ev.tenueMs === 'number' && isFinite(ev.tenueMs) ? ` after ${dureeTenue(ev.tenueMs)}` : '';
      corps.push(`${lienAdr(ev.qui)} sold <b>${fmtJetons(ev.q)} $SWOGE</b>${usd} and left${apresTenue}${ev.apres >= 1 ? ` (kept ${fmtJetons(ev.apres)})` : ''}`);
      /* sous « and left after », la ligne d entree (voir ENTREE). Longueur : la
         ligne la plus longue (un saut, « and N more times ») fait 111 signes
         visibles, 128 avec deux annees et un compte a 6 chiffres ; l annonce
         entiere au pire de chaque champ en fait 648, sous les 1 024 de la legende
         (essai R10) ; les annonces reelles rejouees : 383 a 468. Une ligne de plus
         ne fait donc jamais tomber la photo. */
      const le = ligneEntree(ev);
      if (le) corps.push(le);
      corps.push(lignePnl(ev));
      corps.push(`<i>${blaguePaper(ev)}</i>`);
    }
    return `${tete}\n${corps.join('\n')}\n${ev.ligne}\n${lienTx(ev.h)}`;
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
    if (s.partielle) parts.push(`${s.partielle} partial sell${s.partielle > 1 ? 's' : ''}`);
    return parts.join(' · ');
  }
  /** « Fresh wallet » (voir NEUF) : le nonce de la tx d achat, seulement pour
   *  une premiere entree que l acheteur a SIGNEE et qui est sa premiere
   *  apparition sur le $SWOGE ; 1 appel, rien dit s il echoue. */
  async function nonceNeuf(ev) {
    if (ev.genre !== 'nouveau' || !ev.neuf || !ev.signataire || ev.signataire !== ev.qui) return;
    try {
      const x = await rpc('eth_getTransactionByHash', [ev.h]);
      const n = x && typeof x.nonce === 'string' ? parseInt(x.nonce, 16) : NaN;
      compte('noncesLus');
      if (x && String(x.from || '').toLowerCase() === ev.qui && n >= 0 && n <= NONCE_NEUF_MAX) { ev.frais = n; compte('neufs'); }
    } catch (e) { compte('noncesIllisibles'); }
  }
  /** L heure EXACTE de l entree d une paper hand et de son achat d origine (voir
   *  ENTREE) : l en-tete de leurs blocs, un lot de 1 ou 2 appels en lecture
   *  courte (LECTURE_COURTE), seulement pour une annonce qui part. Illisible ou
   *  invraisemblable : la ligne garde ses liens, sans l heure. */
  async function heuresEntree(ev) {
    const e = ev.entree;
    if (ev.genre !== 'paper' || !e || !e.h) return;
    const qui = [e, e.origine].filter((x) => x && x.h && Number.isInteger(x.b) && x.b > 0);
    if (!qui.length) return;
    try {
      const rep = await lot(qui.map((x) => ['eth_getBlockByNumber', [hex(x.b), false]]), LECTURE_COURTE);
      rep.forEach((r, i) => {
        const x = r && r.result;
        /* l en-tete du BON bloc, a moins de 2 h de l heure gardee (A3), ou rien */
        const tb = x && /^0x[0-9a-fA-F]{1,16}$/.test(String(x.timestamp)) ? parseInt(x.timestamp, 16) * 1000 : NaN;
        if (x && parseInt(x.number, 16) === qui[i].b && isFinite(tb) && typeof qui[i].t === 'number' && Math.abs(tb - qui[i].t) <= ECART_ENTETE_MAX_MS) qui[i].tBloc = tb;
        else compte('heuresEntreeIllisibles');
      });
      compte('heuresEntreeLues');
    } catch (err) { compte('heuresEntreeIllisibles'); }
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
    if (ev.genre === 'partielle' && !(ev.q >= PARTIELLE_PART_MIN * ev.avant)) return ecarte('petitePart');
    const cleR = ev.qui + '|' + familleDe(ev.genre);
    if (S.dernier[cleR] && now - S.dernier[cleR] < RECHARGE_MS) return ecarte('recharge');
    S.dernier[cleR] = now;
    S.annonces[ev.h] = now;
    const cle = Math.floor(now / HEURE_MS);
    if (!S.heure || S.heure.cle !== cle) videHeure(now, aEnvoyer);
    if (S.heure.n >= PLAFOND_HEURE) { S.heure.surplus[ev.genre] = (S.heure.surplus[ev.genre] || 0) + 1; return ecarte('regroupe'); }
    S.heure.n++;
    ecarte('annonce');
    await nonceNeuf(ev);
    await heuresEntree(ev);
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
  /** Le cours sur 7 jours en ETH (voir COURS) : le dernier Sync connu contre le
   *  dernier Sync anterieur a now − 168 h ; null sans reference. */
  function coursEth(now) {
    const A = S.coursW || [];
    if (!A.length) return null;
    const ref = now - 7 * JOUR_MS;
    let p0 = null;
    for (const [t, p] of A) { if (t <= ref) p0 = p; else break; }
    const p1 = A[A.length - 1][1];
    if (!(p0 > 0) || !(p1 > 0)) return null;
    return { eth: 100 * (p1 / p0 - 1), p0, p1, usd: null };
  }
  /** ETH/USD au bloc `bloc` : le dernier Swap de la v3 WETH/USDG dans les
   *  FENETRE_ETH_USD blocs d avant (voir COURS) ; null si rien de lisible. */
  async function ethUsdAu(bloc) {
    const l = await lisPlage(Math.max(0, bloc - FENETRE_ETH_USD), bloc, { address: PISCINE_ETH_USD, topics: [TOPIC_SWAP_V3] });
    const x = l.length ? l[l.length - 1] : null;
    if (!x || typeof x.data !== 'string' || x.data.length < 2 + 192) return null;
    const r = Number(BigInt('0x' + x.data.slice(2 + 128, 2 + 192))) / 2 ** 96;
    const v = r * r * 10 ** (18 - DECIMALES_USDG);
    return v >= ETH_USD_MIN && v <= ETH_USD_MAX ? v : null;
  }
  /** Le cours sur 7 jours en ETH et, si l ETH/USD se lit aux deux instants, en $. */
  async function coursSept(now) {
    const c = coursEth(now);
    if (!c) return null;
    try {
      const e1 = await ethUsdAu(S.curseur), e0 = await ethUsdAu(blocDe(now - 7 * JOUR_MS));
      if (e0 && e1) { c.usd = 100 * (c.p1 * e1 / (c.p0 * e0) - 1); c.e0 = e0; c.e1 = e1; } else compte('ethUsdIllisible');
    } catch (e) { compte('ethUsdIllisible'); }
    return c;
  }
  /** Les evenements de marche des dernieres 24 h : portefeuilles DISTINCTS par genre. */
  function resume24h(now) {
    const p = { entrees: new Set(), believers: new Set(), paper: new Set(), partielles: 0 };
    for (const [t, g, a] of S.evts || []) {
      if (t < now - JOUR_MS || t > now || !personne(a)) continue;
      if (g === 'nouveau' || g === 'retour') p.entrees.add(a);
      else if (g === 'believer') p.believers.add(a);
      else if (g === 'paper') p.paper.add(a);
      else if (g === 'partielle') p.partielles++;
    }
    return p;
  }
  /* Le resume du jour (demande du 12/10) tient dans le releve : une publication.
     Longueur mesuree (sonde du 12/10, unites UTF-16 sans balises, limite 1 024)
     : releve d avant 856 ; avec les trois lignes ajoutees telles quelles 1 038 ;
     d ou la note de bas raccourcie. Rejeu reel : 994.
     LA LIMITE EST TENUE A L ENVOI (relecture du 12/10) : un jour extreme la
     depassait — +999 en 24 h, % a 4 chiffres et +800 en 7 jours : 1 027 ; trois
     chiffres partout : 1 029 ; pompe plausible (380 detenteurs, +85 en 24 h, 120
     new par jour, +312 %) : 1 013 ; production 998 (26 de marge). Au-dela de
     1 024, Telegram refuse la photo et le releve part en texte seul
     (telegram.js). Donc : au-dela, la note (« Holders = … », une phrase depuis
     le releve simple du 12/10) tombe. Les chiffres restent. */
  const LEGENDE_MAX = 1024;
  const visible = (t) => t.replace(/<[^>]*>/g, '').replace(/&(lt|gt|amp|quot);/g, '_').length;
  /* Les 7 jours en PORTEFEUILLES distincts (relecture du 12/10 : « Last 24h: N
     new » comptait des portefeuilles, « 7 days: N new » additionnait les entrees
     de chaque jour — 43 au rejeu contre 35 portefeuilles a la sonde, 0x132b… et
     0x9322… comptes deux fois : deux definitions sous le meme mot). Les adresses
     viennent du journal du jour (S.jours, 12 jours gardes) ; une journee sans
     journal compte sa photo (des nombres) ; une photo sans le champ (believers
     d avant le 12/10) : « – », jamais 0. Les ventes partielles restent des
     VENTES (sonde : 4 partielles de 3 portefeuilles), en 24 h comme en 7 jours. */
  const CHAMPS_7J = ['entrees', 'premieres', 'sorties', 'recus', 'partis', 'believers'];
  function texteReleve(now, cours) {
    if (cours === undefined) cours = coursEth(now);
    const c = chiffres();
    const d = ecart24h(c.detenteurs, now);
    const auj = jourParis(now);
    let premier = null, dernierN = null;
    const sept = {}, manque = {};
    for (const f of CHAMPS_7J) sept[f] = new Set();
    for (let k = JOURS_RELEVE; k >= 1; k--) {
      const j = jourPlus(auj, -k), p = S.photos[j], pv = S.photos[jourPlus(j, -1)];
      if (!p) continue;
      if (premier === null && pv) premier = pv.detenteurs;
      if (premier === null) premier = p.detenteurs;
      dernierN = p.detenteurs;
      const jj = S.jours[j];
      for (const f of CHAMPS_7J) {
        if (jj && Array.isArray(jj[f])) { for (const a of jj[f]) if (personne(a)) sept[f].add(a); }
        else if (typeof p[f] === 'number') { for (let i = 0; i < p[f]; i++) sept[f].add(j + '#' + i); }
        else manque[f] = true;
      }
    }
    const n7 = (f) => (manque[f] ? '–' : String(sept[f].size));
    const croissance = premier !== null && dernierN !== null ? dernierN - premier : null;
    const r = resume24h(now);
    /* « New » et « Left » ne comptent que le MARCHE (voir passages) ; les
       autres passages du seuil sont dits « by transfer ». La poussiere et le
       compte brut sont calcules ici (relecture du 12/10 : « ~540 » et « ~700 »
       etaient ecrits en dur, les chiffres du 11/10).
       Le % du cours : une decimale sous 10 %, entier au-dela, comme les autres
       (pct). Relecture du 12/10 : deux passes de la sonde a 5 min d ecart ont
       donne +20,88 % puis +19,8 % en $ (l ETH de J−7 avait bouge de 0,9 % entre
       les deux minutes de reference) ; le chiffre depend de l instant a ~1 point
       pres, une decimale au-dela de 10 % serait une precision fausse. */
    /* 12/10/2026, le proprietaire apres le premier releve : « parle pas des 570
       wallets de l airdrop, juste des reels holders, faut que ca soit positif et
       simple a comprendre ». Le releve garde ses chiffres (detenteurs, cours,
       nouveaux, believers, paper hands), sans le tableau a colonnes, sans la
       poussiere ni le compte brut des traqueurs, sans transferts ni ventes
       partielles (dites dans leurs annonces). Une ligne suit les detenteurs jour
       apres jour. Rien n est cache de ce qui compte : un cours en baisse s ecrit
       en baisse, les paper hands restent comptes. */
    const suite = [];
    for (let k = JOURS_RELEVE; k >= 1; k--) { const p = S.photos[jourPlus(auj, -k)]; suite.push(p ? String(p.detenteurs) : '–'); }
    suite.push(String(c.detenteurs));
    const ligneCoursSimple = !cours ? '' : cours.usd !== null && cours.usd !== undefined
      ? `📊 Chart: <b>${pct(cours.usd)}</b> this week\n`
      : `📊 Chart: <b>${pct(cours.eth)}</b> this week (in ETH)\n`;
    const corps = `📈 <b>$SWOGE community · daily report</b>\n` +
      `👥 <b>${c.detenteurs} holders</b>${d === null ? '' : ` (${signe(d)} in 24h)`}\n` +
      ligneCoursSimple +
      `🌊 <b>${c.horsPools === null ? '?' : c.horsPools.toFixed(1)}%</b> of supply held by wallets${detailPools(c.partsPools)}\n` +
      (c.resteEth >= 1 ? `🛒 <b>${fmtJetons(c.resteEth)} $SWOGE</b> available to buy in the ETH pool${c.piscinesEth > 1 ? 's' : ''}\n` : '') + '\n' +
      `<b>Last 24h</b>\n🆕 ${pluriel(r.entrees.size, 'new holder')} · 💎 ${pluriel(r.believers.size, 'believer')} · 🧻 ${pluriel(r.paper.size, 'paper hand')}\n\n` +
      `<b>This week</b>\n👥 <b>${croissance === null ? '?' : signe(croissance)}</b> holders · 🆕 ${n7('entrees')} new · ` +
      `💎 ${manque.believers ? '– believers' : pluriel(sept.believers.size, 'believer')}\n` +
      `📅 ${suite.join(' → ')}`;
    const note = `<i>Holders = wallets with 1,000+ $SWOGE.</i>`;
    const t1 = `${corps}\n\n${note}`;
    if (visible(t1) <= LEGENDE_MAX) return t1;
    compte('releveSansNote');
    return corps;
  }
  async function releveDu(now, aEnvoyer) {
    const cr = xp().creneauDu(now, [C.heure], FUSEAU);
    if (!cr || S.releves[cr.jour]) return;
    const prevu = minuitParis(cr.jour) + (Number(C.heure.split(':')[0]) * 60 + Number(C.heure.split(':')[1])) * 60000;
    /* au changement d heure, `prevu` peut differer d une heure : on se fie au creneau */
    if (now - prevu > RELEVE_RETARD_MAX_MS + HEURE_MS) { S.releves[cr.jour] = { saute: now }; compte('relevesSautes'); console.log(`[communaute] releve du ${cr.jour} saute : plus de 3 h de retard`); return; }
    S.releves[cr.jour] = { t: now };
    compte('releves');
    const cours = await coursSept(now);
    aEnvoyer.push({ image: 'releve', legende: texteReleve(now, cours), quoi: 'releve' });
  }
  /* `now` est l heure de la CHAINE traitee (un echange, ou le curseur), jamais
     en arriere : un Transfer de 23:59:58 traite apres un tic de 00:00:30 ne
     doit pas rouvrir la veille. */
  function photosDuJour(now) {
    const auj = jourParis(now);
    if (!S.jourCourant) { S.jourCourant = auj; return; }
    if (S.jourCourant >= auj) return;
    const fini = S.jourCourant;
    S.photos[fini] = photoDe(fini, now);
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
    S.evts = (S.evts || []).filter((e) => e[0] >= now - EVTS_GARDE_MS);
    /* le cours : 8 jours, plus le dernier point d avant (la reference de −168 h) */
    const A = S.coursW || [];
    let i = 0;
    while (i + 1 < A.length && A[i + 1][0] <= now - COURS_GARDE_MS) i++;
    if (i) S.coursW = A.slice(i);
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
      /* Un etat d avant le 12/10 (sans couts, liens ni cours) : reconstruit UNE
         fois depuis la chaine, en gardant ce qui a deja ete dit — annonces,
         recharges, releves (le releve du jour ne repart pas). Rien n est
         annonce PENDANT la reconstruction (~2 a 5 min), mais elle s arrete au
         curseur de l ancien etat : le tic suivant lit l ecart et annonce ce qui
         a moins de 30 min, comme apres un simple redemarrage (voir construit). */
      if (S.construit && (S.schema || 1) < SCHEMA) {
        S.construit = false;
        compte('migrations');
        console.log(`[communaute] etat ecrit au schema ${S.schema || 1}, attendu ${SCHEMA} : reconstruction depuis la frappe (prix d achat, liens, cours), annonces et releves gardes`);
      }
      if (!S.construit) {
        if (now < prochainEssai) return { fait: 'attente' };
        /* La construction travaille sur un etat NEUF, qui ne garde que ce qui a
           deja ete dit (GARDES_CONSTRUCTION). Ratee, on revient a l ancien :
           aucun code, aucune piscine a moitie lus ne survit (relecture du 12/10 :
           un seul 503 figeait la paire hors des piscines pour toujours). */
        const ancien = S;
        /* une migration (ancien etat construit sous un schema d avant) est bornee
           a son curseur ; un essai rate garde la borne (l ancien etat revient) */
        const borne = (ancien.schema || 1) < SCHEMA && ancien.curseur > 0 ? ancien.curseur : 0;
        S = etatNeuf();
        for (const k of GARDES_CONSTRUCTION) if (ancien[k] !== undefined) S[k] = ancien[k];
        try { await construit(borne); }
        catch (e) {
          ancien.appels = S.appels; ancien.refus429 = S.refus429; ancien.compteurs = S.compteurs;
          S = ancien;
          prochainEssai = now + REESSAI_CONSTRUCTION_MS;
          console.log('[communaute] construction ratee, nouvel essai dans 10 min : ' + String(e && e.message).slice(0, 200));
          return { fait: 'echec', erreur: e.message };
        }
        /* la journee du CURSEUR (une migration bornee avant minuit laisse la
           veille ouverte : le tic la ferme au premier echange du lendemain) */
        S.jourCourant = jourParis(tempsDe(S.curseur));
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
          /* le cout et les liens (voir COUT, LIENS) : la jambe ETH vient du recu
             (Transfer WETH vers et depuis la paire), le prix de vente lu AVANT
             la mise a jour du cout ; une tx de liquidite n a pas de jambe */
          const r = recus.get(tx.h) || SANS_RECU;
          const vente = suit(net, r.liq ? null : { dW: r.weth, liq: false }, tx.logs);
          if (r.prixW) notePrix(t, r.prixW);
          if (k && k.qui) {
            k.neuf = !S.vus.has(k.qui);                // premiere apparition (voir NEUF)
            k.signataire = r.signataire;
            k.venteLue = !!(vente && vente.qui === k.qui && vente.lu);
            k.pnl = k.venteLue ? vente.pnl : null;
            if (!k.achat && !k.venteLue) {
              k.raisonVente = (net.get(PAIRE_PRIX) || 0n) === 0n ? 'paire' : vente && vente.qui === k.qui ? 'envois'
                : [...net].some(([a, d]) => d !== 0n && a !== PAIRE_PRIX && S.pools.has(a)) ? 'piscines' : '';
            }
            /* ce que le mode observe donne a relire (voir « A revoir ») : la part
               des ventes a prix connu, des achats relies */
            if (k.genre === 'paper' || k.genre === 'partielle') compte(!k.venteLue ? 'pnlVenteIllisible' : k.pnl === null ? 'pnlCoutInconnu' : 'pnlConnu');
            else if ((k.genre === 'nouveau' || k.genre === 'retour' || k.genre === 'believer') && groupe(k.qui).length) compte('achatsRelies');
          }
          for (const a of net.keys()) S.vus.add(a);
          if (k) {
            compte('genre_' + k.genre);
            if (k.qui) noteJour(t, k);
          }
          /* depuis quand il tenait, et par quelle tx il etait entre (voir TENUE,
             ENTREE) : lus AVANT que la sortie les efface ; une copie, l annonce
             y ajoute les heures des en-tetes */
          if (k && k.qui && k.genre === 'paper') {
            const e = entreeDe(S.tenue[k.qui]);
            k.tenueMs = e ? Math.max(0, t - e.t) : null;
            k.entree = e && e.h ? JSON.parse(JSON.stringify(e)) : null;
            compte('entree_' + (!k.entree ? 'inconnue' : k.entree.comment || 'autre'));
          }
          passages(net, avant, t, k);
          noteTenue(net, avant, t, tx, k);
          if (k && GENRES_ANNONCES.has(k.genre)) {
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
      await releveDu(now, aEnvoyer);
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
      `, detenteur >= 1 000 $SWOGE, seuils new ${MIN_USD.nouveau} $ / believer ${MIN_USD.believer} $ / paper ${MIN_USD.paper} $ / partielle ${MIN_USD.partielle} $ et ${PARTIELLE_PART_MIN * 100} % du sac, 1 annonce par adresse et par famille en 24 h, ${PLAFOND_HEURE}/h, rien au-dela de 30 min de retard` +
      `, gain/perte en ETH contre le prix d achat moyen, portefeuilles relies par envoi direct >= 1 000 $SWOGE (degre <= ${DEGRE_MAX}), cours 7 jours sur la chaine` +
      `, entree des paper hands (tx, achat ou envoyeur seul, achat d origine et sa part, heure UTC lue dans l en-tete en lecture courte)` +
      (C.exclus.length ? `, ${C.exclus.length} adresse(s) exclue(s) en plus` : '');
    if (C.mode === 'observe') return `[communaute] OBSERVATION (TG_COMMUNAUTE=observe) : ${base} — n annonce rien, aucune image`;
    return `[communaute] ANNONCES ARMEES (TG_COMMUNAUTE=1) sur le canal public : ${base} ; images ${deps.imageCle ? 'generees une fois (OPENAI_API_KEY posee)' : 'absentes : OPENAI_API_KEY non posee, texte seul'}`;
  }

  return {
    config: C, tic, images, ligneDemarrage,
    etat: () => { if (!S) S = litEtat(); return S; },
    journalImages: () => litImages(),
    chiffres: () => { if (!S) S = litEtat(); return chiffres(); },
    texteReleve: (now, cours) => { if (!S) S = litEtat(); return texteReleve(now, cours); },
    groupe: (a) => { if (!S) S = litEtat(); return groupe(a); },
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
  TOPIC_SYNC, TOPIC_SWAP_V3, PISCINE_ETH_USD, DECIMALES_USDG, FENETRE_ETH_USD, PART_CONNUE_MIN, EQUILIBRE_PCT,
  NONCE_NEUF_MAX, DEGRE_MAX, GROUPE_MAX, SEUIL_LIEN, FRAIS_VENTE_MAX, SCHEMA, PARTIELLE_PART_MIN,
  ANCRE_PAS, BLAGUES_PAPER, dureeTenue, blaguePaper, SWOGEBET, PART_POOL_MIN, detailPools, entreeDe, heureUtc,
  LECTURE_COURTE, ECART_ENTETE_MAX_MS, RECUL_429_MS,
  SCENES, GENRES_IMAGE, VERSION_IMAGES, ESSAIS_IMAGE_MAX, COUT_IMAGE_USD, ESPACE_RPC_MS, LOT_CODES, ESPACE_LOTS_MS,
  minuitParis, jourParis, fmtJetons,
};
