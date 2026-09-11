'use strict';
/*
 * SWOGE AI — LE MIROIR : TRADER AVEC LA COLONIE, AVEC SON PROPRE ARGENT
 *
 * « Generer un master wallet, tu envoies de l'ETH Robinhood, tu fais play, et
 *   SWOGE AI achete et vend en meme temps que lui. La cle privee, tu peux la
 *   telecharger ou la copier-coller. Quand tu appuies sur stop, ca revend tout
 *   et ca revient dans le wallet de ton compte. »
 *
 * ---- CE QUE CE FICHIER EST, ET CE QU'IL COUTE ----
 *
 * C'est un portefeuille PAR JOUEUR, dont la cle vit ici pendant qu'il trade.
 * Il n'y a pas d'autre facon de tenir la promesse : un bot qui achete pendant
 * que l'onglet du joueur est ferme signe forcement sans lui. Le dire est plus
 * honnete que de l'habiller.
 *
 * Ce que ca coute, en une phrase : QUI PREND CE SERVEUR PREND CES CLES. Le
 * coffre de jeu, lui, ne paie que contre un bon signe et cumulatif — un defaut
 * y coute un montant borne. Ici, une cle volee coute tout, tout de suite.
 *
 * Quatre choses reduisent la surface, et aucune ne l'annule :
 *
 *   1. UN PORTEFEUILLE PAR JOUEUR, jamais de caisse commune. Le rayon d'une
 *      fuite est un joueur, pas la salle.
 *   2. LES CLES NE SONT PAS DANS `state.json`. Elles vivent dans leur propre
 *      fichier, chiffrees en AES-256-GCM par une cle qui n'existe que dans
 *      l'environnement — donc absente de la sauvegarde Telegram, qui emporte
 *      `state.json`. Le chiffre seul ne vaut rien.
 *   3. UN PLAFOND PAR PORTEFEUILLE. Au-dela, le miroir refuse de demarrer et le
 *      dit : ce n'est pas un coffre, c'est une mise.
 *   4. LE JOUEUR A LA CLE AUSSI. Il peut vider son portefeuille a la seconde,
 *      sans nous demander. C'est la seule garantie qui ne depende pas de nous,
 *      et c'est pour ca qu'elle lui est donnee a la creation.
 *
 * ---- ET UN INTERRUPTEUR, PARCE QUE LA COLONIE N'EST PAS PRETE ----
 *
 * `MIROIR_EXECUTE` vaut `0` par defaut : le miroir suit la colonie, calcule
 * chaque ordre, le chiffre au devis du protocole, l'ecrit dans son journal — et
 * n'envoie RIEN sur la chaine. C'est le mode ou l'on verifie que ce fichier
 * fait ce qu'il dit avant qu'un centime bouge, et c'est aussi le seul mode
 * honnete tant que la colonie trade en papier : le papier ignore le gaz et le
 * glissement, qui sont justement les deux postes qui dominent sur des piscines
 * de mille dollars. Mesure du jour : les vingt dernieres ventes rendent +1,6 %
 * en moyenne, quand un aller-retour reel en coute cinq a dix.
 *
 * ---- ET LES MIROIRS SE MARCHENT DESSUS ----
 *
 * Vingt miroirs qui achetent le meme jeton dans le meme bloc poussent le prix
 * les uns contre les autres : le dernier entre paie le haut, le premier sorti
 * prend la sortie. `MIROIR_MAX` borne le nombre de miroirs actifs, et la mise
 * est bornee par un plafond en ETH, pas seulement par une part du solde.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const cfg = require('./config');

/* ---- UNISWAP V4 SUR ROBINHOOD CHAIN ----
 * Ces adresses ne sont pas devinees : ce sont celles que la page du
 * portefeuille utilise deja, eprouvees contre la chaine (un devis rendu au
 * jeton pres, un appel qui passe a ce montant et echoue un pour cent plus
 * haut). On reprend les memes plutot que d'en chercher d'autres. */
const PM4      = '0x8366a39CC670B4001A1121B8F6A443A643e40951';   // PoolManager
const QUOTEUR4 = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';   // V4Quoter
const ROUTEUR4 = '0x8876789976dEcBfCbBbe364623C63652db8C0904';   // Universal Router 2.1.1
const PERMIT2  = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/* En v4, l'ETH natif n'est pas le WETH : c'est l'adresse zero. */
const ETH4 = '0x0000000000000000000000000000000000000000';

/* ---- ET LES DEUX AUTRES PLACES ----
 * « Ca peut etre des pools v3 ou v2 aussi. » Mesure le 4 septembre, en
 * mode reel : ORE se traite sur une paire Uniswap v2, GOBLIN sur une piscine
 * v4 cotee en GLD. Le miroir ne connaissait que v4 contre l'ETH, et disait
 * « no v4 pool found » pour les deux — ce qui n'etait ni vrai ni utile.
 * Memes adresses que la page du portefeuille, eprouvees contre la chaine. */
const WETH      = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const ROUTEUR2  = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';   // UniswapV2Router02
const FABRIQUE2 = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const ROUTEUR3  = '0xcaf681a66d020601342297493863e78c959e5cb2';   // SwapRouter02 (v3, multicall)
const QUOTEUR3  = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
const FABRIQUE3 = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
/* « Garde le produit chez toi » : le routeur v3 lit cette adresse comme la
   sienne, et c'est ce qui permet de vendre puis de deballer le WETH en un
   seul appel. */
const ADRESSE_ROUTEUR = '0x0000000000000000000000000000000000000002';
const PALIERS3 = [100, 500, 3000, 10000];
const R2_ABI = [
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
];
const F2_ABI = ['function getPair(address,address) view returns (address)'];
const F3_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const Q3_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'];
const R3_ABI = [
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
];
const PAIRE_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function getReserves() view returns (uint112,uint112,uint32)',
];
const SYM_ABI = ['function symbol() view returns (string)'];

const CLE4_T  = '(address,address,uint24,int24,address)';
const SWAP4_T = '(' + CLE4_T + ',bool,uint128,uint128,uint256,bytes)';
const V4_SWAP = '0x10';                 // la commande du routeur
const ACTES4  = '0x060c0f';             // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
/* ---- UNE PISCINE V4 COTEE EN WETH, PAS EN ETH NATIF ----
 * « Could not follow the buy on SLINK: its pool is quoted in WETH, not ETH » —
 * ca aurait du passer. Sur v4 l'ETH natif est l'adresse zero, mais rien
 * n'empeche une piscine d'etre creee contre le WETH (le jeton ERC-20), et
 * SLINK l'est : currency0 = 0x0Bd7…, palier 0,01 %, avec un hook. Le miroir
 * ne connaissait que la forme native et refusait l'autre.
 * Le routeur sait faire : a l'achat il EMBALLE l'ETH recu (WRAP_ETH vers
 * lui-meme) et regle la piscine depuis son propre solde (SETTLE, payerIsUser
 * = false, montant OPEN_DELTA) ; a la vente il PREND le WETH chez lui (TAKE
 * vers ADDRESS_THIS, OPEN_DELTA) et le deballe vers le miroir (UNWRAP_WETH,
 * avec le meme minimum). Meme clef, meme quoteur, meme Permit2 qu'en natif. */
const WRAP_ETH    = '0x0b';
const UNWRAP_WETH = '0x0c';
const ACTES4_WETH_ACHAT = '0x060b0f';   // SWAP_EXACT_IN_SINGLE, SETTLE(WETH, open delta, router pays), TAKE_ALL
const ACTES4_WETH_VENTE = '0x060c0e';   // SWAP_EXACT_IN_SINGLE, SETTLE_ALL(jeton), TAKE(WETH → router, open delta)

const SUJET_INIT = ethers.utils.id(
  'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');

const UR_ABI = ['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'];
const Q4_ABI = ['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const PERMIT2_ABI = [
  'function allowance(address,address,address) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
];

/* ---- LES REGLAGES ----
 * Tous bornes, tous lisibles dans l'environnement. Les valeurs par defaut sont
 * celles d'un service qui vient de naitre : petites, faciles a monter une fois
 * qu'on a vu tourner. */
const nEnv = (k, d) => { const v = parseFloat(process.env[k]); return isFinite(v) ? v : d; };
const EXECUTE     = String(process.env.MIROIR_EXECUTE || '0') === '1';
const MIROIRS_MAX = Math.max(1, Math.round(nEnv('MIROIR_MAX', 25)));
/* ---- LE MINIMUM POUR JOUER SUIT LE PLANCHER PAR ORDRE ----
 * « Vérifie qu'il respecte bien les mises par rapport à notre capital. »
 * Mesure le 4 septembre, en reel : un miroir a 0,0023 ETH. La reserve de gaz
 * laisse 0,0008 ; la part du Banquier (3 %) en fait 0,000025 ETH d'ordre —
 * six centimes — quand une transaction coute 0,00003 ETH de gaz. Chaque
 * ordre perdait plus en gaz qu'il n'engageait. La part du Banquier est
 * juste pour une caisse de mille dollars ; sur cinq dollars elle ne veut
 * plus rien dire. Un ordre a donc un PLANCHER, et un miroir qui ne peut
 * pas le tenir n'ordonne pas : il le dit. */
const ORDRE_MIN_ETH = String(process.env.MIROIR_ORDRE_MIN || '0.001');
/* Le gaz d'un ordre ne doit pas depasser un dixieme de la mise : au-dela,
   c'est le gaz qu'on trade, pas le jeton. ~300 000 unites par echange. */
const GAZ_ORDRE_UNITES = 300000;
/* ==========================================================================
 * UN TRADE EST UN ALLER-RETOUR, PAS UN ORDRE
 *
 * « On est en negatif, le miroir perd des sous. »
 *
 * Releve du 11 septembre. Quatre jetons fermes le meme jour par DEUX
 * portefeuilles miroir, sur les memes signaux, aux memes instants. A chaque
 * fois, le PETIT portefeuille perd plus que le gros :
 *
 *     FLY       0,0061 ETH → -23,6 %   contre   0,0161 ETH → -22,0 %
 *     COO       0,0061 ETH → -36,0 %   contre   0,0166 ETH → -35,5 %
 *     SCOUT     0,0061 ETH → -10,3 %   contre   0,0166 ETH →  -8,8 %
 *     FLYSWARM  0,0061 ETH → -53,2 %   contre   0,0163 ETH → -37,7 %
 *
 * Quatre fois sur quatre, dans le meme sens. Ce n'est pas le marche : les deux
 * ordres suivent le meme jeton a la meme seconde. C'est le GAZ, qui est un
 * montant FIXE et pese donc deux fois plus sur un ordre deux fois plus petit.
 * En resolvant le systeme sur ces paires — meme mouvement de prix, deux
 * tailles — il sort entre 0,000052 et 0,000156 ETH par ALLER-RETOUR.
 *
 * Or le garde-fou ci-dessus comptait le gaz d'UN SEUL ECHANGE, et sans les
 * autorisations. Il mesurait donc moins de la moitie de ce qu'un trade coute
 * vraiment — `gazDeVente`, dix lignes plus bas, compte bien l'echange PLUS
 * l'autorisation, et il le fait pour une seule jambe. Un ordre dont le gaz
 * reel mangeait un quart de la mise passait ce controle sans difficulte.
 *
 * On compte donc les deux jambes, chacune avec son autorisation, exactement
 * comme `gazDeVente`. Le seuil, lui, ne bouge PAS : ce n'est pas un chiffre
 * choisi qu'on remplace par un autre, c'est une arithmetique fausse qu'on
 * corrige. A 10 % d'un aller-retour au lieu de 10 % d'une demi-jambe, le meme
 * reglage refuse desormais ce qu'il aurait toujours du refuser.
 * ======================================================================== */
const GAZ_ALLER_RETOUR_UNITES = (GAZ_ORDRE_UNITES + 60000) * 2;
const GAZ_PART_MAX = Math.min(0.5, Math.max(0.01, nEnv('MIROIR_GAZ_PART_MAX', 0.1)));
/* ---- L'ALLER-RETOUR, AVANT DE PARTIR ----
 * SLINK, 4 septembre : l'achat de 0,001 ETH simule et passe ; la vente de ce
 * qu'il rend, demandee au meme quoteur, rend 0,0000001 WETH — zero. Une
 * piscine avec un hook qui laisse entrer et ne laisse pas sortir. Le papier
 * de la colonie ne le sent pas : il « vend » au prix affiche. Un ordre reel
 * le sentirait, une fois. Avant chaque achat, le miroir demande donc au
 * quoteur ce que rendrait la vente immediate de ce qu'il va recevoir : sous
 * cette part de la mise, il n'achete pas, et dit pourquoi. Sur une piscine
 * saine, un petit ordre revient a 98–99 % ; le seuil laisse la place aux
 * frais et a l'impact, pas a une porte fermee. */
const RETOUR_MIN = Math.min(0.95, Math.max(0.1, nEnv('MIROIR_RETOUR_MIN', 0.6)));
/* ---- LES PONTS : LES PAIRES COTEES EN ACTIONS ----
 * « Il n'y a plus de trades, les filtres sont trop stricts. » 8 septembre, un
 * tour : 39 jetons examines, 18 cotes en NVDA, USDG ou GOOGL, 0 en ETH. Les
 * lancements de cette chaine se font contre des actions tokenisees, et le
 * miroir ne savait acheter qu'avec de l'ETH en entree. Mesure le meme soir :
 * ETH/USDG 8,9 M$ de liquidite (v4), ETH/NVDA 1,2 M$ (v3), ETH/SPY 1,9 M$,
 * ETH/GLD 0,7 M$, ETH/GOOGL 46 k$. Un ordre de 0,01 ETH passe sans impact
 * sur les quatre premiers.
 *
 * Un PONT est la piscine ETH <-> monnaie la plus profonde. Une position
 * cotee en NVDA se prend en DEUX jambes — ETH vers NVDA sur le pont, NVDA
 * vers le jeton sur sa piscine — et se rend de meme. Deux transactions par
 * sens, le double de gaz, et une jambe qui peut echouer apres l'autre :
 * c'est pour ca que la liste est courte, lisible, et vide par choix quand
 * on ne veut que l'ETH. Le pont se cherche par ADRESSE et se gagne par
 * liquidite : trois adresses portent le symbole NVDA sur cette chaine, une
 * seule a la liquidite. */
const PONTS = String(process.env.MIROIR_PONTS === undefined ? 'USDG,NVDA' : process.env.MIROIR_PONTS)
  .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const PONT_LIQ_MIN = Math.max(10000, nEnv('MIROIR_PONT_LIQ_MIN', 200000));
const PONT_TTL_MS = 3600e3;          /* un pont mesure vaut une heure */
/* ---- ET LES PONTS RESTENT EN ESSAI TANT QU'ON NE LES A PAS VUS TOURNER ----
 * Le miroir execute en reel (MIROIR_EXECUTE=1) ; une position pontee, elle,
 * ne part sur la chaine que si MIROIR_PONTS_EXECUTE=1. Avant : le journal
 * montre ce qu'un ordre reel aurait fait, deux jambes comprises, et rien ne
 * part. C'est le meme interrupteur, au meme endroit, que pour le reste. */
const PONTS_EXECUTE = String(process.env.MIROIR_PONTS_EXECUTE || '0') === '1';
const PONT_ECHEC_MS = 10 * 60000;    /* un pont introuvable est recherche de nouveau apres dix minutes */
const MIN_ETH_CONF = String(process.env.MIROIR_MIN_ETH || '0.005');
const MAX_ETH     = String(process.env.MIROIR_MAX_ETH || '0.5');
/* La part du solde engagee par ordre. La colonie ouvre plusieurs positions a la
   fois ; a un dixieme, un miroir peut en tenir dix avant d'etre a sec. */
