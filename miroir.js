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

const SUJET_INIT = ethers.utils.id(
  'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');

const UR_ABI = ['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'];
const Q4_ABI = ['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
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
const GAZ_PART_MAX = Math.min(0.5, Math.max(0.01, nEnv('MIROIR_GAZ_PART_MAX', 0.1)));
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
  const lit = (topics) => p.getLogs({ address: PM4, fromBlock: depuis, toBlock: tip, topics });
  const paire = norm(ETH4) < norm(jeton) ? [ETH4, jeton] : [jeton, ETH4];
  const parId = !!(pool && /^0x[0-9a-fA-F]{64}$/.test(String(pool)));
  let logs = [];
  try {
    if (parId) logs = await lit([SUJET_INIT, String(pool).toLowerCase()]);
    if (!logs.length) logs = await lit([SUJET_INIT, null, mot(paire[0]), mot(paire[1])]);
  } catch (e) { throw new Error('pool lookup failed: ' + e.message); }
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
    const zeroEstEth = norm(c0) === norm(ETH4), unEstEth = norm(c1) === norm(ETH4);
    if (!zeroEstEth && !unEstEth)
      return { cle: k, id, zeroEstEth: false, contreEth: false,
               autre: norm(c0) === norm(jeton) ? c1 : c0 };
    return { cle: k, id, zeroEstEth, contreEth: true };
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
    const avecWeth = norm(t0) === norm(WETH) || norm(t1) === norm(WETH);
    if (!avecWeth)
      throw new Error('its pool is quoted in ' + await symbole(norm(t0) === norm(jeton) ? t1 : t0)
                      + ', not ETH: the mirror only trades ETH pairs');
    let fee = null;
    try { fee = Number(await pr.fee()); } catch (e) { fee = null; }
    if (fee !== null && isFinite(fee)) return { ver: 'v3', paire: ethers.utils.getAddress(pool), fee };
    try { await pr.getReserves(); }
    catch (e) { throw new Error('the pool address given by the colony is neither a v2 pair nor a v3 pool (' + String(pool).slice(0, 10) + '…)'); }
    return { ver: 'v2', paire: ethers.utils.getAddress(pool) };
  }
  const p4 = await clePiscine(jeton, pool);
  if (p4) {
    if (!p4.contreEth)
      throw new Error('its pool is quoted in ' + await symbole(p4.autre) + ', not ETH: the mirror only trades ETH pairs');
    return { ver: 'v4', cle: p4.cle, id: p4.id, zeroEstEth: p4.zeroEstEth };
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
async function devisRoute(r, sens, jeton, montant) {
  const achat = sens === 'achat';
  if (r.ver === 'v4') return devis(r.cle, achat ? r.zeroEstEth : !r.zeroEstEth, montant);
  if (r.ver === 'v2') {
    const v2 = new ethers.Contract(ROUTEUR2, R2_ABI, provider());
    const a = await v2.getAmountsOut(montant, achat ? [WETH, jeton] : [jeton, WETH]);
    return ethers.BigNumber.from(a[a.length - 1]);
  }
  const q = new ethers.Contract(QUOTEUR3, Q3_ABI, provider());
  const x = await q.callStatic.quoteExactInputSingle({
    tokenIn: achat ? WETH : jeton, tokenOut: achat ? jeton : WETH,
    amountIn: montant, fee: r.fee, sqrtPriceLimitX96: 0,
  });
  return ethers.BigNumber.from(x.amountOut !== undefined ? x.amountOut : x[0]);
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
  if (r.ver === 'v4') {
    const i = new ethers.utils.Interface(UR_ABI);
    const corps = corpsV4(r.cle, achat ? r.zeroEstEth : !r.zeroEstEth, montant, mini);
    return { to: ROUTEUR4, data: i.encodeFunctionData('execute', [V4_SWAP, [corps], echeance]),
             value: achat ? montant : ethers.BigNumber.from(0) };
  }
  if (r.ver === 'v2') {
    const i = new ethers.utils.Interface(R2_ABI);
    /* Les variantes « SupportingFeeOnTransfer » : un jeton qui prend une taxe
       au passage fait echouer les autres, et sur cette chaine c'est courant. */
    return achat
      ? { to: ROUTEUR2, value: montant,
          data: i.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',
                                     [mini, [WETH, jeton], vers, echeance]) }
      : { to: ROUTEUR2, value: ethers.BigNumber.from(0),
          data: i.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',
                                     [montant, mini, [jeton, WETH], vers, echeance]) };
  }
  const i = new ethers.utils.Interface(R3_ABI);
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
async function acheteRoute(c, r, jeton, entreeWei) {
  const sortie = await devisRoute(r, 'achat', jeton, entreeWei);
  const mini = plancher(sortie);
  if (!EXECUTE) return { simule: true, sortie, mini, tx: null };
  const w = signataire(c);
  const avant = await provider().getBalance(w.address);
  const o = ordre(r, 'achat', jeton, entreeWei, mini, w.address, Math.floor(Date.now() / 1000) + ECHEANCE_S);
  const tx = await w.sendTransaction(o);
  const rc = await tx.wait();
  const apres = await provider().getBalance(w.address);
  /* Un depot arrive pendant la transaction rendrait le cout negatif : on
     retombe alors sur la mise, jamais sur un chiffre absurde. */
  const coutReel = avant.gt(apres) ? avant.sub(apres) : entreeWei;
  return { simule: false, sortie, mini, tx: rc.transactionHash, coutReel };
}

