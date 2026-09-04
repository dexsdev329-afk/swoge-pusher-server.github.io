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
const MIN_ETH     = String(process.env.MIROIR_MIN_ETH || '0.002');
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
 * evenements `Initialize` du PoolManager, dont les deux jetons sont INDEXES :
 * la chaine fait le tri, pas nous. Et comme la colonie achete des jetons de
 * quelques minutes, la fenetre recente suffit toujours.
 *
 * L'identifiant recalcule doit tomber sur celui qu'on cherche. Un index faux
 * pourrait nous faire rater une piscine ; il ne peut pas nous en faire
 * inventer une. */
async function clePiscine(jeton, pool, fenetre) {
  const p = provider();
  const mot = (a) => ethers.utils.hexZeroPad(a, 32);
  const tip = await p.getBlockNumber();
  const depuis = Math.max(0, tip - (fenetre || 1000000));
  const paire = norm(ETH4) < norm(jeton) ? [ETH4, jeton] : [jeton, ETH4];
  let logs = [];
  try {
    logs = await p.getLogs({ address: PM4, fromBlock: depuis, toBlock: tip,
                             topics: [SUJET_INIT, mot(paire[0]), mot(paire[1])] });
  } catch (e) { throw new Error('pool lookup failed: ' + e.message); }
  for (const l of logs) {
    const d = ethers.utils.defaultAbiCoder.decode(
      ['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
    const k = [paire[0], paire[1], d[0], d[1], d[2]];
    const id = idV4(k);
    /* Sans pool demande, on prend la premiere : c'est le cas d'un jeton dont on
       ne connait que l'adresse. Avec, on exige l'egalite — la colonie donne
       l'identifiant que DexScreener publie, et c'est LUI qu'on doit echanger,
       pas une autre piscine du meme jeton. */
    if (!pool || norm(id) === norm(pool)) return { cle: k, id, zeroEstEth: norm(k[0]) === norm(ETH4) };
  }
  return null;
}

/** Ce que rend un echange, demande au quoteur du protocole lui-meme. */
async function devis(cleP, zeroVersUn, entree) {
  const q = new ethers.Contract(QUOTEUR4, Q4_ABI, provider());
  const r = await q.callStatic.quoteExactInputSingle({
    poolKey: { currency0: cleP[0], currency1: cleP[1], fee: cleP[2],
               tickSpacing: cleP[3], hooks: cleP[4] },
    zeroForOne: zeroVersUn, exactAmount: entree, hookData: '0x',
  });
  return ethers.BigNumber.from(r.amountOut !== undefined ? r.amountOut : r[0]);
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
 * Un achat : de l'ETH natif vers le jeton, en une transaction — le routeur
 * recoit l'ETH avec l'appel.
 *
 * Une vente : le jeton vers l'ETH, et il faut DEUX autorisations avant, parce
 * que le routeur ne prend pas les jetons lui-meme, c'est Permit2 qui les
 * deplace pour lui. Le jeton autorise Permit2 (approve ERC-20 usuel), puis
 * Permit2 autorise le routeur pour ce jeton. On ne les redemande pas a chaque
 * vente : on lit l'existant d'abord. */
async function achete(c, cleP, zeroVersUn, entreeWei) {
  const sortie = await devis(cleP, zeroVersUn, entreeWei);
  const mini = plancher(sortie);
  if (!EXECUTE) return { simule: true, sortie, mini, tx: null };
  const w = signataire(c);
  const ur = new ethers.Contract(ROUTEUR4, UR_ABI, w);
  const corps = corpsV4(cleP, zeroVersUn, entreeWei, mini);
  const tx = await ur.execute(V4_SWAP, [corps], Math.floor(Date.now() / 1000) + ECHEANCE_S,
                              { value: entreeWei });
  const r = await tx.wait();
  return { simule: false, sortie, mini, tx: r.transactionHash };
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

async function vend(c, cleP, zeroVersUn, jeton, montantWei) {
  const sortie = await devis(cleP, zeroVersUn, montantWei);
  const mini = plancher(sortie);
  if (!EXECUTE) return { simule: true, sortie, mini, tx: null };
  const w = signataire(c);
  await autorise(w, jeton, montantWei);
  const ur = new ethers.Contract(ROUTEUR4, UR_ABI, w);
  const corps = corpsV4(cleP, zeroVersUn, montantWei, mini);
  const tx = await ur.execute(V4_SWAP, [corps], Math.floor(Date.now() / 1000) + ECHEANCE_S);
  const r = await tx.wait();
  return { simule: false, sortie, mini, tx: r.transactionHash };
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
  const mise = dispo.mul(Math.round(p * 10000)).div(10000);
  const plaf = WEI(ORDRE_MAX_ETH);
  return mise.gt(plaf) ? plaf : mise;
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
async function etat(joueur, lireChaine) {
  const c = fiche(joueur);
  const base = {
    pret: pret().ok, pourquoi: pret().pourquoi, execute: EXECUTE,
    min: MIN_ETH, max: MAX_ETH, part: PART_ORDRE, ordreMax: ORDRE_MAX_ETH,
    gaz: GAZ_RESERVE, places: Math.max(0, MIROIRS_MAX - actifs().length),
  };
  if (!c) return Object.assign(base, { existe: false });
  let solde = null;
  if (lireChaine !== false) {
    try { solde = ethers.utils.formatUnits(await provider().getBalance(c.adr), 18); }
    catch (e) { solde = null; }
  }
  return Object.assign(base, {
    existe: true, adresse: c.adr, actif: !!c.actif, cree: c.cree, joue: c.joue || 0,
    solde,
    ouvertes: Object.entries(c.ouvertes || {}).map(([adr, o]) => ({
      adr, sym: o.sym, pool: o.pool, entree: o.entree, jetons: o.jetons,
      t: o.t, simule: !!o.simule,
    })),
    journal: (c.journal || []).slice(0, 20),
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
async function arrete(joueur, versAdresse) {
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

/* ==================== CE QUE LA COLONIE DECLENCHE ====================
 *
 * Ces deux fonctions sont appelees depuis la boucle de la colonie. Elles ne
 * jettent JAMAIS : une erreur de miroir ne doit pas arreter la colonie, qui
 * n'a rien demande a personne. Chaque miroir est traite a son tour, avec une
 * pause — trente signatures dans le meme bloc, c'est la coupure assuree. */
async function surAchat(t) {
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

async function surVente(t) {
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
    note(c, 'Skipped ' + (t.sym || adr) + ': not enough ETH (RH) left once the gas reserve is kept');
    return false;
  }
  const p = await clePiscine(adr, t.pool);
  if (!p) throw new Error('no v4 pool found for this token');
  const zeroVersUn = p.zeroEstEth;                   /* ETH est currency0 ? alors on va de 0 vers 1 */
  const r = await achete(c, p.cle, zeroVersUn, mise);
  c.ouvertes[adr] = {
    sym: t.sym || null, pool: p.id, cle: p.cle, zeroVersUn,
    entree: ethers.utils.formatUnits(mise, 18),
    jetons: r.sortie.toString(), t: Date.now(), simule: r.simule, tx: r.tx || null,
  };
  /* Le journal dit la PART, et d'ou elle vient : sans ca, « 0,0031 ETH » ne
     laisse pas savoir si le miroir a suivi le Banquier ou son propre repli. */
  const dit = t.part
    ? (Math.round(t.part * 1000) / 10) + '% of what was free — the Banker\'s own share'
      + (t.score ? ' at score ' + t.score : '')
    : (Math.round(PART_ORDRE * 1000) / 10) + '% of what was free (fallback: no share from the colony)';
  note(c, (r.simule ? '[dry run] ' : '') + 'Bought ' + (t.sym || adr) + ' for '
        + ethers.utils.formatUnits(mise, 18) + ' ETH (RH) · ' + dit, { adr, tx: r.tx || null });
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
  const cleP = o.cle || (await clePiscine(adr, o.pool) || {}).cle;
  if (!cleP) throw new Error('pool key lost for this token');
  const r = await vend(c, cleP, !o.zeroVersUn, adr, montant);
  delete c.ouvertes[adr];
  note(c, (r.simule ? '[dry run] ' : '') + 'Sold ' + (o.sym || adr) + ' for '
        + ethers.utils.formatUnits(r.sortie, 18) + ' ETH (RH)', { adr, tx: r.tx || null });
  return r;
}

module.exports = {
  /* l'interface du serveur */
  charge, sauve, pret, cree, revele, etat, demarre, arrete, surAchat, surVente,
  /* les reglages, pour l'ecran et pour les essais */
  EXECUTE, MIROIRS_MAX, MIN_ETH, MAX_ETH, PART_ORDRE, ORDRE_MAX_ETH, GAZ_RESERVE,
  TOLERANCE_BPS, FICHIER,
  /* les adresses du protocole */
  PM4, QUOTEUR4, ROUTEUR4, PERMIT2, ETH4, SUJET_INIT,
  /* exposes pour les essais : ce sont eux qui portent les regles */
  _chiffre: chiffre, _dechiffre: dechiffre, _cleMaitresse: cleMaitresse,
  _idV4: idV4, _clePiscine: clePiscine, _devis: devis, _corpsV4: corpsV4,
  _plancher: plancher, _miseDe: miseDe, _balaie: balaie,
  _etat: () => R, _pose: (x) => { R = x; }, _poseProvider: poseProvider,
  _fiche: fiche, _actifs: actifs,
};