const PART_ORDRE  = Math.min(0.5, Math.max(0.01, nEnv('MIROIR_PART', 0.1)));
/* Et un plafond en dur par ordre : la part seule laisse un gros portefeuille
   envoyer, sur une piscine de mille dollars, un ordre que la piscine ne peut
   pas absorber — il paierait son propre impact des deux cotes. */
const ORDRE_MAX_ETH = String(process.env.MIROIR_ORDRE_MAX || '0.05');
/* Ce qu'on garde toujours pour le gaz : un miroir qui met tout son ETH dans un
   achat ne peut plus jamais vendre, et c'est la pire panne possible ici. */
const GAZ_RESERVE = String(process.env.MIROIR_GAZ || '0.0015');
/* Le minimum pour jouer ne peut pas etre sous la reserve plus un ordre : un
   reglage plus bas laisserait entrer un miroir qui ne pourra jamais ordonner,
   et qui le decouvrirait au premier signal. */
const MIN_ETH = (function () {
  const conf = ethers.utils.parseUnits(MIN_ETH_CONF, 18);
  const plancher = ethers.utils.parseUnits(GAZ_RESERVE, 18).add(ethers.utils.parseUnits(ORDRE_MIN_ETH, 18));
  return conf.gte(plancher) ? MIN_ETH_CONF : ethers.utils.formatUnits(plancher, 18);
})();
/* ==========================================================================
 * LE PLANCHER D'UN ORDRE EST EN DOLLARS
 *
 * « Il y a des personnes qui n'ont pas les moyens de mettre 1000 $, donc elles
 *   tradent trop petit. Une regle : la mise minimum sur le miroir, c'est 15 $,
 *   meme si la banque est trop petite. Les grosses banques n'ont pas ce
 *   souci. »
 *
 * Le plancher existait, mais en ETH — 0,001, soit 2,49 $ au cours du
 * 9 septembre. C'est sous ce qu'un aller-retour coute sur ces piscines. Un
 * portefeuille de cinquante dollars prenait donc, a un dixieme du disponible,
 * des positions de cinq dollars dont le gaz des deux cotes mange la moitie du
 * mouvement : il ne pouvait pas gagner, quoi que la colonie trouve. Le
 * plancher en ETH avait en plus le defaut de flotter avec le cours, alors que
 * le gaz, lui, se compte en dollars pour celui qui le paie.
 *
 * Il est donc en DOLLARS et il est TENU : sous la part du Banquier, la mise
 * monte a quinze dollars si le disponible le permet. Un petit portefeuille
 * tient donc moins de positions a la fois, mais des positions qui peuvent
 * rendre quelque chose — et c'est le seul arbitrage disponible quand la caisse
 * est petite. Au-dessus, rien ne change : la part du Banquier depasse le
 * plancher, et c'est elle qui decide.
 *
 * Le cours de l'ETH se lit sur la paire WETH la plus profonde de la chaine
 * (31 M$ de liquidite contre le dollar au 9 septembre), pas sur une source
 * exterieure de plus. Sans cours lisible on retombe sur le plancher en ETH, et
 * on le dit : convertir avec un chiffre qu'on n'a pas serait inventer la mise.
 * ======================================================================== */
const ORDRE_MIN_USD = Math.max(0, nEnv('MIROIR_ORDRE_MIN_USD', 15));
const ETH_USD_TTL = 10 * 60000;
let ethUsd = { v: 0, t: 0 };
let sourceEthUsd = async function () {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + WETH, { signal: ac.signal });
    if (!r.ok) return 0;
    const j = await r.json();
    /* Les paires ou le WETH est la BASE : c'est la que `priceUsd` est le cours
       de l'ETH. La plus profonde gagne. */
    const l = (j.pairs || [])
      .filter((x) => String(x.chainId || '').toLowerCase() === 'robinhood'
                  && String((x.baseToken || {}).address || '').toLowerCase() === norm(WETH)
                  && Number(x.priceUsd) > 0)
      .sort((a, b) => Number((b.liquidity || {}).usd || 0) - Number((a.liquidity || {}).usd || 0));
    return l.length ? Number(l[0].priceUsd) : 0;
  } catch (e) { return 0; }
  finally { clearTimeout(t); }
};
function poseSourceEthUsd(f) { sourceEthUsd = f; }
async function litEthUsd() {
  if (ethUsd.v > 0 && Date.now() - ethUsd.t < ETH_USD_TTL) return ethUsd.v;
  let v = 0;
  try { v = Number(await sourceEthUsd()); } catch (e) { v = 0; }
  if (isFinite(v) && v > 0) ethUsd = { v, t: Date.now() };
  return ethUsd.v > 0 && Date.now() - ethUsd.t < ETH_USD_TTL ? ethUsd.v : 0;
}
/** Le cours deja lu, ou zero. Jamais d'appel : les decisions se prennent sur ce
 *  qu'on SAIT, et la lecture se fait a un endroit nomme. */
function coursEth() { return (ethUsd.v > 0 && Date.now() - ethUsd.t < ETH_USD_TTL) ? ethUsd.v : 0; }
function oublieLeCours() { ethUsd = { v: 0, t: 0 }; }
/** Le plancher d'un ordre, en wei : le plus haut des deux, celui en ETH et
 *  celui en dollars. Sans cours, celui en ETH seul. */
function plancherOrdre() {
  const enEth = WEI(ORDRE_MIN_ETH);
  const c = coursEth();
  if (!(c > 0) || !(ORDRE_MIN_USD > 0)) return enEth;
  const enUsd = WEI((ORDRE_MIN_USD / c).toFixed(18));
  return enUsd.gt(enEth) ? enUsd : enEth;
}
/** Ce qu'il faut sur le portefeuille pour jouer : la reserve de gaz plus un
 *  ordre au plancher. Il suit donc le cours, comme le plancher. */
function minPourJouer() {
  const p = WEI(GAZ_RESERVE).add(plancherOrdre());
  const conf = WEI(MIN_ETH_CONF);
  return ethers.utils.formatUnits(conf.gte(p) ? conf : p, 18);
}
/* La tolerance de glissement. Large, parce que ces piscines bougent entre le
   devis et le bloc suivant ; la taille de l'ordre borne deja l'impact. */
const TOLERANCE_BPS = Math.min(3000, Math.max(50, Math.round(nEnv('MIROIR_TOLERANCE_BPS', 500))));
const ECHEANCE_S = 300;
const JOURNAL_MAX = 60;
/* Une pause entre deux miroirs : trente signatures dans le meme bloc sur le
   meme noeud public, c'est la coupure assuree. */
const PAUSE_MS = Math.max(0, Math.round(nEnv('MIROIR_PAUSE_MS', 400)));

const FICHIER = path.join(cfg.DATA_DIR, 'miroirs.json');

const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (a) => String(a || '').toLowerCase();
const WEI = (x) => ethers.utils.parseUnits(String(x), 18);

/* ==================== LE CHIFFREMENT DES CLES ====================
 *
 * AES-256-GCM : il chiffre ET authentifie, donc un chiffre modifie ne se
 * dechiffre pas en silence — il refuse. La cle vient de `MIROIR_CLE`, passee
 * par scrypt : une phrase courte devient une cle de 32 octets sans qu'on ait a
 * exiger de l'operateur qu'il en ecrive une en hexadecimal.
 *
 * Sans `MIROIR_CLE`, ce module ne cree AUCUN portefeuille. Ecrire des cles en
 * clair « en attendant » est exactement le geste qu'on regrette. */
const SEL = Buffer.from('swoge-miroir-v1');
let _cleCache = null;
function cleMaitresse() {
  const brut = String(process.env.MIROIR_CLE || '').trim();
  if (!brut) return null;
  if (!_cleCache || _cleCache.brut !== brut) {
    _cleCache = { brut, cle: crypto.scryptSync(brut, SEL, 32) };
  }
  return _cleCache.cle;
}
function chiffre(texte) {
  const k = cleMaitresse();
  if (!k) throw new Error('MIROIR_CLE is not configured');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const out = Buffer.concat([c.update(texte, 'utf8'), c.final()]);
  return 'v1.' + iv.toString('hex') + '.' + c.getAuthTag().toString('hex') + '.' + out.toString('hex');
}
function dechiffre(paquet) {
  const k = cleMaitresse();
  if (!k) throw new Error('MIROIR_CLE is not configured');
  const m = String(paquet || '').split('.');
  if (m.length !== 4 || m[0] !== 'v1') throw new Error('unreadable key envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(m[1], 'hex'));
  d.setAuthTag(Buffer.from(m[2], 'hex'));
  return Buffer.concat([d.update(Buffer.from(m[3], 'hex')), d.final()]).toString('utf8');
}

/* ==================== LE REGISTRE ====================
 *
 * Son propre fichier, et ce n'est pas du rangement : `state.json` part dans le
 * canal Telegram a chaque sauvegarde. Un registre de cles, meme chiffrees, n'a
 * rien a faire dans un canal — le jour ou la cle d'environnement fuit, il ne
 * doit pas exister de copie du chiffre ailleurs.
 */
let R = { v: 1, comptes: {} };

function charge() {
  try {
    const j = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
    if (j && j.comptes) R = j;
  } catch (e) { /* pas de fichier : registre neuf. C'est le cas au premier jour */ }
  return R;
}
function sauve() {
  try {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    /* Un temporaire puis un renommage : une coupure au milieu d'une ecriture
       laisserait un fichier tronque, et un registre de cles tronque est une
       perte de FONDS, pas une perte de donnees. */
    const tmp = FICHIER + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(R), { mode: 0o600 });
    fs.renameSync(tmp, FICHIER);
  } catch (e) { console.warn('[miroir] sauvegarde impossible :', e.message); }
}
function fiche(joueur) { return R.comptes[norm(joueur)] || null; }
function actifs() {
  return Object.entries(R.comptes)
    .filter(([, c]) => c && c.actif)
    .map(([j, c]) => ({ joueur: j, c }));
}
/* ==================== CE QU UNE ERREUR VEUT DIRE ====================
 * ethers rend, pour un ordre refuse, l objet entier de la transaction : cinq
 * lignes de JSON dans le journal du joueur, et pas un mot sur ce qui s est
 * passe. On traduit les codes qu on connait ; le reste garde sa premiere
 * ligne. Chaque phrase dit si de l argent est parti : c est la question. */
function resume(e) {
  const code = e && e.code;
  if (code === 'UNPREDICTABLE_GAS_LIMIT' || code === 'CALL_EXCEPTION')
    return 'the chain refused to simulate this order, it would revert — slippage past the tolerance, a transfer tax, '
      + 'or a pool that will not take this size. Nothing was sent, nothing was spent';
  if (code === 'INSUFFICIENT_FUNDS')
    return 'not enough ETH (RH) for the order plus its gas. Nothing was sent';
  if (code === 'NONCE_EXPIRED' || code === 'REPLACEMENT_UNDERPRICED')
    return 'a previous transaction of this wallet is still pending; the order will be retried on the next signal';
  if (code === 'TIMEOUT' || code === 'SERVER_ERROR' || code === 'NETWORK_ERROR')
    return 'the node did not answer in time (' + code + '). If a transaction was sent it will settle on its own; the balance is re-read at the next state';
  const msg = String((e && (e.reason || e.message)) || e || 'unknown error');
  return msg.split('\n')[0].split(' [ See:')[0].slice(0, 200);
}

function note(c, txt, extra) {
  if (!Array.isArray(c.journal)) c.journal = [];
  c.journal.unshift(Object.assign({ t: Date.now(), txt }, extra || {}));
  if (c.journal.length > JOURNAL_MAX) c.journal = c.journal.slice(0, JOURNAL_MAX);
}

/* ==================== LA CHAINE ====================
 * Tout ce qui la touche passe par ici, et par ici seulement : c'est ce qui rend
 * le reste du fichier verifiable sans chaine. */
let _prov = null;
function provider() {
  if (!_prov) _prov = new ethers.providers.StaticJsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID);
  return _prov;
}
function poseProvider(p) { _prov = p; }

/** L'identifiant d'une piscine v4 : la somme de ses cinq champs. Il se
    recalcule au bit pres, et c'est ce qui permet de VERIFIER qu'une clef lue
    dans un evenement est bien celle de la piscine qu'on cherche. */
function idV4(k) {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode([CLE4_T], [k]));
}

/** La clef d'une piscine, retrouvee sur la chaine.
 *
 * Il n'y a pas de fabrique a interroger : une piscine v4 n'existe que par ses
 * cinq champs, et le HOOK en fait partie — rien ne se devine. On lit les
 * evenements `Initialize` du PoolManager.
 *
 * ---- L'ORDRE DES SUJETS, MESURE SUR LA CHAINE ----
 * L'evenement est `Initialize(id indexed, currency0 indexed, currency1
 * indexed, fee, tickSpacing, hooks, sqrtPrice, tick)` : le PREMIER sujet
 * indexe est l'identifiant de la piscine, les deux monnaies viennent APRES.
 * Ce fichier filtrait [signature, monnaie0, monnaie1] — une adresse a la
 * place d'un identifiant — et la chaine repondait zero evenement, toujours.
 * Verifie le 4 septembre sur TRN : [sig, id] rend le bloc 54423937 avec
 * ETH/TRN en sujets 2 et 3 ; l'ancien filtre rend zero sur un million de
 * blocs. Le banc ne l'avait pas vu parce que sa fausse chaine renvoyait
 * l'evenement quels que soient les sujets demandes. Il ne le fait plus.
 *
 * Quand la colonie donne l'identifiant, on demande PAR identifiant : c'est
 * une lecture, et les monnaies arrivent avec. Sans identifiant, on cherche
 * par les deux monnaies, l'ETH et le jeton. Et dans les deux cas
 * l'identifiant recalcule doit tomber sur celui du sujet : un index faux
 * pourrait nous faire rater une piscine, il ne peut pas nous en faire
 * inventer une. */
async function clePiscine(jeton, pool, fenetre) {
  const p = provider();
  const mot = (a) => ethers.utils.hexZeroPad(a, 32);
  const tip = await p.getBlockNumber();
  const depuis = Math.max(0, tip - (fenetre || 1000000));
  const lit = (topics, dep) => p.getLogs({ address: PM4, fromBlock: dep === undefined ? depuis : dep, toBlock: tip, topics });
  const paire = norm(ETH4) < norm(jeton) ? [ETH4, jeton] : [jeton, ETH4];
  const parId = !!(pool && /^0x[0-9a-fA-F]{64}$/.test(String(pool)));
  let logs = [];
  try {
    if (parId) logs = await lit([SUJET_INIT, String(pool).toLowerCase()]);
    if (!logs.length) logs = await lit([SUJET_INIT, null, mot(paire[0]), mot(paire[1])]);
  } catch (e) { throw new Error('pool lookup failed: ' + e.message); }
  const trouve = choisisLaPiscine(logs, jeton, pool, parId);
  if (trouve) return trouve;
  /* ---- UNE PISCINE PLUS VIEILLE QUE LA FENETRE ----
   * ETH/USDG, 8,9 M$ de liquidite, le pont le plus profond de la chaine :
   * creee au bloc 41 259 014, seize millions de blocs avant la fenetre du
   * million. « Not found in the last million blocks » — et le pont n'existait
   * pas. Par identifiant, une seule reponse est possible : on relit depuis
   * le premier bloc (263 ms sur le noeud officiel, mesure le 8 septembre). */
  if (parId && !fenetre) {
    let vieux = [];
    try { vieux = await lit([SUJET_INIT, String(pool).toLowerCase()], 0); }
    catch (e) { throw new Error('pool lookup failed: ' + e.message); }
    return choisisLaPiscine(vieux, jeton, pool, parId);
  }
  return null;
}
/** Parmi des evenements Initialize, celui dont la clef recompose l'identifiant
 *  demande — ou, sans identifiant, le premier dont la clef se recompose. */