async function autorise(w, jeton, montant) {
  const t = new ethers.Contract(jeton, ERC20_ABI, w);
  const a1 = await t.allowance(w.address, PERMIT2);
  if (a1.lt(montant)) {
    const tx = await t.approve(PERMIT2, ethers.constants.MaxUint256);
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
      ethers.BigNumber.from(2).pow(160).sub(1), Math.floor(Date.now() / 1000) + 86400);
    await tx.wait();
  }
}

/** L'autorisation simple d'un ERC-20 vers un routeur v2 ou v3. */
async function autoriseSimple(w, jeton, routeur, montant) {
  const t = new ethers.Contract(jeton, ERC20_ABI, w);
  const a = await t.allowance(w.address, routeur);
  if (a.lt(montant)) {
    const tx = await t.approve(routeur, ethers.constants.MaxUint256);
    await tx.wait();
  }
}

async function vendRoute(c, r, jeton, montantWei) {
  const sortie = await devisRoute(r, 'vente', jeton, montantWei);
  const mini = plancher(sortie);
  if (!EXECUTE) return { simule: true, sortie, mini, tx: null };
  const w = signataire(c);
  /* Avant les autorisations : leur gaz fait partie du prix de cette vente. */
  const avant = await provider().getBalance(w.address);
  if (r.ver === 'v4') await autorise(w, jeton, montantWei);
  else await autoriseSimple(w, jeton, r.ver === 'v2' ? ROUTEUR2 : ROUTEUR3, montantWei);
  const o = ordre(r, 'vente', jeton, montantWei, mini, w.address, Math.floor(Date.now() / 1000) + ECHEANCE_S);
  const tx = await w.sendTransaction(o);
  const rc = await tx.wait();
  const apres = await provider().getBalance(w.address);
  /* Ce qui est revenu, gaz deduit. Une vente qui rend moins que son gaz
     donne un chiffre negatif : c'est la verite, on la garde. */
  const recuReel = apres.sub(avant);
  return { simule: false, sortie, mini, tx: rc.transactionHash, recuReel };
}

/** La route d'une position deja ouverte, telle qu'elle a ete notee a l'achat.
 *  Une position d'avant les routes n'a qu'une clef : c'est du v4. */
async function routeDePosition(adr, o) {
  if (o.ver === 'v2') return { ver: 'v2', paire: o.pool };
  if (o.ver === 'v3') return { ver: 'v3', paire: o.pool, fee: o.fee };
  const cle = o.cle || (await clePiscine(adr, o.pool) || {}).cle;
  if (!cle) throw new Error('pool key lost for this token');
  return { ver: 'v4', cle, zeroEstEth: !!o.zeroVersUn };
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
  const plaf = WEI(ORDRE_MAX_ETH), mini = WEI(ORDRE_MIN_ETH);
  /* Sous le plancher, on prend le plancher si le disponible le permet : un
     petit portefeuille tient moins de positions, mais des positions qui
     valent leur gaz. Sinon, rien — et `pourquoiPasDeMise` le dit. */
  if (mise.lt(mini)) mise = dispo.gte(mini) ? mini : ethers.BigNumber.from(0);
  return mise.gt(plaf) ? plaf : mise;
}