function choisisLaPiscine(logs, jeton, pool, parId) {
  for (const l of logs) {
    if (!l.topics || l.topics.length < 4) continue;
    const c0 = ethers.utils.getAddress('0x' + l.topics[2].slice(26));
    const c1 = ethers.utils.getAddress('0x' + l.topics[3].slice(26));
    const d = ethers.utils.defaultAbiCoder.decode(
      ['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
    const k = [c0, c1, d[0], d[1], d[2]];
    const id = idV4(k);
    if (norm(id) !== norm(l.topics[1])) continue;           /* la clef ne recompose pas l id : pas la notre */
    if (parId && norm(id) !== norm(pool)) continue;
    const coteEth = (c) => norm(c) === norm(ETH4) || norm(c) === norm(WETH);
    const zeroEstEth = coteEth(c0), unEstEth = coteEth(c1);
    if (!zeroEstEth && !unEstEth)
      return { cle: k, id, zeroEstEth: false, contreEth: false,
               autre: norm(c0) === norm(jeton) ? c1 : c0 };
    /* En WETH : le cote ETH est le jeton emballe, et l'ordre devra emballer
       et deballer lui-meme. */
    const enWeth = norm(zeroEstEth ? c0 : c1) === norm(WETH);
    return { cle: k, id, zeroEstEth, contreEth: true, enWeth };
  }
  return null;
}

/** Le symbole d'un jeton, pour une phrase — ou son adresse courte s'il n'en
 *  a pas. Jamais une exception : c'est du texte. */
async function symbole(adr) {
  try {
    const s = await new ethers.Contract(adr, SYM_ABI, provider()).symbol();
    if (s && String(s).trim()) return String(s).trim().slice(0, 12);
  } catch (e) { /* pas de symbole lisible */ }
  return String(adr).slice(0, 8) + '…';
}

/* ==================== LA ROUTE ====================
 *
 * Ou se traite ce jeton contre l'ETH : v4 (une clef), v3 (une piscine et
 * son palier), v2 (une paire). La colonie donne ce que DexScreener publie —
 * un identifiant de 32 octets pour v4, une adresse pour v2 et v3 — et c'est
 * CETTE place qu'on doit echanger, pas une autre du meme jeton.
 *
 * Une adresse est v3 si elle repond a `fee()`, v2 si elle repond a
 * `getReserves()` : une paire v2 n'a pas de palier, et une piscine v3 n'a pas
 * de reserves. Et si ni l'une ni l'autre des deux monnaies n'est l'ETH, on
 * le dit avec le nom de l'autre : « quoted in GLD, not ETH » est une raison ;
 * « no pool » n'en etait pas une. */
async function routeDe(jeton, pool) {
  const p = provider();
  if (pool && /^0x[0-9a-fA-F]{40}$/.test(String(pool))) {
    const pr = new ethers.Contract(pool, PAIRE_ABI, p);
    let t0, t1;
    try { [t0, t1] = await Promise.all([pr.token0(), pr.token1()]); }
    catch (e) { throw new Error('the pool address given by the colony does not answer like a pair (' + String(pool).slice(0, 10) + '…)'); }
    /* L'autre monnaie de la paire : l'ETH, ou une monnaie qu'un pont sait
       rejoindre — sinon c'est dit avec son nom. */
    const m = await monnaieDe(norm(t0) === norm(jeton) ? t1 : t0);
    let fee = null;
    try { fee = Number(await pr.fee()); } catch (e) { fee = null; }
    if (fee !== null && isFinite(fee)) return avecMonnaie({ ver: 'v3', paire: ethers.utils.getAddress(pool), fee }, m);
    try { await pr.getReserves(); }
    catch (e) { throw new Error('the pool address given by the colony is neither a v2 pair nor a v3 pool (' + String(pool).slice(0, 10) + '…)'); }
    return avecMonnaie({ ver: 'v2', paire: ethers.utils.getAddress(pool) }, m);
  }
  const p4 = await clePiscine(jeton, pool);
  if (p4) {
    if (!p4.contreEth) {
      const m = await monnaieDe(p4.autre);
      /* `zeroEstEth` dit, sur une piscine pontee, si currency0 est la MONNAIE :
         c'est le cote « contre » de la piscine, celui d'ou l'on entre. */
      return avecMonnaie({ ver: 'v4', cle: p4.cle, id: p4.id, zeroEstEth: norm(p4.cle[0]) === norm(m.adr), enWeth: false }, m);
    }
    return { ver: 'v4', cle: p4.cle, id: p4.id, zeroEstEth: p4.zeroEstEth, enWeth: !!p4.enWeth, monnaie: MONNAIE_ETH, pont: null };
  }
  if (!pool) {
    /* Sans indication de la colonie : les fabriques, dans l'ordre ou la
       liquidite se trouve d'habitude sur cette chaine. */
    const f3 = new ethers.Contract(FABRIQUE3, F3_ABI, p);
    for (const fee of PALIERS3) {
      let a = null; try { a = await f3.getPool(WETH, jeton, fee); } catch (e) { a = null; }
      if (a && norm(a) !== norm(ETH4)) return { ver: 'v3', paire: ethers.utils.getAddress(a), fee };
    }
    const f2 = new ethers.Contract(FABRIQUE2, F2_ABI, p);
    let a = null; try { a = await f2.getPair(WETH, jeton); } catch (e) { a = null; }
    if (a && norm(a) !== norm(ETH4)) return { ver: 'v2', paire: ethers.utils.getAddress(a) };
  }
  throw new Error('no pool against ETH found for this token'
                  + (pool ? ' (v4 id ' + String(pool).slice(0, 10) + '… given by the colony, not found in the last million blocks)' : ''));
}
const MONNAIE_ETH = { adr: ETH4, sym: 'ETH', eth: true, dec: 18 };
/** La route, avec sa monnaie et son pont quand il en faut un. Les routes en
 *  ETH portent `monnaie: ETH` et `pont: null` : une seule forme partout. */
function avecMonnaie(r, m) {
  r.monnaie = { adr: m.adr, sym: m.sym, eth: !!m.eth, dec: m.dec === undefined ? 18 : m.dec };
  r.pont = m.eth ? null : m.pont;
  return r;
}
/** Ce qu'est l'autre monnaie d'une piscine : l'ETH (natif ou emballe), ou une
 *  monnaie de la liste des ponts avec un pont assez profond — sinon une
 *  erreur qui dit laquelle, et pourquoi. */
async function monnaieDe(adr) {
  if (norm(adr) === norm(ETH4) || norm(adr) === norm(WETH)) return MONNAIE_ETH;
  const sym = await symbole(adr);
  if (PONTS.indexOf(sym.toUpperCase()) < 0)
    throw new Error('its pool is quoted in ' + sym + ', not ETH: the mirror only crosses '
                    + (PONTS.length ? PONTS.join(', ') : 'nothing') + ' (MIROIR_PONTS)');
  const pont = await pontPour(adr, sym);
  return { adr: ethers.utils.getAddress(adr), sym, eth: false, dec: pont.dec, pont: pont.route };
}
/* ==================== LES PONTS ====================
 * Par adresse de monnaie : la route ETH <-> monnaie la plus profonde, lue sur
 * DexScreener et verifiee sur la chaine, gardee une heure. Un pont introuvable
 * est note aussi, avec sa raison, et cherche de nouveau apres dix minutes. */
const PONTS_VUS = {};
const PONTS_EN_COURS = {};
async function pontPour(adr, sym) {
  const k = norm(adr);
  const vu = PONTS_VUS[k];
  const now = Date.now();
  if (vu && vu.route && now - vu.t < PONT_TTL_MS) return vu;
  if (vu && !vu.route && now - vu.t < PONT_ECHEC_MS) throw new Error(vu.raison);
  if (PONTS_EN_COURS[k]) return PONTS_EN_COURS[k];
  PONTS_EN_COURS[k] = (async () => {
    try {
      let paires = [];
      try { paires = await sourcePaires(adr); } catch (e) { paires = []; }
      const contreEth = paires.filter((x) => x.pool && x.liq > 0
        && (ADRESSES_ETH_PLACE.indexOf(norm(x.quote)) >= 0 || (x.base && ADRESSES_ETH_PLACE.indexOf(norm(x.base)) >= 0)))
        .sort((a, b) => b.liq - a.liq);
      const meilleure = contreEth[0];
      if (!meilleure || meilleure.liq < PONT_LIQ_MIN) {
        const raison = 'quoted in ' + sym + ', and no ETH bridge deep enough for it'
          + (meilleure ? ' (best ' + Math.round(meilleure.liq) + ' $ of liquidity, ' + PONT_LIQ_MIN + ' needed)' : ' (no ETH pair listed)');
        PONTS_VUS[k] = { t: Date.now(), route: null, raison, sym };
        throw new Error(raison);
      }
      const route = await routeDe(adr, meilleure.pool);
      if (!route.monnaie || !route.monnaie.eth) throw new Error('the bridge pool of ' + sym + ' is not against ETH');
      let dec = 18;
      try { dec = Number(await new ethers.Contract(adr, ERC20_ABI, provider()).decimals()); } catch (e) { dec = 18; }
      if (!isFinite(dec) || dec < 0 || dec > 36) dec = 18;
      PONTS_VUS[k] = { t: Date.now(), route, liq: meilleure.liq, dec, sym };
      return PONTS_VUS[k];
    } finally { delete PONTS_EN_COURS[k]; }
  })();
  return PONTS_EN_COURS[k];
}
/** Pour la colonie, qui decide en synchrone : ce pont est-il connu et bon ?
 *  Inconnu, on le cherche en arriere-plan et on repond non — au tour suivant,
 *  la reponse est la. Hors liste, non tout court, sans rien chercher. */
function pontConnu(adr, sym) {
  const s = String(sym || '').toUpperCase();
  if (!adr || PONTS.indexOf(s) < 0) return false;
  const vu = PONTS_VUS[norm(adr)];
  const now = Date.now();
  if (vu && vu.route && now - vu.t < PONT_TTL_MS) return true;
  if (vu && !vu.route && now - vu.t < PONT_ECHEC_MS) return false;
  pontPour(adr, s).catch(() => {});
  return false;
}
function oublieLesPonts() { for (const k in PONTS_VUS) delete PONTS_VUS[k]; }
/** Pour l'ecran : la liste des ponts, et ce qu'on sait de chacun. */
function pontsVus() {
  return Object.keys(PONTS_VUS).map((adr) => {
    const v = PONTS_VUS[adr];
    return { adr, sym: v.sym || null, ok: !!v.route, liq: v.liq || null, ver: v.route ? v.route.ver : null,
             raison: v.raison || null, t: v.t };
  });
}

/** Ce que rend un echange v4, demande au quoteur du protocole lui-meme. */
async function devis(cleP, zeroVersUn, entree) {
  const q = new ethers.Contract(QUOTEUR4, Q4_ABI, provider());
  const r = await q.callStatic.quoteExactInputSingle({
    poolKey: { currency0: cleP[0], currency1: cleP[1], fee: cleP[2],
               tickSpacing: cleP[3], hooks: cleP[4] },
    zeroForOne: zeroVersUn, exactAmount: entree, hookData: '0x',
  });
  return ethers.BigNumber.from(r.amountOut !== undefined ? r.amountOut : r[0]);
}

/** Le devis sur n'importe quelle route, dans un sens ou dans l'autre. Chaque
 *  place a son quoteur ; aucun n'est remplace par une regle de trois. */
/** Le cote « contre » d'une route sur v2 et v3 : le WETH, ou la monnaie du
 *  pont quand la piscine est cotee en NVDA. */
function contre(r) { return r.monnaie && !r.monnaie.eth ? r.monnaie.adr : WETH; }
async function devisJambe(r, sens, jeton, montant) {
  const achat = sens === 'achat';
  if (r.ver === 'v4') return devis(r.cle, achat ? r.zeroEstEth : !r.zeroEstEth, montant);
  const C = contre(r);
  if (r.ver === 'v2') {
    const v2 = new ethers.Contract(ROUTEUR2, R2_ABI, provider());
    const a = await v2.getAmountsOut(montant, achat ? [C, jeton] : [jeton, C]);
    return ethers.BigNumber.from(a[a.length - 1]);
  }
  const q = new ethers.Contract(QUOTEUR3, Q3_ABI, provider());
  const x = await q.callStatic.quoteExactInputSingle({
    tokenIn: achat ? C : jeton, tokenOut: achat ? jeton : C,
    amountIn: montant, fee: r.fee, sqrtPriceLimitX96: 0,
  });
  return ethers.BigNumber.from(x.amountOut !== undefined ? x.amountOut : x[0]);
}
/** Le devis de la route ENTIERE : une jambe en ETH, deux avec un pont — ce que
 *  le pont rend en monnaie entre dans la piscine du jeton, et inversement. */
async function devisRoute(r, sens, jeton, montant) {
  if (!r.pont) return devisJambe(r, sens, jeton, montant);
  if (sens === 'achat') {
    const m = await devisJambe(r.pont, 'achat', r.monnaie.adr, montant);
    if (m.lte(0)) return m;
    return devisJambe(r, 'achat', jeton, m);
  }
  const m = await devisJambe(r, 'vente', jeton, montant);
  if (m.lte(0)) return m;
  return devisJambe(r.pont, 'vente', r.monnaie.adr, m);
}

/** Le corps d'un echange v4, pret pour `execute`. Une seule forme sert les deux
    sens : c'est `zeroForOne` qui dit lequel. */
function corpsV4(k, zeroVersUn, entree, mini) {
  const A = ethers.utils.defaultAbiCoder;
  return A.encode(['bytes', 'bytes[]'], [ACTES4, [
    A.encode([SWAP4_T], [[k, zeroVersUn, entree, mini, 0, '0x']]),
    A.encode(['address', 'uint256'], [zeroVersUn ? k[0] : k[1], entree]),
    A.encode(['address', 'uint256'], [zeroVersUn ? k[1] : k[0], mini]),
  ]]);
}

/** La transaction d'un ordre, ENTIEREMENT construite ici : a qui, quoi, et
 *  combien d'ETH. Aucune chaine n'est touchee — c'est ce qui permet au banc
 *  de decoder le calldata reel de chaque place et de verifier chaque champ,
 *  sans signer. `vers` est le portefeuille du miroir. */
function ordre(r, sens, jeton, montant, mini, vers, echeance) {
  const achat = sens === 'achat';
  /* La jambe du jeton sur une piscine pontee : un ERC-20 des deux cotes, pas
     d'ETH en valeur, rien a emballer — l'entree passe par l'autorisation. */
  const enMonnaie = !!(r.monnaie && !r.monnaie.eth);
  if (r.ver === 'v4') {
    const i = new ethers.utils.Interface(UR_ABI);
    const A = ethers.utils.defaultAbiCoder;
    const k = r.cle, zeroVersUn = achat ? r.zeroEstEth : !r.zeroEstEth;
    if (enMonnaie || !r.enWeth) {
      const corps = corpsV4(k, zeroVersUn, montant, mini);
      return { to: ROUTEUR4, data: i.encodeFunctionData('execute', [V4_SWAP, [corps], echeance]),
               value: achat && !enMonnaie ? montant : ethers.BigNumber.from(0) };
    }
    /* Par IDENTITE, pas par sens : a la vente le WETH est la sortie, et le
       prendre pour l entree reglerait la mauvaise monnaie. */
    const weth = norm(k[0]) === norm(WETH) ? k[0] : k[1];
    const jetonC = norm(k[0]) === norm(WETH) ? k[1] : k[0];
    const swap = A.encode([SWAP4_T], [[k, zeroVersUn, montant, mini, 0, '0x']]);
    if (achat) {
      /* WRAP_ETH(routeur, montant) puis le swap regle en WETH depuis le routeur. */
      const corps = A.encode(['bytes', 'bytes[]'], [ACTES4_WETH_ACHAT, [
        swap,
        A.encode(['address', 'uint256', 'bool'], [weth, 0, false]),        /* SETTLE : open delta, le routeur paie */
        A.encode(['address', 'uint256'], [jetonC, mini]),                   /* TAKE_ALL du jeton, au minimum */
      ]]);
      return { to: ROUTEUR4, value: montant,
               data: i.encodeFunctionData('execute', [WRAP_ETH + V4_SWAP.slice(2), [
                 A.encode(['address', 'uint256'], [ADRESSE_ROUTEUR, montant]), corps], echeance]) };
    }
    /* Le jeton part via Permit2, le WETH arrive chez le routeur, qui le deballe
       vers le miroir — le minimum exige aux deux etapes. */
    const corps = A.encode(['bytes', 'bytes[]'], [ACTES4_WETH_VENTE, [
      swap,
      A.encode(['address', 'uint256'], [jetonC, montant]),                  /* SETTLE_ALL du jeton */
      A.encode(['address', 'address', 'uint256'], [weth, ADRESSE_ROUTEUR, 0]), /* TAKE du WETH vers le routeur, open delta */
    ]]);
    return { to: ROUTEUR4, value: ethers.BigNumber.from(0),
             data: i.encodeFunctionData('execute', [V4_SWAP + UNWRAP_WETH.slice(2), [
               corps, A.encode(['address', 'uint256'], [vers, mini])], echeance]) };
  }
  if (r.ver === 'v2') {
    const i = new ethers.utils.Interface(R2_ABI);
    /* Les variantes « SupportingFeeOnTransfer » : un jeton qui prend une taxe
       au passage fait echouer les autres, et sur cette chaine c'est courant. */
    if (enMonnaie)
      return { to: ROUTEUR2, value: ethers.BigNumber.from(0),
               data: i.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',
                                          [montant, mini, achat ? [r.monnaie.adr, jeton] : [jeton, r.monnaie.adr], vers, echeance]) };
    return achat
      ? { to: ROUTEUR2, value: montant,
          data: i.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',
                                     [mini, [WETH, jeton], vers, echeance]) }
      : { to: ROUTEUR2, value: ethers.BigNumber.from(0),
          data: i.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',
                                     [montant, mini, [jeton, WETH], vers, echeance]) };
  }
  const i = new ethers.utils.Interface(R3_ABI);
  if (enMonnaie) {
    /* Monnaie contre jeton, dans un sens ou dans l'autre : un seul appel, le
       produit chez le miroir, rien a deballer. */
    return { to: ROUTEUR3, value: ethers.BigNumber.from(0),
             data: i.encodeFunctionData('exactInputSingle', [{
               tokenIn: achat ? r.monnaie.adr : jeton, tokenOut: achat ? jeton : r.monnaie.adr, fee: r.fee, recipient: vers,
               amountIn: montant, amountOutMinimum: mini, sqrtPriceLimitX96: 0 }]) };
  }
  if (achat) {
    /* Le routeur v3 emballe lui-meme l'ETH recu quand l'entree est le WETH. */
    return { to: ROUTEUR3, value: montant,
             data: i.encodeFunctionData('exactInputSingle', [{
               tokenIn: WETH, tokenOut: jeton, fee: r.fee, recipient: vers,
               amountIn: montant, amountOutMinimum: mini, sqrtPriceLimitX96: 0 }]) };
  }
  /* Vendre rend du WETH au routeur, qui le deballe vers le miroir : deux
     appels, une transaction, et le minimum est exige aux deux etapes. */
  return { to: ROUTEUR3, value: ethers.BigNumber.from(0),
           data: i.encodeFunctionData('multicall', [echeance, [
             i.encodeFunctionData('exactInputSingle', [{
               tokenIn: jeton, tokenOut: WETH, fee: r.fee, recipient: ADRESSE_ROUTEUR,
               amountIn: montant, amountOutMinimum: mini, sqrtPriceLimitX96: 0 }]),
             i.encodeFunctionData('unwrapWETH9', [mini, vers]),
           ]]) };
}

/** Le minimum de sortie. JAMAIS zero : zero veut dire « accepte un jeton »,
    et c'est la porte ouverte au sandwich. */
function plancher(sortie) {
  return ethers.BigNumber.from(sortie).mul(10000 - TOLERANCE_BPS).div(10000);
}

/* ==========================================================================
 * LE PRIX DU GAZ EST LE NOTRE
 *
 * « Comment c'est possible de payer le gaz aussi cher que le trade ? »
 *
 * SHARE, 4 septembre : achat 0,00217 ETH, gaz 0,00006 — 3 %, normal. Vente :
 * devis 0,0004 ETH, net de gaz -0,0020. La vente et ses deux autorisations
 * ont coute 0,0024 ETH de gaz, dix fois l'achat. Sans reglage, ethers signe
 * des transactions EIP-1559 avec un pourboire de 1,5 gwei par defaut, sur
 * une chaine dont le prix de base est 0,13 a 0,7 gwei : trois a douze fois
 * le prix reel, a chaque transaction. On signe donc au prix du gaz lu sur
 * la chaine, plus vingt pour cent de marge, en transaction classique : ce
 * qu'on paie est ce qu'on a lu. */
async function fraisGaz() {
  const prix = await provider().getGasPrice();
  return { gasPrice: prix.mul(12).div(10) };
}
/* ---- ET UNE VENTE QUI COUTE PLUS QU'ELLE NE RAPPORTE NE PART PAS ----
 * « Ca ne sert a rien de vendre, on perd plus qu'on n'y gagne. » Une position
 * tombee a 0,0004 ETH ne merite pas 0,0004 ETH de gaz. Sous deux fois le gaz
 * estime de la vente (l'echange et ses autorisations), les jetons restent
 * dans le portefeuille — ils sont au joueur — et la position est comptee
 * comme une perte entiere : c'est ce qu'elle est. */
const POUSSIERE_MULT = Math.max(1, nEnv('MIROIR_POUSSIERE_MULT', 2));
async function gazDeVente(route) {
  const prix = await provider().getGasPrice();
  const unites = GAZ_ORDRE_UNITES + (route.ver === 'v4' ? 2 : 1) * 60000;   /* l'echange, plus les autorisations au pire */
  /* Avec un pont : une seconde transaction et son autorisation. */
  const pont = route.pont ? GAZ_ORDRE_UNITES + (route.pont.ver === 'v4' ? 2 : 1) * 60000 : 0;
  return prix.mul(unites + pont);
}

/* ==========================================================================
 * LA MEILLEURE PLACE, MESUREE
 *
 * « C'est vraiment sur le WETH que tu dois te concentrer, les frais sont
 *   moins chers. »
 *
 * Mesure le 5 septembre, 0,001 ETH aller-retour : une paire v2 rend 99,3 %,
 * un pool v3 a 1 % rend 97,9 %, un pool v4 a hook rend 98,0 %. Et le gaz
 * n'est pas le meme : v4 passe par Permit2 (deux autorisations) et un
 * echange plus lourd ; v2 et v3, une autorisation et un echange leger. Ce
 * qui est moins cher n'est donc pas « le WETH », c'est une place precise,
 * pour ce jeton, pour cette mise — et ca se mesure. Avant chaque achat, le
 * miroir demande a DexScreener toutes les paires du jeton contre l'ETH ou le
 * WETH, chiffre l'aller-retour de chacune au quoteur de sa place, retire le
 * gaz estime, et prend la meilleure. La colonie a donne une piscine ; le
 * miroir la garde si rien ne fait mieux. */
const LIQ_PLACE_MIN = 2000;
const GAZ_PLACE = { v4: 2 * 60000 + 2 * 300000, v3: 60000 + 2 * 200000, v2: 60000 + 2 * 150000 };   /* autorisations + aller + retour */
let sourcePaires = async function (jeton) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + jeton, { signal: ac.signal });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.pairs || []).filter((p) => String(p.chainId || '').toLowerCase() === 'robinhood')
      .map((p) => ({ pool: p.pairAddress, liq: Number(p.liquidity && p.liquidity.usd) || 0,
                     quote: String((p.quoteToken || {}).address || '').toLowerCase(),
                     quoteSym: String((p.quoteToken || {}).symbol || ''),
                     base: String((p.baseToken || {}).address || '').toLowerCase(), labels: p.labels || [] }));
  } catch (e) { return []; }
  finally { clearTimeout(t); }
};
function poseSourcePaires(f) { sourcePaires = f; }
const ADRESSES_ETH_PLACE = [norm(ETH4), norm(WETH), '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];

/** Toutes les places d'un jeton, chiffrees pour cette mise. Rend la meilleure
 *  nette de gaz, et la liste comparee pour le journal. Celle de la colonie
 *  est toujours dans la liste ; sans rien de mieux, c'est elle. */
async function meilleurePlace(jeton, poolColonie, mise) {
  const vues = new Set();
  const cand = [];
  if (poolColonie) { cand.push(String(poolColonie)); vues.add(norm(poolColonie)); }
  let autres = [];
  try { autres = await sourcePaires(jeton); } catch (e) { autres = []; }
  for (const p of autres) {
    if (!p.pool || vues.has(norm(p.pool))) continue;
    if (!(p.liq >= LIQ_PLACE_MIN)) continue;
    /* Contre l'ETH, ou contre une monnaie de la liste des ponts : la route
       dira si le pont est assez profond. */
    if (p.quote && ADRESSES_ETH_PLACE.indexOf(norm(p.quote)) < 0
        && !(p.quoteSym && PONTS.indexOf(String(p.quoteSym).toUpperCase()) >= 0)) continue;
    vues.add(norm(p.pool)); cand.push(String(p.pool));
  }
  const prixGaz = await provider().getGasPrice();
  const essais = [];
  let derniere = null;
  for (const pool of cand) {
    try {
      const route = await routeDe(jeton, pool);
      const sortie = await devisRoute(route, 'achat', jeton, mise);
      if (sortie.lte(0)) continue;
      const retour = await devisRoute(route, 'vente', jeton, sortie);
      /* Le gaz d'une place pontee compte ses deux jambes, a l'aller et au retour. */
      const gaz = prixGaz.mul((GAZ_PLACE[route.ver] || GAZ_PLACE.v4) + (route.pont ? (GAZ_PLACE[route.pont.ver] || GAZ_PLACE.v4) : 0));
      essais.push({ route, pool, sortie, retour, gaz, net: retour.sub(gaz), colonie: norm(pool) === norm(poolColonie) });
    } catch (e) { derniere = resume(e); /* une place qui ne repond pas n'est pas candidate */ }
  }
  /* Aucune place : la derniere raison est dite — « quoted in NVDA, and no ETH
     bridge deep enough » vaut mieux que « no venue answers ». */
  if (!essais.length) throw new Error((poolColonie ? 'no venue answers for this token' : 'no pool against ETH found for this token')
                                      + (derniere ? ' (' + derniere + ')' : ''));
  essais.sort((a, b) => (b.net.gt(a.net) ? 1 : b.net.lt(a.net) ? -1 : (a.colonie ? -1 : b.colonie ? 1 : 0)));
  const pct = (e) => mise.isZero() ? 0 : Math.round(Number(e.retour.mul(10000).div(mise)) / 100 * 10) / 10;
  return { choix: essais[0], compare: essais.map((e) => ({ ver: e.route.ver, pool: e.pool, retourPct: pct(e), colonie: e.colonie,
                                                            via: e.route.pont ? e.route.monnaie.sym : null })) };
}

/* ---- L'ALLER-RETOUR, POUR LE PAPIER AUSSI ----
 * « Comment ca se fait qu'il achete, meme le miroir, si c'est un pot de miel ? »
 * DFC, 8 septembre : le miroir a refuse — « the pool lets you in, not out »,
 * 0 % de retour — mais le papier avait ouvert, parce que son Cobaye simule le
 * TRANSFERT vers la piscine, pas l'echange entier. Le papier demande donc ici
 * le meme devis que le miroir, sur une sonde de la taille d'un ordre
 * ordinaire : ce que le miroir n'acheterait pas, le papier ne l'ouvre plus.
 * Rien n'est signe : ce sont les quoteurs qui repondent, comme pour le
 * miroir. */
const SONDE_ETH = String(process.env.MIROIR_SONDE_ETH || '0.01');
async function allerRetour(jeton, pool) {
  const mise = ethers.utils.parseUnits(SONDE_ETH, 18);
  const { choix, compare } = await meilleurePlace(jeton, pool, mise);
  const pct = Math.round(Number(choix.retour.mul(10000).div(mise)) / 100 * 10) / 10;
  return { pct, min: Math.round(RETOUR_MIN * 100), ver: choix.route.ver, pool: choix.pool, sonde: SONDE_ETH, compare };
}

/** Le portefeuille d'un miroir, dechiffre le temps d'une signature. */
function signataire(c) {
  return new ethers.Wallet(dechiffre(c.cle), provider());
}

/* ==================== LES ORDRES ====================
 *
 * Un achat : de l'ETH natif vers le jeton, en une transaction.
 *
 * Une vente demande une autorisation avant. En v4, le routeur ne prend pas
 * les jetons lui-meme, c'est Permit2 qui les deplace pour lui : le jeton
 * autorise Permit2, puis Permit2 autorise le routeur. En v2 et v3, le routeur
 * est autorise directement. On ne les redemande pas a chaque vente : on lit
 * l'existant d'abord. */
/** Reel, ou en essai : en essai pour tout sans MIROIR_EXECUTE, et pour une
 *  route pontee sans MIROIR_PONTS_EXECUTE. */
function enReel(r) { return EXECUTE && (!r.pont || PONTS_EXECUTE); }
async function acheteRoute(c, r, jeton, entreeWei) {
  const sortie = await devisRoute(r, 'achat', jeton, entreeWei);
  const mini = plancher(sortie);
  if (!enReel(r)) return { simule: true, sortie, mini, tx: null };
  const w = signataire(c);
  const avant = await provider().getBalance(w.address);
  let tx, txs = null;
  if (!r.pont) {
    const o = ordre(r, 'achat', jeton, entreeWei, mini, w.address, Math.floor(Date.now() / 1000) + ECHEANCE_S);
    const t = await w.sendTransaction(Object.assign(o, await fraisGaz()));
    tx = (await t.wait()).transactionHash;
  } else {
    const j = await deuxJambes(c, r, 'achat', jeton, entreeWei, (rr, sens, jj, m, sc) => jambe(w, rr, sens, jj, m, sc));
    tx = j.tx; txs = j.txs;
  }
  const apres = await provider().getBalance(w.address);
  /* Un depot arrive pendant la transaction rendrait le cout negatif : on
     retombe alors sur la mise, jamais sur un chiffre absurde. */
  const coutReel = avant.gt(apres) ? avant.sub(apres) : entreeWei;
  return { simule: false, sortie, mini, tx, txs, coutReel };
}

/* ==================== UNE JAMBE, ET DEUX ====================
 * Une jambe est un echange, une transaction : autorisation de l'entree quand
 * elle n'est pas l'ETH, ordre, et ce qui est RECU lu sur le solde du jeton
 * de sortie — c'est ce montant-la, pas le devis, qui entre dans la jambe
 * suivante. */
async function soldeJeton(adr, qui) {
  return new ethers.Contract(adr, ERC20_ABI, provider()).balanceOf(qui);
}
async function autorisePour(w, r, jetonEntree, montant) {
  if (r.ver === 'v4') return autorise(w, jetonEntree, montant);
  return autoriseSimple(w, jetonEntree, r.ver === 'v2' ? ROUTEUR2 : ROUTEUR3, montant);
}
async function jambe(w, r, sens, jeton, montant, sortieConnue) {
  const achat = sens === 'achat';
  const enMonnaie = !!(r.monnaie && !r.monnaie.eth);
  const sortie = sortieConnue || await devisJambe(r, sens, jeton, montant);
  const mini = plancher(sortie);
  const entreeErc20 = achat ? (enMonnaie ? r.monnaie.adr : null) : jeton;
  if (entreeErc20) await autorisePour(w, r, entreeErc20, montant);
  const sortieAdr = achat ? jeton : (enMonnaie ? r.monnaie.adr : null);    /* null : l'ETH */
  const avant = sortieAdr ? await soldeJeton(sortieAdr, w.address) : null;
  const o = ordre(r, sens, jeton, montant, mini, w.address, Math.floor(Date.now() / 1000) + ECHEANCE_S);
  const tx = await w.sendTransaction(Object.assign(o, await fraisGaz()));
  const rc = await tx.wait();
  let recu = sortie;
  if (sortieAdr) {
    try { const d = (await soldeJeton(sortieAdr, w.address)).sub(avant); if (d.gt(0)) recu = d; } catch (e) { /* le devis fera foi */ }
  }
  return { sortie, mini, tx: rc.transactionHash, recu };
}
/* ---- DEUX JAMBES, ET CE QUI ARRIVE ENTRE LES DEUX ----
 * A l'achat : ETH -> monnaie sur le pont, puis monnaie -> jeton. Si la seconde
 * echoue, le miroir tient de la monnaie et pas de jeton : on la ramene en ETH
 * tout de suite ; si ca echoue aussi, elle est notee EN TRANSIT — elle est au
 * joueur, dans son portefeuille — et retentee a chaque tour. A la vente :
 * jeton -> monnaie, puis monnaie -> ETH ; si le pont echoue, meme transit, et
 * la position est comptee sur ce que le solde ETH a vu, c'est-a-dire rien
 * encore : ce que le transit rendra sera compte a part, quand il rendra.
 * `execute` est injecte : c'est ce qui permet au banc de jouer une jambe qui
 * casse sans chaine. */
async function deuxJambes(c, r, sens, jeton, montant, execute) {
  const m = r.monnaie;
  const fmt = (x) => ethers.utils.formatUnits(x, m.dec === undefined ? 18 : m.dec);
  if (sens === 'achat') {
    const a = await execute(r.pont, 'achat', m.adr, montant);
    let b;
    try { b = await execute(r, 'achat', jeton, a.recu); }
    catch (e) {
      try {
        const ret = await execute(r.pont, 'vente', m.adr, a.recu);
        note(c, 'The bridge leg passed but the token leg failed (' + resume(e) + '): ' + fmt(a.recu) + ' ' + m.sym
              + ' sold straight back to ETH. Nothing is held', { tx: ret.tx || null });
      } catch (e2) { metsEnTransit(c, m, a.recu, e2); }
      throw e;
    }
    return { sortie: b.sortie, tx: b.tx, txs: [a.tx, b.tx], viaMonnaie: a.recu };
  }
  const b = await execute(r, 'vente', jeton, montant);
  let a;
  try { a = await execute(r.pont, 'vente', m.adr, b.recu); }
  catch (e) {
    metsEnTransit(c, m, b.recu, e);
    return { sortie: ethers.BigNumber.from(0), tx: b.tx, txs: [b.tx], enTransit: b.recu };
  }
  return { sortie: a.sortie, tx: a.tx, txs: [b.tx, a.tx], viaMonnaie: b.recu };
}
function metsEnTransit(c, m, montant, e) {
  if (!Array.isArray(c.transit)) c.transit = [];
  const dec = m.dec === undefined ? 18 : m.dec;
  c.transit.push({ adr: m.adr, sym: m.sym, dec, montant: montant.toString(), t: Date.now(), erreur: resume(e) });
  note(c, 'Stranded: ' + ethers.utils.formatUnits(montant, dec) + ' ' + m.sym + ' sit in the wallet — the bridge to ETH failed ('
        + resume(e) + '). They are yours; the mirror will try to bring them back to ETH every turn', { adr: m.adr });
}
/** A chaque tour : ce qui est en transit est ramene en ETH, et compte a part
 *  quand ca rend. Rien n'est tente sans chaine. */
async function rattrapeTransit(c) {
  if (!Array.isArray(c.transit) || !c.transit.length) return 0;
  if (!EXECUTE) return 0;
  let n = 0;
  const w = signataire(c);
  for (const t of c.transit.slice()) {
    try {
      const pont = await pontPour(t.adr, t.sym);
      const montant = await soldeJeton(t.adr, w.address);
      if (montant.lte(0)) { c.transit.splice(c.transit.indexOf(t), 1); note(c, 'Nothing left of the stranded ' + t.sym + ': cleared', { adr: t.adr }); continue; }
      const avant = await provider().getBalance(w.address);
      const j = await jambe(w, pont.route, 'vente', t.adr, montant);
      const recu = (await provider().getBalance(w.address)).sub(avant);
      c.transit.splice(c.transit.indexOf(t), 1);
      if (!Array.isArray(c.fermees)) c.fermees = [];
      c.fermees.push({ adr: t.adr, sym: t.sym + ' (recovered)', entree: '0', mise: '0', sortie: ethers.utils.formatUnits(recu, 18),
                       transit: true, reel: true, simule: false, t0: t.t, t: Date.now(), tx: j.tx });
      note(c, 'Recovered: the stranded ' + ethers.utils.formatUnits(montant, t.dec || 18) + ' ' + t.sym + ' came back as '
            + ethers.utils.formatUnits(recu, 18) + ' ETH (RH), net of gas', { adr: t.adr, tx: j.tx });
      n++;
    } catch (e) { note(c, 'Still stranded: ' + t.sym + ' — ' + resume(e), { adr: t.adr }); }
    await dors(PAUSE_MS);
  }
  return n;
}

async function autorise(w, jeton, montant) {
  const t = new ethers.Contract(jeton, ERC20_ABI, w);
  const a1 = await t.allowance(w.address, PERMIT2);
  if (a1.lt(montant)) {
    const tx = await t.approve(PERMIT2, ethers.constants.MaxUint256, await fraisGaz());
    await tx.wait();
  }
  const p2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, w);
  const a2 = await p2.allowance(w.address, jeton, ROUTEUR4);
  const reste = ethers.BigNumber.from(a2.amount !== undefined ? a2.amount : a2[0]);
  const fin = Number(a2.expiration !== undefined ? a2.expiration : a2[1]);
  if (reste.lt(montant) || fin <= Math.floor(Date.now() / 1000) + ECHEANCE_S) {
    /* Le maximum d'un uint160, et une echeance courte : une autorisation
       illimitee ET eternelle est ce qu'on retrouve dans tous les post-mortem. */
    const tx = await p2.approve(jeton, ROUTEUR4,
      ethers.BigNumber.from(2).pow(160).sub(1), Math.floor(Date.now() / 1000) + 86400, await fraisGaz());
    await tx.wait();
  }
}