/** La phrase qui va avec une mise nulle : les chiffres, et quoi faire. */
function pourquoiPasDeMise(soldeWei) {
  const solde = ethers.utils.formatUnits(soldeWei, 18);
  const dispo = ethers.BigNumber.from(soldeWei).sub(WEI(GAZ_RESERVE));
  if (dispo.lte(0))
    return solde + ' ETH (RH) is under the ' + GAZ_RESERVE + ' ETH gas reserve, which is never spent on a buy';
  return ethers.utils.formatUnits(dispo, 18) + ' ETH (RH) free after the ' + GAZ_RESERVE
    + ' ETH gas reserve, and an order needs at least ' + ORDRE_MIN_ETH + ' ETH to be worth its gas'
    + ' — fund the mirror with ' + MIN_ETH + ' ETH or more';
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
  for (const x of f) {
    const e = Number(x.entree) || 0, s = Number(x.sortie) || 0;
    profit += s - e;
    if (s > e) gagnantes++;
    if (e > 0 && s / e > meilleur) meilleur = s / e;
  }
  return { trades: f.length, gagnantes, profitEth: profit.toFixed(6),
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
    min: MIN_ETH, max: MAX_ETH, part: PART_ORDRE, ordreMax: ORDRE_MAX_ETH, ordreMin: ORDRE_MIN_ETH,
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
    })),
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
  if (solde.lt(WEI(MIN_ETH)))
    throw new Error('fund the mirror wallet first — at least ' + MIN_ETH + ' ETH (RH)');
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
      rates.push({ sym: o.sym, adr, pourquoi: e.message });
      note(c, 'Could not sell ' + (o.sym || adr) + ' on stop: ' + e.message, { adr });
    }
    await dors(PAUSE_MS);
  }

  let balaye = null;
  if (EXECUTE) {
    try { balaye = await balaie(c, vers); }
    catch (e) { note(c, 'Sweep failed: ' + e.message); }
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
  const tx = await w.sendTransaction({ to: vers, value: montant });
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
function surVente(t) { return enFile(() => venteFile(t)); }

async function achatFile(t) {
  const liste = actifs();
  if (!liste.length) return 0;
  let n = 0;
  for (const { c } of liste) {
    try { if (await achetePosition(c, t)) n++; }
    catch (e) { note(c, 'Could not follow the buy on ' + (t.sym || t.adr) + ': ' + e.message, { adr: t.adr }); }
    await dors(PAUSE_MS);
  }
  if (n) sauve();
  return n;
}

async function venteFile(t) {
  let n = 0;
  for (const [, c] of Object.entries(R.comptes)) {
    const o = c.ouvertes && c.ouvertes[norm(t.adr)];
    if (!o) continue;
    try { await vendPosition(c, norm(t.adr), o); n++; }
    catch (e) { note(c, 'Could not follow the sell on ' + (o.sym || t.adr) + ': ' + e.message, { adr: t.adr }); }
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
  /* Le gaz du moment, lu sur la chaine, contre la mise : un ordre dont le gaz
     mange plus d'un dixieme ne part pas — en essai comme en reel, pour que
     le papier montre ce que le reel ferait. */
  let gaz = null;
  try { gaz = (await provider().getGasPrice()).mul(GAZ_ORDRE_UNITES); } catch (e) { gaz = null; }
  if (gaz && gaz.mul(Math.round(1 / GAZ_PART_MAX)).gt(mise)) {
    note(c, 'Skipped ' + (t.sym || adr) + ': gas for one order is about ' + ethers.utils.formatUnits(gaz, 18)
          + ' ETH (RH), more than ' + Math.round(GAZ_PART_MAX * 100) + '% of the ' + ethers.utils.formatUnits(mise, 18)
          + ' ETH stake — trading that would be trading gas');
    return false;
  }
  const route = await routeDe(adr, t.pool);
  const r = await acheteRoute(c, route, adr, mise);
  c.ouvertes[adr] = {
    sym: t.sym || null, ver: route.ver,
    pool: route.ver === 'v4' ? route.id : route.paire,
    cle: route.cle || null, zeroVersUn: route.ver === 'v4' ? route.zeroEstEth : null,
    fee: route.fee || null,
    entree: ethers.utils.formatUnits(mise, 18),
    /* Ce que le portefeuille a VRAIMENT depense : mise + gaz + autorisations,
       lu sur le solde avant et apres. En essai, la mise seule. */
    cout: r.coutReel ? ethers.utils.formatUnits(r.coutReel, 18) : null,
    jetons: r.sortie.toString(), t: Date.now(), simule: r.simule, tx: r.tx || null,
  };
  /* Le journal dit la PART, et d'ou elle vient : sans ca, « 0,0031 ETH » ne
     laisse pas savoir si le miroir a suivi le Banquier ou son propre repli. */
  const dit = t.part
    ? (Math.round(t.part * 1000) / 10) + '% of what was free — the Banker\'s own share'
      + (t.score ? ' at score ' + t.score : '')
    : (Math.round(PART_ORDRE * 1000) / 10) + '% of what was free (fallback: no share from the colony)';
  note(c, (r.simule ? '[dry run] ' : '') + 'Bought ' + (t.sym || adr) + ' for '
        + ethers.utils.formatUnits(mise, 18) + ' ETH (RH) on Uniswap ' + route.ver
        + (r.coutReel ? ' · cost incl. gas ' + ethers.utils.formatUnits(r.coutReel, 18) + ' ETH' : '')
        + ' · ' + dit,
        { adr, tx: r.tx || null });
  return true;
}

async function vendPosition(c, adr, o) {
  /* On vend ce que le portefeuille TIENT, pas ce qu'on croit qu'il tient. En
     execution reelle, une taxe de transfert ou un arrondi fait diverger les
     deux, et vendre un montant qu'on n'a pas fait echouer tout l'ordre. */
  let montant = ethers.BigNumber.from(o.jetons || '0');
  if (EXECUTE) {
    try {
      const t = new ethers.Contract(adr, ERC20_ABI, provider());
      montant = await t.balanceOf(c.adr);
    } catch (e) { /* illisible : on garde ce que le miroir avait note */ }
  }
  if (montant.lte(0)) { delete c.ouvertes[adr]; return { sortie: null, tx: null }; }
  const route = await routeDePosition(adr, o);
  const r = await vendRoute(c, route, adr, montant);
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
  c.fermees.push({ adr, sym: o.sym || null,
                   entree: o.cout || o.entree, mise: o.entree,
                   sortie: r.recuReel ? ethers.utils.formatUnits(r.recuReel, 18)
                                      : (r.sortie ? ethers.utils.formatUnits(r.sortie, 18) : null),
                   devis: r.sortie ? ethers.utils.formatUnits(r.sortie, 18) : null,
                   reel: !!r.recuReel,
                   t0: o.t, t: Date.now(), simule: !!r.simule, tx: r.tx || null });
  if (c.fermees.length > FERMEES_MAX) c.fermees.splice(0, c.fermees.length - FERMEES_MAX);
  /* En reel, le chiffre qui compte est ce que le solde a regagne, gaz deduit ;
     le devis n est qu une comparaison. En essai, il n y a que le devis. */
  note(c, r.recuReel
    ? 'Sold ' + (o.sym || adr) + ' for ' + ethers.utils.formatUnits(r.recuReel, 18) + ' ETH (RH) net of gas on Uniswap '
      + route.ver + ' · quote was ' + ethers.utils.formatUnits(r.sortie, 18) + ' ETH · result '
      + ethers.utils.formatUnits(r.recuReel.sub(WEI(o.cout || o.entree)), 18) + ' ETH incl. gas both ways'
    : '[dry run] Sold ' + (o.sym || adr) + ' for ' + ethers.utils.formatUnits(r.sortie, 18) + ' ETH (RH) on Uniswap ' + route.ver,
    { adr, tx: r.tx || null });
  return r;
}

module.exports = {
  /* l'interface du serveur */
  charge, sauve, pret, cree, revele, etat, demarre, arrete, surAchat, surVente,
  /* les reglages, pour l'ecran et pour les essais */
  EXECUTE, MIROIRS_MAX, MIN_ETH, MAX_ETH, PART_ORDRE, ORDRE_MAX_ETH, ORDRE_MIN_ETH, GAZ_RESERVE,
  GAZ_ORDRE_UNITES, GAZ_PART_MAX,
  TOLERANCE_BPS, FICHIER,
  /* les adresses du protocole */
  PM4, QUOTEUR4, ROUTEUR4, PERMIT2, ETH4, SUJET_INIT,
  WETH, ROUTEUR2, FABRIQUE2, ROUTEUR3, QUOTEUR3, FABRIQUE3, ADRESSE_ROUTEUR,
  /* exposes pour les essais : ce sont eux qui portent les regles */
  _chiffre: chiffre, _dechiffre: dechiffre, _cleMaitresse: cleMaitresse,
  _idV4: idV4, _clePiscine: clePiscine, _devis: devis, _corpsV4: corpsV4,
  _plancher: plancher, _miseDe: miseDe, _pourquoiPasDeMise: pourquoiPasDeMise, _balaie: balaie,
  _routeDe: routeDe, _devisRoute: devisRoute, _ordre: ordre, _R2_ABI: R2_ABI, _R3_ABI: R3_ABI,
  _etat: () => R, _pose: (x) => { R = x; }, _poseProvider: poseProvider,
  _fiche: fiche, _actifs: actifs, _bilan: bilan, _reconcilie: reconcilie,
  _oublieReconciliation: () => derniereReconciliation.clear(),
};