/** L'autorisation simple d'un ERC-20 vers un routeur v2 ou v3. */
async function autoriseSimple(w, jeton, routeur, montant) {
  const t = new ethers.Contract(jeton, ERC20_ABI, w);
  const a = await t.allowance(w.address, routeur);
  if (a.lt(montant)) {
    const tx = await t.approve(routeur, ethers.constants.MaxUint256, await fraisGaz());
    await tx.wait();
  }
}

async function vendRoute(c, r, jeton, montantWei, sortieConnue) {
  const sortie = sortieConnue || await devisRoute(r, 'vente', jeton, montantWei);
  const mini = plancher(sortie);
  if (!enReel(r)) return { simule: true, sortie, mini, tx: null };
  const w = signataire(c);
  /* Avant les autorisations : leur gaz fait partie du prix de cette vente. */
  const avant = await provider().getBalance(w.address);
  let tx, txs = null;
  if (!r.pont) {
    if (r.ver === 'v4') await autorise(w, jeton, montantWei);
    else await autoriseSimple(w, jeton, r.ver === 'v2' ? ROUTEUR2 : ROUTEUR3, montantWei);
    const o = ordre(r, 'vente', jeton, montantWei, mini, w.address, Math.floor(Date.now() / 1000) + ECHEANCE_S);
    const t = await w.sendTransaction(Object.assign(o, await fraisGaz()));
    tx = (await t.wait()).transactionHash;
  } else {
    const j = await deuxJambes(c, r, 'vente', jeton, montantWei, (rr, sens, jj, m, sc) => jambe(w, rr, sens, jj, m, sc));
    tx = j.tx; txs = j.txs;
  }
  const apres = await provider().getBalance(w.address);
  /* Ce qui est revenu, gaz deduit. Une vente qui rend moins que son gaz
     donne un chiffre negatif : c'est la verite, on la garde. */
  const recuReel = apres.sub(avant);
  return { simule: false, sortie, mini, tx, txs, recuReel };
}

/** La route d'une position deja ouverte, telle qu'elle a ete notee a l'achat.
 *  Une position d'avant les routes n'a qu'une clef : c'est du v4. */
async function routeDePosition(adr, o) {
  /* La monnaie et le pont tels qu'ils ont ete notes a l'achat : une position
     d'avant les ponts est en ETH. Le pont est relu s'il a vieilli. */
  const m = o.monnaie && !o.monnaie.eth ? o.monnaie : MONNAIE_ETH;
  let pont = null;
  if (!m.eth) {
    try { pont = (await pontPour(m.adr, m.sym)).route; }
    catch (e) { if (!o.pont) throw e; pont = o.pont; }
  }
  const fini = (r) => { r.monnaie = m; r.pont = pont; return r; };
  if (o.ver === 'v2') return fini({ ver: 'v2', paire: o.pool });
  if (o.ver === 'v3') return fini({ ver: 'v3', paire: o.pool, fee: o.fee });
  const cle = o.cle || (await clePiscine(adr, o.pool) || {}).cle;
  if (!cle) throw new Error('pool key lost for this token');
  return fini({ ver: 'v4', cle, zeroEstEth: !!o.zeroVersUn, enWeth: !!o.enWeth });
}

/* ==================== CE QUE LE MIROIR PEUT ENGAGER ====================
 *
 * ---- C'EST LE BANQUIER QUI DECIDE, PAS CE FICHIER ----
 *
 * La premiere version prenait une part fixe du solde. C'etait une SECONDE
 * facon de dimensionner, a cote de celle que la colonie a apprise et mesuree —
 * exactement le genre de doublon qu'on paie plus tard. La colonie passe donc
 * la FRACTION que son Banquier vient d'engager de sa propre caisse, et le
 * miroir l'applique a la sienne. Elle porte deja la methode apprise, l'echelle
 * par note, le plafond par position, le plafond d'exposition totale et le
 * regime : suivre la colonie, c'est engager la meme part qu'elle, pas un
 * dixieme decide ici.
 *
 * `PART_ORDRE` reste le repli, pour le seul cas ou la fraction n'arrive pas —
 * une caisse a zero, un signal d'une version anterieure.
 *
 * ---- ET DEUX BORNES QUI NE VIENNENT PAS DE LUI ----
 *
 * Le plafond par ordre, parce que le Banquier raisonne sur une caisse papier
 * qu'aucune piscine ne doit absorber, alors qu'ici l'ordre part vraiment dans
 * une piscine de mille dollars et paie son propre impact. Et la reserve de
 * gaz, jamais entamee : un miroir sans gaz est un miroir qui regarde son jeton
 * tomber sans pouvoir en sortir.
 *
 * La part s'applique au DISPONIBLE du moment, pas a un capital de depart : a
 * mesure que des positions s'ouvrent, il reste moins, donc les ordres suivants
 * sont plus petits. C'est plus prudent que la colonie, et dans ce sens-la. */
function miseDe(soldeWei, part) {
  const dispo = ethers.BigNumber.from(soldeWei).sub(WEI(GAZ_RESERVE));
  if (dispo.lte(0)) return ethers.BigNumber.from(0);
  let p = Number(part);
  if (!isFinite(p) || p <= 0) p = PART_ORDRE;
  p = Math.min(0.5, p);
  let mise = dispo.mul(Math.round(p * 10000)).div(10000);
  const plaf = WEI(ORDRE_MAX_ETH), mini = plancherOrdre();
  /* Sous le plancher, on prend le plancher si le disponible le permet : un
     petit portefeuille tient moins de positions, mais des positions qui
     valent leur gaz. Sinon, rien — et `pourquoiPasDeMise` le dit. */
  if (mise.lt(mini)) mise = dispo.gte(mini) ? mini : ethers.BigNumber.from(0);
  return mise.gt(plaf) ? plaf : mise;
}
/** La part du Banquier seule, sans le plancher : c'est la comparaison des deux
 *  qui dit au joueur que sa mise a ete RELEVEE, et de combien. */
function partSeule(soldeWei, part) {
  const dispo = ethers.BigNumber.from(soldeWei).sub(WEI(GAZ_RESERVE));
  if (dispo.lte(0)) return ethers.BigNumber.from(0);
  let p = Number(part);
  if (!isFinite(p) || p <= 0) p = PART_ORDRE;
  return dispo.mul(Math.round(Math.min(0.5, p) * 10000)).div(10000);
}
/** Un montant en ETH, dit en dollars quand on connait le cours. */
function enDollars(wei) {
  const c = coursEth();
  if (!(c > 0)) return '';
  const v = Number(ethers.utils.formatUnits(wei, 18)) * c;
  return '$' + (v >= 100 ? Math.round(v) : v.toFixed(2));
}

/** La phrase qui va avec une mise nulle : les chiffres, et quoi faire. */
function pourquoiPasDeMise(soldeWei) {
  const solde = ethers.utils.formatUnits(soldeWei, 18);
  const dispo = ethers.BigNumber.from(soldeWei).sub(WEI(GAZ_RESERVE));
  if (dispo.lte(0))
    return solde + ' ETH (RH) is under the ' + GAZ_RESERVE + ' ETH gas reserve, which is never spent on a buy';
  const mini = plancherOrdre();
  return ethers.utils.formatUnits(dispo, 18) + ' ETH (RH) free after the ' + GAZ_RESERVE
    + ' ETH gas reserve, and an order needs at least ' + ethers.utils.formatUnits(mini, 18) + ' ETH'
    + (coursEth() > 0 ? ' (' + enDollars(mini) + ', the floor under which gas eats the trade)' : ' to be worth its gas')
    + ' — fund the mirror with ' + minPourJouer() + ' ETH or more';
}

/* ==================== L'INTERFACE ====================
 * C'est ce que `server.js` appelle, et rien d'autre. */

/** Le module est-il utilisable, et sinon pourquoi — en clair, pour l'ecran. */
function pret() {
  if (!cleMaitresse()) return { ok: false, pourquoi: 'MIROIR_CLE is not set on the server' };
  return { ok: true, pourquoi: null };
}

/** Creer le portefeuille d'un joueur. La cle n'est rendue QU'ICI et par
 *  `revele` : elle n'entre dans aucun etat public, aucun journal, aucune
 *  annonce. */
async function cree(joueur) {
  const p = pret();
  if (!p.ok) throw new Error(p.pourquoi);
  const j = norm(joueur);
  if (!/^0x[0-9a-f]{40}$/.test(j)) throw new Error('not a player address');
  if (R.comptes[j]) throw new Error('this account already has a mirror wallet');
  const w = ethers.Wallet.createRandom();
  R.comptes[j] = {
    adr: w.address, cle: chiffre(w.privateKey), cree: Date.now(),
    actif: false, joue: 0, ouvertes: {}, journal: [],
  };
  note(R.comptes[j], 'Mirror wallet created');
  sauve();
  return { adresse: w.address, cle: w.privateKey };
}

/** Rendre la cle au joueur qui la demande. C'est SA cle : la lui refuser ne le
 *  protegerait de rien et le laisserait dependre de nous pour sortir. */
/** Effacer le journal — et rien d'autre : les positions, les ventes et le
 *  bilan ne bougent pas. « Ca prend beaucoup de place a l'ecran. » Une ligne
 *  reste, qui dit que ca a ete fait, et combien. */
function effaceJournal(joueur) {
  const c = fiche(joueur);
  if (!c) throw new Error('no mirror wallet on this account');
  const n = (c.journal || []).length;
  c.journal = [];
  note(c, 'Log cleared (' + n + ' line' + (n === 1 ? '' : 's') + '). Positions, trades and the balance are untouched.');
  sauve();
  return { efface: n };
}

/* ---- REMETTRE LA BARRE A ZERO ----
 * « Il faudrait un bouton pour remettre les stats du miroir a zero, si des
 *   personnes veulent. »
 * La barre se calcule sur les fermees : on les efface, et elles seules. Les
 * positions ouvertes, le journal et le solde ne bougent pas — une remise a
 * zero qui toucherait a une position en cours ne serait plus une remise a
 * zero, ce serait une vente. Le journal garde une ligne qui le dit, avec ce
 * qui a ete efface : le chiffre disparait de la barre, pas de l'histoire. */
function remetLesStats(joueur) {
  const c = fiche(joueur);
  if (!c) throw new Error('no mirror wallet on this account');
  const b = bilan(c);
  c.fermees = [];
  note(c, 'Stats reset: ' + b.trades + ' trade' + (b.trades === 1 ? '' : 's') + ' cleared (' + b.profitEth
        + ' ETH of profit, ' + b.gagnantes + ' winner' + (b.gagnantes === 1 ? '' : 's') + '). Open positions, the log and the balance are untouched.');
  sauve();
  return { effaces: b.trades, profitEth: b.profitEth };
}

function revele(joueur) {
  const c = fiche(joueur);
  if (!c) throw new Error('no mirror wallet on this account');
  return { adresse: c.adr, cle: dechiffre(c.cle) };
}

/** Ce que l'ecran montre. Jamais la cle. */
const FERMEES_MAX = 300;
/** Le bilan d'un miroir, calcule sur ses ventes. Les chiffres sont en ETH :
 *  l'ecran les convertit s'il connait le cours, et le dit sinon. */
function bilan(c) {
  const toutes = c.fermees || [];
  const f = toutes.filter((x) => x.sortie !== null && x.sortie !== undefined);
  const horsMiroir = toutes.filter((x) => x.horsMiroir && !x.simule).length;
  let profit = 0, gagnantes = 0, meilleur = 0;
  let transit = 0;
  for (const x of f) {
    const e = Number(x.entree) || 0, s = Number(x.sortie) || 0;
    profit += s - e;
    /* Une recuperation de transit rend de l'ETH sans avoir ete un trade :
       elle entre dans le profit, pas dans les trades ni les gagnantes. */
    if (x.transit) { transit++; continue; }
    if (s > e) gagnantes++;
    if (e > 0 && s / e > meilleur) meilleur = s / e;
  }
  return { trades: f.length - transit, gagnantes, profitEth: profit.toFixed(6),
           meilleur: Math.round(meilleur * 100) / 100,
           ouvertes: Object.keys(c.ouvertes || {}).length,
           simule: f.length > 0 && f.every((x) => x.simule),
           /* Reel : entree et sortie lues sur le solde, gaz compris. */
           reel: f.length > 0 && f.every((x) => x.reel),
           /* Fermees hors du miroir : tenues puis parties sans qu'il vende. Leur
              resultat est inconnu, donc hors du profit — et c'est dit. */
           horsMiroir };
}

/* ==================== CE QUE LE PORTEFEUILLE TIENT VRAIMENT ====================
 *
 * « J'ai fermé la position manuellement et il dit encore mirror open 1. »
 *
 * Le registre disait « ouverte » tant que le miroir n'avait pas vendu lui-meme.
 * Une position vendue avec la cle depuis un autre portefeuille, une vente du
 * stop qui a echoue, un reste du mode d'essai : autant de lignes que le
 * portefeuille ne tient plus et que l'ecran comptait quand meme. En reel, la
 * chaine sait : on lit le solde du jeton, et zero veut dire ferme. On ne
 * connait pas ce que la vente a rendu — on le dit, et on ne l'invente pas. */
 const RECONCILIE_MS = 30000;
const derniereReconciliation = new Map();
async function reconcilie(c) {
  if (!EXECUTE || !c || !c.ouvertes) return 0;
  const now = Date.now();
  if (now - (derniereReconciliation.get(c.adr) || 0) < RECONCILIE_MS) return 0;
  derniereReconciliation.set(c.adr, now);
  let n = 0;
  for (const [adr, o] of Object.entries(c.ouvertes)) {
    let tenu = null;
    if (o.simule) tenu = ethers.BigNumber.from(0);          /* un essai n'a jamais rien achete */
    else {
      try { tenu = await new ethers.Contract(adr, ERC20_ABI, provider()).balanceOf(c.adr); }
      catch (e) { continue; }                                /* illisible : on ne conclut rien */
    }
    if (tenu.gt(0)) continue;
    delete c.ouvertes[adr];
    if (!Array.isArray(c.fermees)) c.fermees = [];
    c.fermees.push({ adr, sym: o.sym || null, entree: o.cout || o.entree, mise: o.entree,
                     sortie: null, devis: null, reel: true, horsMiroir: true,
                     t0: o.t, t: now, simule: !!o.simule, tx: null });
    note(c, o.simule
      ? 'Position ' + (o.sym || adr) + ' dropped: it was opened in dry run, nothing was ever bought'
      : 'Position ' + (o.sym || adr) + ' closed outside the mirror: the wallet no longer holds the token, '
        + 'so it is no longer counted as open. What that sale returned is unknown and left out of the profit.',
      { adr });
    n++;
  }
  if (n) sauve();
  return n;
}

async function etat(joueur, lireChaine) {
  const c = fiche(joueur);
  const base = {
    pret: pret().ok, pourquoi: pret().pourquoi, execute: EXECUTE,
    min: minPourJouer(), max: MAX_ETH, part: PART_ORDRE, ordreMax: ORDRE_MAX_ETH,
    ordreMin: ethers.utils.formatUnits(plancherOrdre(), 18),
    /* Le plancher tel qu'il est REGLE, et le cours qui le convertit : sans le
       cours, l'ecran doit pouvoir dire que la conversion n'a pas eu lieu. */
    ordreMinUsd: ORDRE_MIN_USD, coursEth: coursEth() || null,
    gaz: GAZ_RESERVE, places: Math.max(0, MIROIRS_MAX - actifs().length),
  };
  if (!c) return Object.assign(base, { existe: false });
  let solde = null;
  if (lireChaine !== false) {
    try { await reconcilie(c); } catch (e) { /* l'ecran ne tombe pas pour ca */ }
    try { solde = ethers.utils.formatUnits(await provider().getBalance(c.adr), 18); }
    catch (e) { solde = null; }
  }
  return Object.assign(base, {
    existe: true, adresse: c.adr, actif: !!c.actif, cree: c.cree, joue: c.joue || 0,
    solde,
    ouvertes: Object.entries(c.ouvertes || {}).map(([adr, o]) => ({
      adr, sym: o.sym, pool: o.pool, ver: o.ver || 'v4', entree: o.entree, jetons: o.jetons,
      t: o.t, simule: !!o.simule,
      /* Ce qu'il reste en course, et ce que les tranches ont deja rendu. */
      reste: o.reste === undefined ? 1 : o.reste, banked: o.sortiesPartielles || null,
      /* La monnaie du pont, quand la position en a un. */
      via: o.monnaie && !o.monnaie.eth ? o.monnaie.sym : null,
      /* ---- CE QU'ELLE VAUT, ET DEPUIS QUAND ----
       * `valeur` est ce que le quoteur DONNERAIT pour tout ce qu'on tient, sur
       * la route ou le miroir vendra — pas le prix affiche multiplie par la
       * quantite. `gain` compte les tranches deja encaissees et ce que la
       * position a coute, gaz compris. Sans lecture reussie, tout est nul :
       * l'ecran ecrira « pas encore lu » plutot qu'un zero. */
      cout: o.cout || o.entree, valeur: o.valeur || null, valeurT: o.valeurT || 0,
      gain: o.gain === undefined ? null : o.gain,
      gainPct: o.gainPct === undefined ? null : o.gainPct,
      valeurErreur: o.valeurErreur || null,
    })),
    /* Ce qui est reste entre deux jambes, et que le miroir ramene chaque tour. */
    transit: (c.transit || []).map((t) => ({ sym: t.sym, adr: t.adr, montant: ethers.utils.formatUnits(t.montant, t.dec || 18), t: t.t })),
    journal: (c.journal || []).slice(0, 20),
    bilan: bilan(c),
  });
}

/** Play. On verifie le solde ICI et pas seulement a l'ecran : l'ecran peut
 *  mentir, la chaine non. */
async function demarre(joueur) {
  const c = fiche(joueur);
  if (!c) throw new Error('no mirror wallet on this account');
  if (c.actif) return { actif: true, deja: true };
  if (actifs().length >= MIROIRS_MAX)
    throw new Error('the mirror is full (' + MIROIRS_MAX + ' active): too many wallets on the same pools would bid against each other');
  const solde = await provider().getBalance(c.adr);
  await litEthUsd();
  const min = minPourJouer();
  if (solde.lt(WEI(min)))
    throw new Error('fund the mirror wallet first — at least ' + min + ' ETH (RH)'
                    + (coursEth() > 0 ? ' (' + enDollars(WEI(min)) + ')' : ''));
  if (solde.gt(WEI(MAX_ETH)))
    throw new Error('over the ceiling of ' + MAX_ETH + ' ETH (RH). This is a stake, not a vault: take some out first');
  c.actif = true; c.joue = Date.now();
  note(c, EXECUTE ? 'Play — following the colony with real orders'
                  : 'Play — following the colony in dry run: orders are priced and logged, nothing is sent on-chain');
  sauve();
  return { actif: true, deja: false, solde: ethers.utils.formatUnits(solde, 18) };
}

/** Stop : on vend TOUT, puis on balaie vers le portefeuille du compte.
 *
 *  L'ordre compte, et il n'est pas negociable : balayer d'abord laisserait des
 *  jetons dans un portefeuille sans gaz pour les vendre. */
function arrete(joueur, versAdresse) { return enFile(() => arreteFile(joueur, versAdresse)); }

async function arreteFile(joueur, versAdresse) {
  const c = fiche(joueur);
  if (!c) throw new Error('no mirror wallet on this account');
  const vers = norm(versAdresse);
  if (!/^0x[0-9a-f]{40}$/.test(vers)) throw new Error('no destination address');
  c.actif = false;
  sauve();

  const vendus = [], rates = [];
  for (const [adr, o] of Object.entries(c.ouvertes || {})) {
    try {
      const r = await vendPosition(c, adr, o);
      vendus.push({ sym: o.sym, sortie: r.sortie ? ethers.utils.formatUnits(r.sortie, 18) : null, tx: r.tx });
    } catch (e) {
      rates.push({ sym: o.sym, adr, pourquoi: resume(e) });
      note(c, 'Could not sell ' + (o.sym || adr) + ' on stop: ' + resume(e), { adr });
    }
    await dors(PAUSE_MS);
  }
  /* Ce qui est reste entre deux jambes d'un pont : on le ramene en ETH avant
     de balayer, sinon il resterait dans un portefeuille qu'on vide. */
  try { await rattrapeTransit(c); } catch (e) { note(c, 'Transit on stop: ' + resume(e)); }
  if (Array.isArray(c.transit) && c.transit.length)
    note(c, 'Still in the mirror wallet after stop: ' + c.transit.map((t) => ethers.utils.formatUnits(t.montant, t.dec || 18) + ' ' + t.sym).join(', ')
          + ' — the bridge to ETH keeps failing. The key is yours; they are not lost');

  let balaye = null;
  if (EXECUTE) {
    try { balaye = await balaie(c, vers); }
    catch (e) { note(c, 'Sweep failed: ' + resume(e)); }
  } else {
    note(c, 'Stop — dry run: nothing was sold and nothing was swept');
  }
  sauve();
  return { vendus, rates, balaye, execute: EXECUTE, vers };
}

/** Renvoyer l'ETH restant au portefeuille du compte, moins ce que coute le
 *  virement lui-meme. Un balayage qui laisse un fond de gaz derriere n'est pas
 *  un balayage. */
async function balaie(c, vers) {
  const w = signataire(c);
  const solde = await w.getBalance();
  const prix = await provider().getGasPrice();
  const cout = prix.mul(21000).mul(12).div(10);   /* 20 % de marge sur le prix du gaz */
  if (solde.lte(cout)) return { envoye: '0', pourquoi: 'nothing left after gas' };
  const montant = solde.sub(cout);
  const tx = await w.sendTransaction({ to: vers, value: montant, gasPrice: prix.mul(12).div(10) });
  const r = await tx.wait();
  note(c, 'Swept ' + ethers.utils.formatUnits(montant, 18) + ' ETH (RH) back to your account wallet',
       { tx: r.transactionHash });
  return { envoye: ethers.utils.formatUnits(montant, 18), tx: r.transactionHash };
}

/* ==================== UNE SEULE CHOSE A LA FOIS ====================
 *
 * ---- LE DEFAUT QUE LE MODE D'ESSAI NE POUVAIT PAS MONTRER ----
 *
 * La colonie ouvre plusieurs positions dans le MEME tour, et chaque ouverture
 * appelle `signal()`, qui lance le miroir sans l'attendre — c'est voulu, un
 * miroir lent ne doit pas retarder un tour. Consequence : deux achats du meme
 * tour partaient en parallele pour le meme portefeuille, tous deux allaient
 * lire le meme `nonce`, et la seconde transaction remplacait la premiere ou
 * etait rejetee. En mode d'essai rien ne part, donc rien ne se voyait : c'est
 * exactement le genre de defaut qui attend l'argent reel pour apparaitre.
 *
 * Tout le travail du miroir passe donc par une file : les ordres s'enchainent,
 * jamais ne se croisent. Elle est unique pour tous les miroirs — ils sont peu
 * nombreux et les ordres rares — et elle ne casse jamais : une erreur dans un
 * maillon ne doit pas emporter la file entiere avec elle. */
let file = Promise.resolve();
function enFile(fn) {
  const suite = file.then(fn, fn);
  file = suite.then(() => {}, () => {});
  return suite;
}

/* ==================== CE QUE LA COLONIE DECLENCHE ====================
 *
 * Ces deux fonctions sont appelees depuis la boucle de la colonie. Elles ne
 * jettent JAMAIS : une erreur de miroir ne doit pas arreter la colonie, qui
 * n'a rien demande a personne. Chaque miroir est traite a son tour, avec une
 * pause — trente signatures dans le meme bloc, c'est la coupure assuree. */
function surAchat(t) { return enFile(() => achatFile(t)); }
/* ==================== LE RATTRAPAGE, A CHAQUE TOUR ====================
 *
 * « Regarde pourquoi j ai du vendre FAT a la main, ca doit etre automatique. »
 *
 * Le 8 septembre : le papier ferme FAT a 16:25 UTC (duree atteinte, -23 %),
 * le signal part — et le miroir ne vend pas, sans une ligne de journal. Une
 * heure et demie plus tard, la vente a la main. Un signal est un evenement :
 * s il se perd (un processus qui redemarre au mauvais moment, une lecture
 * qui echoue avant la note), il est perdu pour toujours, et personne ne
 * revient voir. L etat, lui, ne se perd pas : a chaque tour, la colonie dit
 * au miroir ce qu elle TIENT. Toute position du miroir que le papier ne
 * tient plus — et qui n a pas ete ouverte a la main — est une vente
 * manquee : on la rattrape, et on ecrit pourquoi. La position doit avoir
 * deux minutes : un achat que la colonie vient de signaler peut ne pas
 * etre encore dans sa liste au tour ou le miroir l a suivi. */
const RATTRAPE_MIN_MS = 2 * 60000;
/* Une vente qui echoue (route perdue, noeud muet) n est pas retentee au tour
   d apres : un tour fait deux minutes et demie, et soixante lignes de journal
   seraient pleines en une heure. On attend dix minutes, et on redit pourquoi. */
const RATTRAPE_ATTENTE_MS = 10 * 60000;
function surTour(papier) { return enFile(() => rattrapeFile(papier)); }
/* ==================== CE QUE LA POSITION VAUT MAINTENANT ====================
 *
 * « Sur les positions du miroir, il faudrait voir le market cap et le benefice
 *   en direct. »
 *
 * Le benefice d'une position ouverte se lisait jusqu'ici sur le prix : ce que
 * le jeton VAUT, multiplie par ce qu'on en tient. C'est le chiffre du papier,
 * et le 9 septembre il a valu +25,97 $ sur JACOB pendant que la piscine ne
 * rendait plus rien. On ne demande donc pas son prix au marche : on demande
 * au quoteur ce qu'il DONNERAIT pour tout ce qu'on tient, sur la route ou le
 * miroir vendra. C'est le seul chiffre qui engage quelqu'un, il porte la
 * profondeur de la piscine, et c'est exactement ce que « Sell now » ferait.
 *
 * Une evaluation coute deux lectures : le solde et le devis. Elles sont donc
 * espacees (une par minute et demie par position au plus), plafonnees par
 * tour, et l'ecran porte l'heure de la lecture — un benefice sans son heure
 * ne dit pas s'il est encore vrai.
 *
 * Et elles servent deux fois : une piscine qui ne rend plus un centieme de ce
 * qu'elle a recu est signalee ICI, au tour ou elle meurt, au lieu d'attendre
 * qu'une vente le decouvre. Sur JACOB, cela aurait ete cinq minutes apres
 * l'achat au lieu de dix-sept.
 * ==================================================================== */
const EVAL_TTL_MS = 90000;        /* une position n'est pas reevaluee plus souvent */
const EVAL_PAR_TOUR = 40;         /* et le tour ne s'y perd pas */
async function evaluePosition(c, adr, o) {
  const route = await routeDePosition(adr, o);
  const montant = await tenu(c, adr, o);
  if (montant.lte(0)) return null;
  const devis = await devisRoute(route, 'vente', adr, montant);
  o.valeur = ethers.utils.formatUnits(devis, 18);
  o.valeurT = Date.now();
  /* Le resultat de la position ENTIERE : ce qu'on en sortirait, plus ce que
     les tranches ont deja rendu, moins ce qu'elle a coute. */
  const paye = WEI(o.cout || o.entree || '0');
  const deja = WEI(o.sortiesPartielles || '0');
  o.gain = ethers.utils.formatUnits(devis.add(deja).sub(paye), 18);
  o.gainPct = paye.isZero() ? null
    : Math.round(Number(devis.add(deja).sub(paye).mul(10000).div(paye))) / 100;
  return devis;
}
async function evalueFile() {
  const now = Date.now();
  let faites = 0;
  for (const { c } of actifs()) {
    for (const [adr, o] of Object.entries(c.ouvertes || {})) {
      if (faites >= EVAL_PAR_TOUR) break;
      if (o.valeurT && now - o.valeurT < EVAL_TTL_MS) continue;
      try {
        const devis = await evaluePosition(c, adr, o);
        faites++;
        /* Morte : on le dit tout de suite, sans attendre une vente. */
        if (devis) ditPiscineMorte(c, adr, o, devis);
      } catch (e) {
        /* Une evaluation ratee laisse la precedente, avec son heure : on ne
           remplace pas un chiffre lu par un chiffre suppose. */
        o.valeurErreur = resume(e);
      }
      await dors(PAUSE_MS);
    }
  }
  if (faites) sauve();
  return faites;
}
/* ==================== QUAND LA PISCINE EST MORTE ====================
 *
 * JACOB, 9 septembre. 04:18 UTC : la colonie ouvre, le miroir achete pour
 * 0,0127 ETH sur une paire v2. 04:23 : le papier vend son palier a +27,8 %,
 * le miroir demande le devis de la meme tranche et obtient 0,000000000000000077
 * ETH. 04:35 : le papier ferme a +39,9 % et compte +25,97 $, le miroir passe
 * la position entiere par pertes et profits. Reserves de la paire, lues sur
 * la chaine apres coup : 0,000005 WETH. La liquidite avait ete retiree cinq
 * minutes apres l'achat, et DexScreener servait encore un prix.
 *
 * Le papier a donc encaisse un gain que PERSONNE ne pouvait prendre — et il
 * l'a appris comme un succes, ce qui est pire que la perte elle-meme : il
 * refera ce trade. Le miroir, lui, l'avait vu tout de suite, avec le seul
 * chiffre qui ne ment pas : ce que la piscine rend pour ce qu'on lui a
 * donne.
 *
 * Il le DIT donc a la colonie. Le seuil n'est pas le gaz — un ordre peut ne
 * pas valoir son gaz sur une piscine parfaitement vivante, et ca depend de
 * la taille du portefeuille. Ce qui est signale ici est sans rapport avec la
 * taille : la piscine ne rend pas UN CENTIEME de ce qu'elle a recu. A ce
 * niveau-la, il n'y a plus de marche, et c'est vrai pour tout le monde.
 * ==================================================================== */
const PISCINE_MORTE = 100;        /* elle rend moins d'un centieme de la mise */
let colonie = null;
function poseColonie(c) { colonie = c; }
/* ==================== CE QUE LE MIROIR A VRAIMENT TOUCHE ====================
 *
 * « Faire apprendre la colonie sur les executions reelles du miroir. C'est le
 *   dernier mensonge du circuit, et le plus cher. »
 *
 * Le papier apprend sur des prix. Le miroir, lui, connait trois chiffres que le
 * prix ignore : ce qu'un achat a coute gaz compris, ce qu'une vente a rendu net
 * de gaz, et l'ecart entre le devis et ce qui est arrive. C'est tout l'ecart
 * entre +119 % affiches depuis le 1er septembre et -45 $ dans le portefeuille.
 *
 * A chaque fermeture REELLE — un essai n'a ni gaz ni glissement, il n'apprend
 * rien — le miroir renvoie donc son rendement a la colonie, qui le range a
 * cote de celui du papier pour le meme jeton. La difference des deux, en
 * points, EST le cout reel d'un aller-retour : mesure, plus estime.
 * ==================================================================== */
function ditExecutionReelle(c, adr, o, r) {
  if (!colonie || typeof colonie.executionReelle !== 'function') return;
  if (!r || !r.recuReel) return;                 /* un essai n'a rien coute : il n'apprend rien */
  const paye = WEI(o.cout || o.entree || '0');
  if (paye.lte(0)) return;
  const deja = WEI(o.sortiesPartielles || '0');
  const rendu = r.recuReel.add(deja);
  const rReel = Number(rendu.sub(paye).mul(10000).div(paye)) / 100;
  /* Le glissement : ce que le devis promettait contre ce que le solde a vu.
     Il ne vaut que pour la derniere vente, la seule dont on ait les deux. */
  let glissement = null;
  if (r.sortie && r.sortie.gt(0))
    glissement = Number(r.recuReel.sub(r.sortie).mul(10000).div(r.sortie)) / 100;
  try {
    colonie.executionReelle({
      adr, sym: o.sym || null,
      r: Math.round(rReel * 100) / 100,
      glissement: glissement === null ? null : Math.round(glissement * 100) / 100,
      cout: ethers.utils.formatUnits(paye, 18),
      rendu: ethers.utils.formatUnits(rendu, 18),
      tenue: Date.now() - (o.t || Date.now()),
      pont: !!(o.monnaie && !o.monnaie.eth),
    });
  } catch (e) { console.warn('[miroir] execution reelle :', e && e.message); }
}

function ditPiscineMorte(c, adr, o, devis) {
  const paye = WEI(o.cout || o.entree || '0');
  if (paye.lte(0) || devis.mul(PISCINE_MORTE).gte(paye)) return false;
  const bps = paye.isZero() ? 0 : Number(devis.mul(10000).div(paye));
  note(c, 'The pool of ' + (o.sym || adr) + ' is dead: selling back what was bought for '
        + ethers.utils.formatUnits(paye, 18) + ' ETH would return '
        + ethers.utils.formatUnits(devis, 18) + ' ETH — ' + (bps / 100) + '% of it. The liquidity is gone', { adr });
  if (colonie && typeof colonie.piscineMorte === 'function') {
    try { colonie.piscineMorte(adr, bps / 10000); }
    catch (e) { console.warn('[miroir] piscine morte :', e && e.message); }
  }
  return true;
}
async function rattrapeFile(papier) {
  const tenus = new Set(((papier && papier.ouvertes) || []).map(norm));
  const ventes = (papier && papier.ventes) || {};
  const now = Date.now();
  let n = 0;
  /* Ce que chaque position vaut vraiment, avant tout le reste : c'est ce que
     l'ecran montre, et c'est ce qui reveille une piscine morte. */
  try { await evalueFile(); } catch (e) { console.warn('[miroir] evaluation :', e && e.message); }
  for (const { c } of actifs()) {
    try { n += await rattrapeTransit(c); } catch (e) { note(c, 'Transit: ' + resume(e)); }
    for (const [adr, o] of Object.entries(c.ouvertes || {})) {
      if (o.manuel || tenus.has(adr)) continue;
      if (now - (o.t || 0) < RATTRAPE_MIN_MS) continue;
      if (o.rattrapeApres && now < o.rattrapeApres) continue;
      const quand = ventes[adr];
      const h = quand ? new Date(quand).toISOString().slice(11, 16) + ' UTC' : null;
      note(c, 'Catching up: the colony no longer holds ' + (o.sym || adr) + (h ? ' (it sold at ' + h + ')' : '')
            + ' and this mirror had missed the sale — selling now', { adr });
      try { await vendPosition(c, adr, o); n++; }
      catch (e) {
        o.rattrapeApres = Date.now() + RATTRAPE_ATTENTE_MS;
        note(c, 'Could not catch up on ' + (o.sym || adr) + ': ' + resume(e) + ' — will try again in '
              + Math.round(RATTRAPE_ATTENTE_MS / 60000) + ' min', { adr });
      }
      await dors(PAUSE_MS);
    }
  }
  if (n) sauve();
  return n;
}
function surVente(t) { return enFile(() => venteFile(t)); }

async function achatFile(t) {
  /* Le cours de l'ETH avant de dimensionner : le plancher est en dollars. Un
     seul appel, garde dix minutes, et sans lui on retombe sur le plancher en
     ETH plutot que d'inventer une conversion. */
  await litEthUsd();
  const liste = actifs();
  if (!liste.length) return 0;
  let n = 0;
  for (const { c } of liste) {
    try { if (await achetePosition(c, t)) n++; }
    catch (e) { note(c, 'Could not follow the buy on ' + (t.sym || t.adr) + ': ' + resume(e), { adr: t.adr }); }
    await dors(PAUSE_MS);
  }
  if (n) sauve();
  return n;
}

async function venteFile(t) {
  let n = 0;
  /* Une TRANCHE : la colonie vient d'encaisser une part de sa position de
     depart (35 % au palier +15 %, …). Le miroir vend la meme part de la
     sienne, et garde le reste en course. Sans `part`, c'est la fermeture. */
  const part = Number(t.part);
  for (const [, c] of Object.entries(R.comptes)) {
    const o = c.ouvertes && c.ouvertes[norm(t.adr)];
    if (!o) continue;
    const reste = o.reste === undefined ? 1 : o.reste;
    const tranche = isFinite(part) && part > 0 && reste - Math.min(part, reste) > 0.001;
    try { if (tranche) await vendTranche(c, norm(t.adr), o, Math.min(part, reste), t.raison);
          else await vendPosition(c, norm(t.adr), o);
          n++; }
    catch (e) { note(c, 'Could not follow the sell on ' + (o.sym || t.adr) + ': ' + resume(e), { adr: t.adr }); }
    await dors(PAUSE_MS);
  }
  if (n) sauve();
  return n;
}

async function achetePosition(c, t) {
  const adr = norm(t.adr);
  if (!c.ouvertes) c.ouvertes = {};
  if (c.ouvertes[adr]) return false;                 /* une seule par jeton, comme la colonie */
  const solde = await provider().getBalance(c.adr);
  const mise = miseDe(solde, t.part);
  if (mise.lte(0)) {
    note(c, 'Skipped ' + (t.sym || adr) + ': ' + pourquoiPasDeMise(solde));
    return false;
  }
  /* Le plancher a-t-il RELEVE la mise ? Le joueur doit le savoir : sa position
     pese alors plus que la part du Banquier, donc son portefeuille en tiendra
     moins a la fois. */
  const partB = partSeule(solde, t.part);
  const releve = partB.gt(0) && mise.gt(partB);
  /* Le gaz du moment, lu sur la chaine, contre la mise : un trade dont le gaz
     de l'ALLER-RETOUR mange plus d'un dixieme ne part pas — en essai comme en
     reel, pour que le papier montre ce que le reel ferait. Voir
     `GAZ_ALLER_RETOUR_UNITES` : on entre pour ressortir, et c'est la somme des
     deux jambes qui se compare a la mise, pas la moitie d'une. */
  let gaz = null;
  try { gaz = (await provider().getGasPrice()).mul(GAZ_ALLER_RETOUR_UNITES); } catch (e) { gaz = null; }
  if (gaz && gaz.mul(Math.round(1 / GAZ_PART_MAX)).gt(mise)) {
    note(c, 'Skipped ' + (t.sym || adr) + ': gas for the round trip is about ' + ethers.utils.formatUnits(gaz, 18)
          + ' ETH (RH), more than ' + Math.round(GAZ_PART_MAX * 100) + '% of the ' + ethers.utils.formatUnits(mise, 18)
          + ' ETH stake — trading that would be trading gas');
    return false;
  }
  const { choix, compare } = await meilleurePlace(adr, t.pool, mise);
  const route = choix.route, retour = choix.retour;
  if (retour.mul(10000).lt(mise.mul(Math.round(RETOUR_MIN * 10000)))) {
    const pct = mise.isZero() ? 0 : Math.round(Number(retour.mul(10000).div(mise)) / 100);
    note(c, 'Skipped ' + (t.sym || adr) + ': selling straight back would return ' + pct + '% of the stake ('
          + ethers.utils.formatUnits(retour, 18) + ' ETH for ' + ethers.utils.formatUnits(mise, 18)
          + ') — the pool lets you in, not out. Nothing was sent', { adr });
    return false;
  }
  const r = await acheteRoute(c, route, adr, mise);
  c.ouvertes[adr] = {
    sym: t.sym || null, ver: route.ver,
    pool: route.ver === 'v4' ? route.id : route.paire,
    cle: route.cle || null, zeroVersUn: route.ver === 'v4' ? route.zeroEstEth : null,
    enWeth: route.ver === 'v4' ? !!route.enWeth : null,
    fee: route.fee || null,
    monnaie: route.monnaie || MONNAIE_ETH, pont: route.pont || null,
    entree: ethers.utils.formatUnits(mise, 18),
    /* Ce que le portefeuille a VRAIMENT depense : mise + gaz + autorisations,
       lu sur le solde avant et apres. En essai, la mise seule. */
    cout: r.coutReel ? ethers.utils.formatUnits(r.coutReel, 18) : null,
    jetons: r.sortie.toString(), t: Date.now(), simule: r.simule, tx: r.tx || null,
    /* Une position ouverte a la main n a pas de jumelle de papier : le
       rattrapage ne doit pas la prendre pour une vente manquee. */
    manuel: !!t.manuel,
  };
  /* Le journal dit la PART, et d'ou elle vient : sans ca, « 0,0031 ETH » ne
     laisse pas savoir si le miroir a suivi le Banquier ou son propre repli. */
  const dit = releve
    ? 'raised to the ' + (ORDRE_MIN_USD > 0 && coursEth() > 0 ? '$' + ORDRE_MIN_USD : ORDRE_MIN_ETH + ' ETH')
      + ' floor — the Banker\'s share would have been ' + ethers.utils.formatUnits(partB, 18) + ' ETH'
      + (coursEth() > 0 ? ' (' + enDollars(partB) + ')' : '')
      + ', too small to survive the gas on both sides. This wallet holds fewer positions at once'
    : t.part
    ? (Math.round(t.part * 1000) / 10) + '% of what was free — the Banker\'s own share'
      + (t.score ? ' at score ' + t.score : '')
    : t.manuel
      ? (Math.round(PART_ORDRE * 1000) / 10) + '% of what was free — at your request'
      : (Math.round(PART_ORDRE * 1000) / 10) + '% of what was free (fallback: no share from the colony)';
  const places = compare.length > 1
    ? ' · best of ' + compare.length + ' venues (' + compare.map((x) => x.ver + (x.via ? ' via ' + x.via : '') + ' ' + x.retourPct + '%' + (x.colonie ? ', the colony\'s' : '')).join(', ') + ' round trip)'
    : '';
  note(c, (r.simule ? '[dry run] ' : '') + 'Bought ' + (t.sym || adr) + ' for '
        + ethers.utils.formatUnits(mise, 18) + ' ETH (RH) on Uniswap ' + route.ver + viaPont(route) + places
        + (r.coutReel ? ' · cost incl. gas ' + ethers.utils.formatUnits(r.coutReel, 18) + ' ETH' : '')
        + (r.simule && EXECUTE && route.pont ? ' · bridged positions stay dry-run until MIROIR_PONTS_EXECUTE=1' : '')
        + ' · ' + dit,
        { adr, tx: r.tx || null });
  return true;
}

/** Ce que le portefeuille tient de ce jeton — lu sur la chaine en reel, note
 *  par le miroir en essai. */
/** « via NVDA (bridge Uniswap v3) » — ou rien, en ETH. */
function viaPont(r) {
  return r && r.pont ? ' via ' + r.monnaie.sym + ' (bridge Uniswap ' + r.pont.ver + ')' : '';
}
async function tenu(c, adr, o) {
  let montant = ethers.BigNumber.from(o.jetons || '0');
  if (EXECUTE) {
    try { montant = await new ethers.Contract(adr, ERC20_ABI, provider()).balanceOf(c.adr); }
    catch (e) { /* illisible : on garde ce que le miroir avait note */ }
  }
  return montant;
}

/** Vendre une PART de la position de depart, comme la colonie vient de le
 *  faire. `f` est la fraction de la position initiale ; ce qu'on vend est la
 *  fraction correspondante de ce qu'on tient ENCORE. Ce qui revient s'ajoute
 *  a la position, pour que la fermeture compte tout. */
async function vendTranche(c, adr, o, f, raison) {
  const reste = o.reste === undefined ? 1 : o.reste;
  const montantTenu = await tenu(c, adr, o);
  if (montantTenu.lte(0)) { delete c.ouvertes[adr]; return { sortie: null, tx: null }; }
  const montant = montantTenu.mul(Math.round(f / reste * 1e6)).div(1e6);
  if (montant.lte(0)) return { sortie: null, tx: null };
  const route = await routeDePosition(adr, o);
  const devisT = await devisRoute(route, 'vente', adr, montant);
  const gazT = await gazDeVente(route);
  if (devisT.lt(gazT.mul(POUSSIERE_MULT))) {
    /* La tranche vaut moins que son gaz : on la laisse courir avec le reste. */
    /* Une tranche qui ne vaut pas son gaz peut n'etre qu'une petite tranche.
       Une piscine qui ne rend plus rien du tout, non : on le dit, et on le dit
       a la colonie — c'est le papier qui compte un gain imprenable. */
    ditPiscineMorte(c, adr, Object.assign({}, o, { cout: null, entree: ethers.utils.formatUnits(
      WEI(o.cout || o.entree || '0').mul(Math.max(1, Math.round(f * 1000))).div(1000), 18) }), devisT);
    note(c, 'Kept the ' + Math.round(f * 100) + '% tranche of ' + (o.sym || adr) + ': selling it would return '
          + ethers.utils.formatUnits(devisT, 18) + ' ETH (RH) for about ' + ethers.utils.formatUnits(gazT, 18)
          + ' ETH of gas — not worth it, it stays in the position', { adr });
    return { sortie: null, tx: null, poussiere: true };
  }
  const r = await vendRoute(c, route, adr, montant, devisT);
  o.jetons = montantTenu.sub(montant).toString();
  o.reste = Math.max(0, reste - f);
  const revenu = r.recuReel || r.sortie;
  o.sortiesPartielles = ethers.utils.formatUnits(
    WEI(o.sortiesPartielles || '0').add(revenu), 18);
  note(c, (r.simule ? '[dry run] ' : '') + 'Sold ' + Math.round(f * 100) + '% of ' + (o.sym || adr)
        + ' for ' + ethers.utils.formatUnits(revenu, 18) + ' ETH (RH)' + (r.recuReel ? ' net of gas' : '')
        + ' on Uniswap ' + route.ver + viaPont(route) + (raison ? ' · ' + raison : '')
        + ' · ' + Math.round(o.reste * 100) + '% still running', { adr, tx: r.tx || null });
  return r;
}

async function vendPosition(c, adr, o) {
  /* On vend ce que le portefeuille TIENT, pas ce qu'on croit qu'il tient. En
     execution reelle, une taxe de transfert ou un arrondi fait diverger les
     deux, et vendre un montant qu'on n'a pas fait echouer tout l'ordre. */
  const montant = await tenu(c, adr, o);
  if (montant.lte(0)) { delete c.ouvertes[adr]; return { sortie: null, tx: null }; }
  const route = await routeDePosition(adr, o);
  const devisV = await devisRoute(route, 'vente', adr, montant);
  const gazV = await gazDeVente(route);
  if (devisV.lt(gazV.mul(POUSSIERE_MULT))) {
    /* Vendre couterait plus que ce que ca rend : les jetons restent au joueur,
       la position est fermee comme une perte entiere, et c'est dit. */
    ditPiscineMorte(c, adr, o, devisV);
    delete c.ouvertes[adr];
    if (!Array.isArray(c.fermees)) c.fermees = [];
    const deja = WEI(o.sortiesPartielles || '0');
    c.fermees.push({ adr, sym: o.sym || null, entree: o.cout || o.entree, mise: o.entree,
                     sortie: ethers.utils.formatUnits(deja, 18), tranches: o.sortiesPartielles || null,
                     devis: ethers.utils.formatUnits(devisV, 18), reel: EXECUTE, poussiere: true,
                     t0: o.t, t: Date.now(), simule: !EXECUTE, tx: null });
    if (c.fermees.length > FERMEES_MAX) c.fermees.splice(0, c.fermees.length - FERMEES_MAX);
    note(c, 'Kept ' + (o.sym || adr) + ': selling would return ' + ethers.utils.formatUnits(devisV, 18)
          + ' ETH (RH) for about ' + ethers.utils.formatUnits(gazV, 18) + ' ETH of gas — not worth it. The tokens '
          + 'stay in the wallet (they are yours); the position counts as a loss of '
          + ethers.utils.formatUnits(WEI(o.cout || o.entree).sub(deja), 18) + ' ETH', { adr });
    return { sortie: null, tx: null, poussiere: true };
  }
  const r = await vendRoute(c, route, adr, montant, devisV);
  delete c.ouvertes[adr];
  /* ---- LE BILAN DU JOUEUR ----
   * « L'utilisateur voit bien son solde, mais il faudrait une deuxieme barre,
   *   personnelle : profit, taux de gain, trades, meilleur, ouvert. »
   * Chaque vente laisse une ligne : ce qui est entre, ce qui est sorti, en
   * ETH. C'est de la que la barre se calcule — pas d'un compteur qu'on
   * incrementerait a cote et qui finirait par diverger. */
  if (!Array.isArray(c.fermees)) c.fermees = [];
  /* ---- LES PERTES SE COMPTENT SUR LE SOLDE, PAS SUR LE DEVIS ----
   * « Il ne calcule pas correctement les pertes, c'est sur. » Il comptait le
   * devis du quoteur comme sortie, et la mise comme entree : ni le gaz des
   * deux transactions, ni les autorisations, ni l'ecart entre le devis et le
   * bloc. Sur un ordre de 0,00003 ETH, le gaz seul en valait autant. En
   * reel, l'entree est ce que le solde a perdu a l'achat, la sortie ce qu'il
   * a regagne a la vente — gaz compris des deux cotes. Le devis reste note,
   * pour comparer. */
  /* Ce que les tranches ont deja rendu compte dans la sortie : la ligne dit
     ce que la position ENTIERE a rapporte, pas ce que valait le reliquat. */
  const deja = WEI(o.sortiesPartielles || '0');
  const finale = r.recuReel || r.sortie || ethers.BigNumber.from(0);
  c.fermees.push({ adr, sym: o.sym || null,
                   entree: o.cout || o.entree, mise: o.entree,
                   sortie: (r.recuReel || r.sortie) ? ethers.utils.formatUnits(deja.add(finale), 18) : null,
                   tranches: o.sortiesPartielles ? ethers.utils.formatUnits(deja, 18) : null,
                   devis: r.sortie ? ethers.utils.formatUnits(r.sortie, 18) : null,
                   reel: !!r.recuReel,
                   t0: o.t, t: Date.now(), simule: !!r.simule, tx: r.tx || null });
  if (c.fermees.length > FERMEES_MAX) c.fermees.splice(0, c.fermees.length - FERMEES_MAX);
  /* Et la colonie apprend sur CE chiffre-la, pas sur le prix : voir
     `ditExecutionReelle`. */
  ditExecutionReelle(c, adr, o, r);
  /* En reel, le chiffre qui compte est ce que le solde a regagne, gaz deduit ;
     le devis n est qu une comparaison. En essai, il n y a que le devis. */
  note(c, r.recuReel
    ? 'Sold ' + (o.sym || adr) + ' for ' + ethers.utils.formatUnits(r.recuReel, 18) + ' ETH (RH) net of gas on Uniswap '
      + route.ver + viaPont(route) + ' · quote was ' + ethers.utils.formatUnits(r.sortie, 18) + ' ETH'
      + (o.sortiesPartielles ? ' · plus ' + o.sortiesPartielles + ' ETH banked on the way' : '')
      + ' · result ' + ethers.utils.formatUnits(r.recuReel.add(WEI(o.sortiesPartielles || '0')).sub(WEI(o.cout || o.entree)), 18) + ' ETH incl. gas both ways'
    : '[dry run] Sold ' + (o.sym || adr) + ' for ' + ethers.utils.formatUnits(r.sortie, 18) + ' ETH (RH) on Uniswap ' + route.ver + viaPont(route)
      + (o.sortiesPartielles ? ' · plus ' + o.sortiesPartielles + ' ETH banked on the way' : ''),
    { adr, tx: r.tx || null });
  return r;
}

/* ==================== A LA DEMANDE DU JOUEUR ====================
 *
 * « Rajoute un bouton sell maintenant, et une colonne pour voir les positions
 *   ouvertes du miroir et pouvoir les fermer et les ouvrir. »
 *
 * Deux gestes, sur SON miroir seulement — le serveur passe l'adresse prouvee
 * a la connexion, jamais un champ du message. Ils passent par la meme file
 * et les memes routes que ce que la colonie declenche : memes devis, meme
 * garde d'aller-retour, meme journal, meme bilan. Un geste du joueur n'a pas
 * de chemin a part : ce qui protege l'ordre de la colonie le protege aussi. */
function vendsMaintenant(joueur, adr) { return enFile(() => vendsFile(joueur, adr)); }
async function vendsFile(joueur, adr) {
  const c = fiche(joueur);
  if (!c) throw new Error('no mirror wallet');
  const a = norm(adr);
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('not a token address');
  const o = c.ouvertes && c.ouvertes[a];
  if (!o) throw new Error('no open position on that token');
  note(c, 'Sell now on ' + (o.sym || a) + ' — at your request', { adr: a });
  const r = await vendPosition(c, a, o);
  sauve();
  return { adr: a, sym: o.sym || null, poussiere: !!r.poussiere,
           sortie: r.sortie ? ethers.utils.formatUnits(r.sortie, 18) : null, tx: r.tx || null };
}
function ouvreMaintenant(joueur, adr) { return enFile(() => ouvreFile(joueur, adr)); }
async function ouvreFile(joueur, adr) {
  const c = fiche(joueur);
  if (!c) throw new Error('no mirror wallet');
  if (!c.actif) throw new Error('press Play first: the mirror only trades while it is running');
  const a = norm(adr);
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('not a token address');
  if (c.ouvertes && c.ouvertes[a]) throw new Error('already open on that token');
  const sym = await symbole(a);
  note(c, 'Buy now on ' + sym + ' — at your request', { adr: a });
  const ok = await achetePosition(c, { adr: a, sym, pool: null, manuel: true });
  sauve();
  if (!ok) throw new Error('nothing was bought on ' + sym + ' — the log says why');
  return { adr: a, sym };
}

module.exports = {
  /* l'interface du serveur */
  charge, sauve, pret, cree, revele, etat, demarre, arrete, surAchat, surVente, surTour, allerRetour, pontConnu, pontsVus, effaceJournal,
  poseColonie, PISCINE_MORTE, evalueFile, EVAL_TTL_MS,
  ORDRE_MIN_USD, litEthUsd, coursEth, plancherOrdre, minPourJouer,
  _poseSourceEthUsd: poseSourceEthUsd, _partSeule: partSeule, _oublieLeCours: oublieLeCours,
  vendsMaintenant, ouvreMaintenant, remetLesStats,
  /* les reglages, pour l'ecran et pour les essais */
  EXECUTE, MIROIRS_MAX, MIN_ETH, MAX_ETH, PART_ORDRE, ORDRE_MAX_ETH, ORDRE_MIN_ETH, GAZ_RESERVE, RETOUR_MIN, POUSSIERE_MULT,
  GAZ_ORDRE_UNITES, GAZ_ALLER_RETOUR_UNITES, GAZ_PART_MAX,
  TOLERANCE_BPS, FICHIER,
  /* les adresses du protocole */
  PM4, QUOTEUR4, ROUTEUR4, PERMIT2, ETH4, SUJET_INIT,
  WETH, ROUTEUR2, FABRIQUE2, ROUTEUR3, QUOTEUR3, FABRIQUE3, ADRESSE_ROUTEUR,
  WRAP_ETH, UNWRAP_WETH, ACTES4_WETH_ACHAT, ACTES4_WETH_VENTE, SWAP4_T, V4_SWAP,
  /* exposes pour les essais : ce sont eux qui portent les regles */
  _chiffre: chiffre, _dechiffre: dechiffre, _cleMaitresse: cleMaitresse,
  _idV4: idV4, _clePiscine: clePiscine, _devis: devis, _corpsV4: corpsV4,
  _plancher: plancher, _miseDe: miseDe, _pourquoiPasDeMise: pourquoiPasDeMise, _balaie: balaie,
  _routeDe: routeDe, _devisRoute: devisRoute, _devisJambe: devisJambe, _ordre: ordre, _R2_ABI: R2_ABI, _R3_ABI: R3_ABI,
  _deuxJambes: deuxJambes, _monnaieDe: monnaieDe, _pontPour: pontPour, _oublieLesPonts: oublieLesPonts, PONTS, PONT_LIQ_MIN, PONTS_EXECUTE,
  _meilleurePlace: meilleurePlace, _poseSourcePaires: poseSourcePaires, GAZ_PLACE, LIQ_PLACE_MIN,
  _etat: () => R, _pose: (x) => { R = x; }, _poseProvider: poseProvider,
  _fiche: fiche, _actifs: actifs, _bilan: bilan, _reconcilie: reconcilie, _resume: resume,
  _oublieReconciliation: () => derniereReconciliation.clear(),
};
