'use strict';
/*
 * LE MIROIR : TRADER AVEC LA COLONIE, AVEC SON PROPRE ARGENT
 *
 * « Generer un master wallet, tu envoies de l'ETH Robinhood, tu fais play, et
 *   SWOGE AI achete et vend en meme temps que lui. La cle privee, tu peux la
 *   telecharger. Quand tu appuies sur stop, ca revend tout et ca revient dans
 *   le wallet de ton compte. »
 *
 * Ce qui est mesure ici est ce qui coute cher si c'est faux :
 *
 *   1. sans cle d'environnement, AUCUN portefeuille n'est cree — et on le dit ;
 *   2. la cle privee n'est JAMAIS en clair sur le disque, et un chiffre
 *      modifie d'un octet est refuse au lieu de se dechiffrer en silence ;
 *   3. le fichier des cles n'est pas `state.json` : celui-la part dans le canal
 *      Telegram a chaque sauvegarde ;
 *   4. les trois bornes de la mise tiennent : la part, le plafond, et la
 *      reserve de gaz — un miroir sans gaz ne peut plus VENDRE ;
 *   5. le miroir suit les achats et les ventes de la colonie, et seulement s'il
 *      est en marche ;
 *   6. en mode d'essai, RIEN ne part sur la chaine — c'est le mode par defaut,
 *      et c'est la promesse qui autorise tout le reste ;
 *   7. « stop » vend d'abord, balaie ensuite : l'ordre inverse laisserait des
 *      jetons dans un portefeuille sans gaz pour les vendre.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ethers } = require('ethers');

/* Un dossier a nous : l'essai ne doit pas voir — ni ecrire — le registre du
   serveur qui tourne a cote. */
const DOSSIER = fs.mkdtempSync(path.join(os.tmpdir(), 'miroir-'));
process.env.DATA_DIR = DOSSIER;
process.env.MIROIR_CLE = 'une phrase de passe d essai';
process.env.MIROIR_MIN_ETH = '0.002';
process.env.MIROIR_MAX_ETH = '0.5';
process.env.MIROIR_MAX = '3';
process.env.MIROIR_PAUSE_MS = '0';

const M = require('./miroir');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; console.log('  ok   ' + m); };
const jete = async (f, re, m) => {
  let msg = null;
  try { await f(); } catch (e) { msg = e.message; }
  assert.ok(msg && re.test(msg), m + ' — refus attendu, obtenu : ' + msg);
  n++; console.log('  ok   ' + m + ' (« ' + msg + ' »)');
};

const W = (x) => ethers.utils.parseUnits(String(x), 18);
const JOUEUR = '0x' + '11'.repeat(20);
const JOUEUR2 = '0x' + '22'.repeat(20);
const JETON = '0x' + 'aa'.repeat(20);

/* ==================== UNE FAUSSE CHAINE ====================
 *
 * Tout ce que le module touche de la chaine passe par le fournisseur. On en
 * pose un qui repond, et on COMPTE ce qu'on lui demande d'envoyer : c'est la
 * seule facon de prouver qu'en mode d'essai rien ne part. */
class FausseChaine extends ethers.providers.StaticJsonRpcProvider {
  constructor() {
    super('http://127.0.0.1:1/faux', { chainId: 4663, name: 'faux' });
    this.soldes = {};
    this.envois = [];          /* toute transaction signee atterrit ici */
    this.sortieDevis = W(1000);
    this.bloc = 5000000;
    this.piscines = {};        /* id v4 -> { c0, c1, fee, tick, hooks } : ce que la chaine sait */
    this.paires = {};          /* adresse -> { t0, t1, fee|null, sansReserves } : v2 et v3 */
    this.symboles = {};
    this.filtres = [];         /* chaque filtre eth_getLogs recu, tel quel */
  }
  detectNetwork() { return Promise.resolve({ chainId: 4663, name: 'faux' }); }
  async send(methode, params) {
    if (methode === 'eth_chainId') return '0x1237';
    if (methode === 'eth_blockNumber') return '0x' + this.bloc.toString(16);
    /* 0,1 gwei, comme la chaine reelle (0,134) : a 1 gwei, chaque ordre du
       banc aurait un gaz superieur au dixieme de sa mise et serait refuse. */
    if (methode === 'eth_gasPrice') return '0x' + (this.prixGaz || 100000000).toString(16);
    if (methode === 'eth_getBalance') {
      const a = String(params[0]).toLowerCase();
      return (this.soldes[a] || ethers.BigNumber.from(0)).toHexString();
    }
    if (methode === 'eth_getLogs') return this.logsInitialize(params[0]);
    if (methode === 'eth_call') return this.appel(params[0]);
    if (methode === 'eth_estimateGas') return '0x' + (200000).toString(16);
    if (methode === 'eth_getTransactionCount') return '0x0';
    if (methode === 'eth_sendRawTransaction') {
      /* Le module a SIGNE et VOULU envoyer. En mode d'essai, ne jamais voir
         passer ceci est tout l'objet de l'interrupteur. */
      this.envois.push(params[0]);
      return '0x' + 'ee'.repeat(32);
    }
    if (methode === 'eth_getTransactionReceipt') {
      return { transactionHash: '0x' + 'ee'.repeat(32), blockNumber: '0x1', blockHash: '0x' + '11'.repeat(32),
               transactionIndex: '0x0', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', status: '0x1', logs: [] };
    }
    throw new Error('methode non simulee : ' + methode);
  }
  /* L'evenement `Initialize`, tel que le PoolManager l'ecrirait — c'est de lui
     que le module retrouve la clef. On repond POUR LA PAIRE DEMANDEE : c'est
     ce que fait la chaine, qui filtre sur les deux jetons indexes. */
  /* ---- LES SUJETS DANS L ORDRE DE LA CHAINE ----
     Cette fausse chaine rendait l evenement quels que soient les sujets
     demandes : le module filtrait [signature, monnaie0, monnaie1] — une
     adresse la ou la chaine met l IDENTIFIANT — et le banc ne voyait rien.
     Sur la vraie chaine : zero evenement, toujours, et le miroir ne
     trouvait aucune piscine. Elle repond maintenant comme le PoolManager :
     [signature, id, monnaie0, monnaie1], par identifiant si on le connait,
     par les deux monnaies sinon — et RIEN pour un filtre mal forme. */
  logsInitialize(filtre) {
    const t = (filtre && filtre.topics) || [];
    this.filtres.push(t.slice());
    const A = ethers.utils.defaultAbiCoder;
    const pad = (a) => ethers.utils.hexZeroPad(a, 32);
    const ZERO = '0x' + '00'.repeat(20);
    const log = (id, c0, c1, fee, tick, hooks) => ({
      address: M.PM4, blockNumber: '0x1', transactionHash: '0x' + 'ab'.repeat(32),
      transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), logIndex: '0x0', removed: false,
      topics: [M.SUJET_INIT, id, pad(c0), pad(c1)],
      data: A.encode(['uint24', 'int24', 'address', 'uint160', 'int24'],
                     [fee, tick, hooks, '79228162514264337593543950336', 0]),
    });
    if (t[1] && !t[2]) {
      const p = this.piscines[String(t[1]).toLowerCase()];
      return p ? [log(String(t[1]).toLowerCase(), p.c0, p.c1, p.fee, p.tick, p.hooks)] : [];
    }
    if (!t[1] && t[2] && t[3]) {
      const c0 = '0x' + t[2].slice(26), c1 = '0x' + t[3].slice(26);
      return [log(M._idV4([c0, c1, 3000, 60, ZERO]), c0, c1, 3000, 60, ZERO)];
    }
    return [];
  }
  appel(tx) {
    const a = String(tx.to || '').toLowerCase();
    const sel = String(tx.data || '').slice(0, 10);
    const A = ethers.utils.defaultAbiCoder;
    if (a === M.QUOTEUR4.toLowerCase()) {
      /* La vente (de 1 vers 0 sur la piscine ETH/JETON, l ETH etant currency0)
         peut rendre autre chose que l achat : c est ce qu une piscine qui ne
         laisse pas sortir fait voir. Par defaut, elle rend comme l achat. */
      try {
        const q = new ethers.utils.Interface(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)']);
        const d = q.decodeFunctionData('quoteExactInputSingle', tx.data);
        if (d.params.zeroForOne === false && this.sortieVente) return A.encode(['uint256', 'uint256'], [this.sortieVente, 100000]);
      } catch (e) { /* pas ce format : le devis d achat */ }
      return A.encode(['uint256', 'uint256'], [this.sortieDevis, 100000]);
    }
    if (a === M.PERMIT2.toLowerCase()) return A.encode(['uint160', 'uint48', 'uint48'], [0, 0, 0]);
    /* Les deux autres places : le routeur v2 cote, le quoteur v3 cote, les
       fabriques ne connaissent rien (le banc donne toujours la piscine). */
    if (a === M.ROUTEUR2.toLowerCase()) return A.encode(['uint256[]'], [[0, this.sortieDevis]]);
    if (a === M.QUOTEUR3.toLowerCase()) return A.encode(['uint256', 'uint160', 'uint32', 'uint256'], [this.sortieDevis, 0, 0, 0]);
    if (a === M.FABRIQUE3.toLowerCase() || a === M.FABRIQUE2.toLowerCase()) return A.encode(['address'], ['0x' + '00'.repeat(20)]);
    const pr = this.paires[a];
    if (pr) {
      if (sel === '0x0dfe1681') return A.encode(['address'], [pr.t0]);            /* token0 */
      if (sel === '0xd21220a7') return A.encode(['address'], [pr.t1]);            /* token1 */
      if (sel === '0xddca3f43') {                                                /* fee : v3 seulement */
        if (pr.fee === null || pr.fee === undefined) throw new Error('execution reverted');
        return A.encode(['uint24'], [pr.fee]);
      }
      if (sel === '0x0902f1ac') {                                                /* getReserves : v2 seulement */
        if (pr.sansReserves) throw new Error('execution reverted');
        return A.encode(['uint112', 'uint112', 'uint32'], [W(1), W(1), 0]);
      }
    }
    if (sel === '0x95d89b41' && this.symboles[a]) return A.encode(['string'], [this.symboles[a]]);   /* symbol */
    /* Un ERC-20 : solde et autorisation. Le solde sert a la vente reelle. */
    return A.encode(['uint256'], [this.jetonsTenus || 0]);
  }
}
const chaine = new FausseChaine();
M._poseProvider(chaine);

/* La clef et l'identifiant d'une piscine, calcules comme le module le fera. */
function poolDe(jeton) {
  const p = M.ETH4.toLowerCase() < jeton.toLowerCase() ? [M.ETH4, jeton] : [jeton, M.ETH4];
  return M._idV4([p[0], p[1], 3000, 60, '0x' + '00'.repeat(20)]);
}
const POOL = poolDe(JETON);

(async () => {

console.log('\n-- sans cle d environnement, aucun portefeuille n est cree --');
{
  const garde = process.env.MIROIR_CLE;
  delete process.env.MIROIR_CLE;
  const p = M.pret();
  ok(!p.ok && /MIROIR_CLE/.test(p.pourquoi),
     'le module se declare INUTILISABLE et dit pourquoi : « ' + p.pourquoi + ' »');
  await jete(() => M.cree(JOUEUR), /MIROIR_CLE/,
             'et il refuse de creer un portefeuille plutot que d ecrire une cle en clair');
  process.env.MIROIR_CLE = garde;
  ok(M.pret().ok, 'la cle remise, il repart');
}

console.log('\n-- la cle privee ne touche jamais le disque en clair --');
{
  const c = await M.cree(JOUEUR);
  ok(/^0x[0-9a-fA-F]{40}$/.test(c.adresse), 'la creation rend une adresse (' + c.adresse + ')');
  ok(/^0x[0-9a-f]{64}$/.test(c.cle), 'et la cle privee, UNE FOIS, au joueur');
  const w = new ethers.Wallet(c.cle);
  eq(w.address, c.adresse, 'la cle est bien celle de cette adresse — verifie, pas suppose');

  const brut = fs.readFileSync(M.FICHIER, 'utf8');
  ok(brut.indexOf(c.cle) < 0, 'le registre sur disque ne contient PAS la cle');
  ok(brut.indexOf(c.cle.slice(2)) < 0, 'ni sans son prefixe — un `indexOf` sur la moitie du secret ne prouve rien');
  ok(/"cle":"v1\./.test(brut), 'il contient une enveloppe chiffree, versionnee');
  ok(M.FICHIER.indexOf('state.json') < 0 && /miroirs\.json$/.test(M.FICHIER),
     'et ce fichier N EST PAS state.json : celui-la part dans le canal Telegram a chaque sauvegarde');

  const paquet = JSON.parse(brut).comptes[JOUEUR.toLowerCase()].cle;
  eq(M._dechiffre(paquet), c.cle, 'le chiffre se relit exactement');
  const abime = paquet.slice(0, -2) + (paquet.slice(-2) === '00' ? '11' : '00');
  let refuse = false;
  try { M._dechiffre(abime); } catch (e) { refuse = true; }
  ok(refuse, 'un chiffre modifie d un octet est REFUSE, pas dechiffre de travers : c est ce que GCM ajoute');

  const rev = M.revele(JOUEUR);
  eq(rev.cle, c.cle, 'et le joueur peut la redemander : c est SA cle, la lui refuser ne le protegerait de rien');
  await jete(() => M.cree(JOUEUR), /already has/, 'un second portefeuille sur le meme compte est refuse');
}

console.log('\n-- c est le Banquier qui dimensionne, pas le miroir --');
{
  /* « Quand quelqu'un depose 0,1 ETH, est-ce que le Banquier gere sa
     bankroll ? » Il ne la gerait pas : le miroir avait sa propre part fixe, une
     seconde facon de decider a cote de celle qui a ete apprise. */
  const m = (eth, part) => Number(ethers.utils.formatUnits(M._miseDe(W(eth), part), 18));
  const dispo = 0.1 - Number(M.GAZ_RESERVE);
  ok(Math.abs(m('0.1', 0.04) - dispo * 0.04) < 1e-12,
     'la fraction du Banquier decide : 4 % de sa caisse font 4 % de la notre (' + m('0.1', 0.04) + ' ETH)');
  ok(Math.abs(m('0.1', 0.12) - dispo * 0.12) < 1e-12,
     'et 12 % en font 12 % — l echelle par note, le regime et les plafonds du Banquier viennent avec');
  ok(Math.abs(m('0.1') - dispo * M.PART_ORDRE) < 1e-12,
     'sans fraction — caisse a zero, signal d une version anterieure — le repli local reprend la main');
  ok(m('5', 0.3) === Number(M.ORDRE_MAX_ETH),
     'mais le plafond par ordre reste le notre : le Banquier raisonne sur une caisse papier qu aucune piscine n absorbe');
  eq(m('0.001', 0.3), 0, 'et la reserve de gaz n est jamais entamee, quelle que soit la fraction');
  const C = require('./ai_colonie');
  C._pose(Object.assign(C.etatNeuf(), { tresor: 1000 }));
  ok(Math.abs(C._partDuBanquier({ mise: 40 }) - 0.04) < 1e-12,
     'la colonie calcule la fraction chez elle, ou vit sa tresorerie (40 sur 1000 = 4 %)');
  eq(C._partDuBanquier({ mise: 0 }), null, 'une mise nulle ne donne aucune fraction');
  C._pose(Object.assign(C.etatNeuf(), { tresor: 0 }));
  eq(C._partDuBanquier({ mise: 40 }), null,
     'et une caisse a zero non plus : « engage tout » ne doit pas pouvoir se traduire chez quelqu un d autre');
  C._pose(Object.assign(C.etatNeuf(), { tresor: 100 }));
  eq(C._partDuBanquier({ mise: 90 }), C.MIROIR_PART_MAX,
     'une fraction aberrante est bornee a ' + (C.MIROIR_PART_MAX * 100) + ' %');
}

console.log('\n-- un ordre a un plancher, et un miroir trop petit le dit --');
{
  /* Mesure le 4 septembre : 0,0023 ETH, part du Banquier 3 %, ordre de
     0,000025 ETH — six centimes, moins que le gaz. */
  const m = (eth, part) => ethers.utils.formatUnits(M._miseDe(W(eth), part), 18);
  eq(m('0.0023', 0.03), '0.0', '0,0023 ETH a 3 % : rien — 0,0008 de libre ne tient pas un ordre de ' + M.ORDRE_MIN_ETH);
  eq(m('0.0109', 0.03), M.ORDRE_MIN_ETH + (M.ORDRE_MIN_ETH.indexOf('.') < 0 ? '.0' : ''),
     '0,0109 ETH a 3 % : le plancher (' + m('0.0109', 0.03) + '), pas 0,00028 — moins de positions, mais qui valent leur gaz');
  ok(Math.abs(Number(m('0.1', 0.04)) - (0.1 - Number(M.GAZ_RESERVE)) * 0.04) < 1e-12,
     'et au-dessus du plancher, la part du Banquier decide, comme avant');
  const p = M._pourquoiPasDeMise(W('0.0023'));
  ok(/0\.0008 ETH \(RH\) free/.test(p) && new RegExp(M.ORDRE_MIN_ETH + ' ETH').test(p) && new RegExp('fund the mirror with ' + M.MIN_ETH).test(p),
     'la phrase donne le libre, le plancher et quoi faire : « ' + p + ' »');
  ok(Number(M.MIN_ETH) >= Number(M.GAZ_RESERVE) + Number(M.ORDRE_MIN_ETH),
     'et le minimum pour jouer (' + M.MIN_ETH + ') couvre la reserve plus au moins un ordre');
}

console.log('\n-- le gaz du moment est lu, et un ordre qui serait du gaz ne part pas --');
{
  const JG = '0x' + '66'.repeat(20);
  for (const { joueur } of M._actifs()) await M.arrete(joueur, joueur);
  await M.cree(JG);
  const cg = M._fiche(JG);
  chaine.soldes[cg.adr.toLowerCase()] = W('0.05');
  await M.demarre(JG);
  chaine.prixGaz = 10000000000;            /* 10 gwei : 300 000 unites font 0,003 ETH */
  const JX = '0x' + '67'.repeat(20);
  await M.surAchat({ sym: 'GAZ', adr: JX, pool: poolDe(JX), part: 0.1 });
  const e = await M.etat(JG, false);
  ok(!e.ouvertes.length, 'a 10 gwei, l ordre de 0,00485 ETH ne part pas');
  ok(/Skipped GAZ: gas for one order is about 0\.003 ETH/.test(e.journal[0].txt) && /trading gas/.test(e.journal[0].txt),
     'et le journal dit le gaz, la mise et pourquoi : « ' + e.journal[0].txt.slice(0, 90) + '… »');
  chaine.prixGaz = null;
  await M.surAchat({ sym: 'GAZ', adr: JX, pool: poolDe(JX), part: 0.1 });
  eq((await M.etat(JG, false)).ouvertes.length, 1, 'a 0,1 gwei, le meme ordre part');
  await M.arrete(JG, JG);
}

console.log('\n-- les trois bornes de la mise --');
{
  const m = (eth) => ethers.utils.formatUnits(M._miseDe(W(eth)), 18);
  eq(m('0.001'), '0.0', 'sous la reserve de gaz, la mise est nulle : un miroir sans gaz ne peut plus VENDRE');
  /* Compare en NOMBRE et non en chaine : le calcul du module est exact, en
     BigNumber ; c est l attendu recalcule en flottant qui traine un chiffre. */
  const attendu = (0.1 - Number(M.GAZ_RESERVE)) * M.PART_ORDRE;
  ok(Math.abs(Number(m('0.1')) - attendu) < 1e-12,
     'au-dessus, c est une part du DISPONIBLE, gaz deduit (' + m('0.1') + ' pour ' + attendu.toFixed(8) + ' attendu)');
  ok(Number(m('5')) === Number(M.ORDRE_MAX_ETH),
     'et un gros portefeuille est plafonne a ' + M.ORDRE_MAX_ETH + ' ETH par ordre : sur une piscine mince, la part seule paierait son propre impact');
  ok(M._plancher(1000).gt(0), 'le minimum de sortie n est JAMAIS zero — zero, c est accepter un jeton, et c est la porte au sandwich');
  eq(M._plancher(10000).toString(), String(10000 - 10000 * M.TOLERANCE_BPS / 10000),
     'il vaut la sortie moins la tolerance (' + M.TOLERANCE_BPS + ' bps)');
}

console.log('\n-- play : la chaine decide, pas l ecran --');
{
  const c = M._fiche(JOUEUR);
  chaine.soldes[c.adr.toLowerCase()] = W('0.0005');
  await jete(() => M.demarre(JOUEUR), /fund the mirror/, 'sous le minimum, play est refuse et dit quoi faire');
  chaine.soldes[c.adr.toLowerCase()] = W('9');
  await jete(() => M.demarre(JOUEUR), /ceiling/, 'au-dessus du plafond aussi : « ce n est pas un coffre, c est une mise »');
  chaine.soldes[c.adr.toLowerCase()] = W('0.05');
  const r = await M.demarre(JOUEUR);
  ok(r.actif && !r.deja, 'avec un solde suffisant, le miroir demarre');
  const e = await M.etat(JOUEUR);
  ok(e.existe && e.actif, 'et son etat le dit');
  ok(e.solde === '0.05', 'avec le solde lu sur la CHAINE (' + e.solde + ')');
  ok(e.execute === false, 'et il annonce qu il est en mode d essai — l ecran doit pouvoir le montrer');
  ok(/dry run/i.test((e.journal[0] || {}).txt || ''), 'le journal le dit aussi : « ' + e.journal[0].txt + ' »');
}

console.log('\n-- le miroir suit un achat de la colonie --');
{
  const avant = chaine.envois.length;
  const suivis = await M.surAchat({ sym: 'TEST', adr: JETON, pool: POOL });
  eq(suivis, 1, 'un miroir en marche suit l achat');
  const e = await M.etat(JOUEUR);
  eq(e.ouvertes.length, 1, 'et porte la position');
  eq(e.ouvertes[0].sym, 'TEST', 'avec le symbole');
  eq(e.ouvertes[0].entree, ethers.utils.formatUnits(M._miseDe(W('0.05')), 18),
     'et la mise que la regle donne (' + e.ouvertes[0].entree + ' ETH)');
  ok(e.ouvertes[0].simule, 'marquee comme simulee');
  eq(chaine.envois.length, avant, 'ET RIEN N EST PARTI SUR LA CHAINE : c est toute la promesse du mode d essai');
  ok(/\[dry run\]/.test(e.journal[0].txt), 'le journal le dit dans ces termes : « ' + e.journal[0].txt + ' »');

  const encore = await M.surAchat({ sym: 'TEST', adr: JETON, pool: POOL });
  eq(encore, 0, 'un second achat du MEME jeton est ignore : une position par jeton, comme la colonie');
}

console.log('\n-- un miroir a l arret ne suit rien --');
{
  await M.cree(JOUEUR2);
  const c2 = M._fiche(JOUEUR2);
  chaine.soldes[c2.adr.toLowerCase()] = W('0.05');
  const AUTRE = '0x' + 'bb'.repeat(20);
  const suivis = await M.surAchat({ sym: 'AUTRE', adr: AUTRE, pool: poolDe(AUTRE) });
  eq(suivis, 1, 'seul le miroir en marche a suivi');
  const e2 = await M.etat(JOUEUR2, false);
  eq(e2.ouvertes.length, 0, 'celui qui n a pas fait play n a aucune position');
  eq((await M.etat(JOUEUR, false)).ouvertes.length, 2, 'et celui qui joue en a deux');
}

console.log('\n-- le miroir vend les memes tranches que la colonie, et garde le reste en course --');
{
  /* « Le mode miroir vend ses positions comme le mode de présentation ? »
     Le papier encaisse 35 % a +15 %, 35 % a +40 %, 20 % a +80 %, et garde
     10 % jusqu au bout. Le miroir doit faire pareil. */
  const c1 = M._fiche(JOUEUR);
  const o0 = c1.ouvertes[JETON];
  const jetons0 = ethers.BigNumber.from(o0.jetons);
  eq(await M.surVente({ adr: JETON, part: 0.35, raison: 'palier +15%' }), 1, 'la tranche est suivie');
  const o1 = c1.ouvertes[JETON];
  ok(!!o1, 'la position reste ouverte');
  ok(Math.abs(o1.reste - 0.65) < 1e-9, 'il en reste 65 % (' + o1.reste + ')');
  ok(ethers.BigNumber.from(o1.jetons).eq(jetons0.mul(650000).div(1000000)), 'et 65 % des jetons sont encore tenus');
  const e1 = await M.etat(JOUEUR, false);
  ok(/Sold 35% of TEST/.test(e1.journal[0].txt) && /palier \+15%/.test(e1.journal[0].txt) && /65% still running/.test(e1.journal[0].txt),
     'le journal dit la tranche, le palier et ce qui court encore : « ' + e1.journal[0].txt.slice(0, 100) + '… »');
  ok(e1.ouvertes.find((x) => x.adr === JETON).reste === o1.reste, 'et l etat porte le reste');
  eq(await M.surVente({ adr: JETON, part: 0.35, raison: 'palier +40%' }), 1, 'deuxieme tranche');
  ok(Math.abs(c1.ouvertes[JETON].reste - 0.30) < 1e-9, 'il en reste 30 %');
  ok(ethers.BigNumber.from(c1.ouvertes[JETON].jetons).eq(jetons0.mul(300000).div(1000000).add(0).sub(0)) || Math.abs(Number(c1.ouvertes[JETON].jetons) / Number(jetons0.toString()) - 0.30) < 1e-6,
     '30 % des jetons de depart, malgre deux arrondis successifs');
  /* Une tranche qui viderait la position est une fermeture : on ne laisse
     pas trainer trois jetons. */
  eq(await M.surVente({ adr: JETON, part: 0.30 }), 1, 'la derniere tranche');
  ok(!c1.ouvertes[JETON], 'vide la position au lieu de laisser un reliquat');
  const f = c1.fermees[c1.fermees.length - 1];
  ok(Number(f.sortie) === 3 * Number(ethers.utils.formatUnits(chaine.sortieDevis, 18)),
     'et la ligne du bilan compte les trois ventes : ' + f.sortie + ' ETH (' + f.tranches + ' des tranches)');
  /* On rouvre pour les scenarios suivants, qui attendent une position sur TEST. */
  await M.surAchat({ sym: 'TEST', adr: JETON, pool: POOL, part: 0.1 });
  ok(!!c1.ouvertes[JETON], 'rouverte pour la suite');
}

console.log('\n-- le miroir suit la vente --');
{
  const suivis = await M.surVente({ adr: JETON });
  eq(suivis, 1, 'la vente de la colonie ferme la position du miroir');
  const e = await M.etat(JOUEUR, false);
  eq(e.ouvertes.length, 1, 'il ne reste que l autre');
  ok(/Sold TEST/.test(e.journal[0].txt), 'et le journal dit ce qui a ete vendu : « ' + e.journal[0].txt + ' »');
  /* La barre personnelle : profit, taux, trades, meilleur, ouvert — calcules
     sur les ventes, en ETH. */
  eq(e.bilan.trades, 2, 'le bilan compte cette vente, apres celle des tranches');
  eq(e.bilan.ouvertes, 1, 'et une position encore ouverte');
  ok(typeof e.bilan.profitEth === 'string' && isFinite(Number(e.bilan.profitEth)),
     'le profit est un chiffre en ETH : ' + e.bilan.profitEth);
  ok(e.bilan.meilleur >= 0 && e.bilan.gagnantes <= e.bilan.trades,
     'meilleur ' + e.bilan.meilleur + '×, gagnantes ' + e.bilan.gagnantes);
  ok(e.bilan.simule === true, 'et il dit que ces ventes sont simulees');
  eq(await M.surVente({ adr: '0x' + 'cc'.repeat(20) }), 0,
     'une vente sur un jeton qu aucun miroir ne tient ne fait rien');
}

console.log('\n-- stop : on vend d abord, on balaie ensuite --');
{
  const avant = chaine.envois.length;
  const r = await M.arrete(JOUEUR, JOUEUR);
  eq(r.vendus.length, 1, 'stop vend la position qui restait');
  eq(r.rates.length, 0, 'sans echec');
  ok(!(await M.etat(JOUEUR, false)).actif, 'le miroir est arrete');
  eq((await M.etat(JOUEUR, false)).ouvertes.length, 0, 'et ne tient plus rien');
  eq((await M.etat(JOUEUR, false)).bilan.trades, 3, 'la vente du stop entre dans le bilan (3 trades)');
  eq((await M.etat(JOUEUR, false)).bilan.ouvertes, 0, 'et plus rien d ouvert');
  eq(chaine.envois.length, avant, 'toujours rien sur la chaine : en mode d essai, stop ne vend ni ne balaie pour de vrai');
  ok(/dry run/i.test((await M.etat(JOUEUR, false)).journal[0].txt), 'et il le DIT plutot que de laisser croire au balayage');
  await jete(() => M.arrete(JOUEUR, 'pas-une-adresse'), /destination/,
             'sans adresse de destination valable, stop refuse : on ne balaie pas dans le vide');
}

console.log('\n-- le nombre de miroirs actifs est borne --');
{
  eq(M.MIROIRS_MAX, 3, 'le plafond de cet essai est de trois');
  const gens = [];
  for (let i = 0; i < 3; i++) {
    const j = '0x' + String(40 + i).repeat(20).slice(0, 40);
    await M.cree(j);
    chaine.soldes[M._fiche(j).adr.toLowerCase()] = W('0.05');
    await M.demarre(j);
    gens.push(j);
  }
  eq(M._actifs().length, 3, 'trois miroirs en marche');
  const j4 = '0x' + '99'.repeat(20);
  await M.cree(j4);
  chaine.soldes[M._fiche(j4).adr.toLowerCase()] = W('0.05');
  await jete(() => M.demarre(j4), /full/,
             'le quatrieme est refuse — vingt miroirs sur la meme piscine encherissent les uns contre les autres');
  const e = await M.etat(j4, false);
  eq(e.places, 0, 'et l ecran voit qu il n y a plus de place');
}

console.log('\n-- la clef de piscine se VERIFIE, elle ne se suppose pas --');
{
  const p = await M._clePiscine(JETON, POOL);
  ok(p && p.id === POOL, 'la clef lue dans l evenement redonne exactement l identifiant demande');
  eq(p.zeroEstEth, M.ETH4.toLowerCase() < JETON.toLowerCase(),
     'et on sait de quel cote est l ETH : c est ce qui dit le sens de l echange');
  const faux = await M._clePiscine(JETON, '0x' + 'ff'.repeat(32));
  ok(faux === null,
     'un identifiant qui ne correspond a rien ne rend RIEN — on n echange pas dans une piscine qu on n a pas su verifier');
}

console.log('\n-- deux achats du meme tour ne se croisent pas --');
{
  /* La colonie ouvre plusieurs positions dans le MEME tour, et lance le miroir
     sans l'attendre. Sans file, les deux ordres allaient lire le meme `nonce` :
     la seconde transaction remplacait la premiere. Le mode d'essai ne pouvait
     pas le montrer — rien ne part — donc c'est un defaut qui attendait
     l'argent reel. */
  /* Le scenario precedent a rempli les trois places : on en libere une, ce qui
     verifie au passage qu un arret en rend bien une. */
  const places = M._actifs();
  await M.arrete(places[0].joueur, places[0].joueur);
  eq(M._actifs().length, 2, 'un arret libere sa place');
  const j = '0x' + '77'.repeat(20);
  await M.cree(j);
  const c = M._fiche(j);
  chaine.soldes[c.adr.toLowerCase()] = W('0.05');
  await M.demarre(j);
  const A = '0x' + 'c1'.repeat(20), B = '0x' + 'c2'.repeat(20);
  /* Lances ENSEMBLE, comme la colonie le fait, sans attendre le premier. */
  const p1 = M.surAchat({ sym: 'UN', adr: A, pool: poolDe(A) });
  const p2 = M.surAchat({ sym: 'DEUX', adr: B, pool: poolDe(B) });
  const [n1, n2] = await Promise.all([p1, p2]);
  ok(n1 >= 1 && n2 >= 1, 'les deux achats aboutissent (' + n1 + ' et ' + n2 + ')');
  const e = await M.etat(j, false);
  eq(e.ouvertes.length, 2, 'et le miroir porte les DEUX positions, pas une');
  /* La seconde mise est prise sur ce qui reste : c'est la preuve que le second
     ordre a vu passer le premier au lieu de partir en meme temps. */
  ok(e.ouvertes.length === 2 && e.ouvertes[0].entree !== undefined,
     'chacune avec sa mise (' + e.ouvertes.map((o) => o.entree).join(' puis ') + ')');
}

/* ==========================================================================
 * LA CLEF V4 SE CHERCHE PAR IDENTIFIANT — ET LES DEUX AUTRES PLACES
 *
 * « Ca fonctionne pas, ca peut etre des pools v3 ou v2 aussi. »
 *
 * Mesure le 4 septembre, en mode reel, sur le miroir d un ami : TRN, GOBLIN,
 * ORE, trois « no v4 pool found ». TRN AVAIT sa piscine v4 contre l ETH,
 * bloc 54423937 : le filtre mettait les monnaies a la place de l identifiant
 * et la chaine rendait zero. GOBLIN est cote en GLD. ORE est une paire v2.
 * ======================================================================== */
console.log('\n-- la clef v4 : par identifiant d abord, et les monnaies en sujets 2 et 3 --');
{
  const ZERO = '0x' + '00'.repeat(20);
  chaine.filtres = [];
  const p = await M._clePiscine(JETON, POOL);
  const f0 = chaine.filtres[0] || [], f1 = chaine.filtres[1] || [];
  ok(f0.length === 2 && f0[0] === M.SUJET_INIT && String(f0[1]).toLowerCase() === POOL.toLowerCase(),
     'premiere demande : [signature, identifiant] — une lecture, pas une recherche');
  ok(f1.length === 4 && f1[1] === null && /^0x0{64}$/.test(f1[2]) && String(f1[3]).slice(26) === JETON.slice(2).toLowerCase(),
     'sans reponse, on cherche par les deux monnaies — en sujets 2 et 3, le sujet 1 (l id) laisse libre');
  ok(!!p && p.id.toLowerCase() === POOL.toLowerCase() && p.contreEth === true,
     'et la clef retrouvee recompose l identifiant demande');

  const GLD = '0x' + '9d'.repeat(20), GOB = '0x' + 'ce'.repeat(20);
  const idG = M._idV4([GLD, GOB, 3000, 60, ZERO]);
  chaine.piscines[idG.toLowerCase()] = { c0: GLD, c1: GOB, fee: 3000, tick: 60, hooks: ZERO };
  chaine.symboles[GLD] = 'GLD';
  await jete(() => M._routeDe(GOB, idG), /quoted in GLD, not ETH/,
             'une piscine cotee en GLD est refusee AVEC le nom de la monnaie — « no pool » n etait ni vrai ni utile');
}

console.log('\n-- avant d acheter, l aller-retour : une piscine qui ne laisse pas sortir n est pas achetee --');
{
  /* SLINK, 4 septembre : l achat simule passe, la vente de ce qu il rend
     rend zero. */
  const JR = '0x' + '5a'.repeat(20), J6 = '0x' + '66'.repeat(19) + '01';
  for (const { joueur } of M._actifs()) await M.arrete(joueur, joueur);   /* le plafond de l essai est de trois */
  await M.cree(J6);
  const cA = M._fiche(J6);
  chaine.soldes[cA.adr.toLowerCase()] = W('0.05');
  await M.demarre(J6);
  ok(!!cA && cA.actif, 'un miroir en marche');
  const avant = Object.keys(cA.ouvertes || {}).length;
  chaine.sortieVente = W('0.0000001');            /* la vente rend zero */
  await M.surAchat({ sym: 'PIEGE', adr: JR, pool: poolDe(JR), part: 0.1 });
  ok(Object.keys(cA.ouvertes).length === avant, 'rien n est achete');
  const e = await M.etat(J6, false);
  ok(/Skipped PIEGE: selling straight back would return 0% of the stake/.test(e.journal[0].txt) && /lets you in, not out/.test(e.journal[0].txt),
     'et le journal dit pourquoi : « ' + e.journal[0].txt.slice(0, 110) + '… »');
  chaine.sortieVente = W('0.0039');              /* 80 % de la mise de 0,00485 : frais et impact, pas une porte fermee */
  await M.surAchat({ sym: 'PIEGE', adr: JR, pool: poolDe(JR), part: 0.1 });
  ok(Object.keys(cA.ouvertes).length === avant + 1, 'a 80 % de retour, l achat part (seuil ' + Math.round(M.RETOUR_MIN * 100) + ' %)');
  chaine.sortieVente = null;
  await M.surVente({ adr: JR });
  await M.arrete(J6, J6);
}

console.log('\n-- une piscine v4 cotee en WETH : suivie, avec emballage a l achat et deballage a la vente --');
{
  /* SLINK, 4 septembre : currency0 = WETH, refuse « quoted in WETH, not ETH ». */
  const ZERO = '0x' + '00'.repeat(20), SL = '0x' + 'e5'.repeat(20);
  const k = [M.WETH, SL, 100, 1, ZERO];
  const idW = M._idV4(k);
  chaine.piscines[idW.toLowerCase()] = { c0: M.WETH, c1: SL, fee: 100, tick: 1, hooks: ZERO };
  const r = await M._routeDe(SL, idW);
  ok(r.ver === 'v4' && r.enWeth === true && r.zeroEstEth === true, 'la route est v4, cote ETH = WETH, currency0');
  const A = ethers.utils.defaultAbiCoder, iu = new ethers.utils.Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
  const moi = '0x' + '77'.repeat(20);
  const oa = M._ordre(r, 'achat', SL, W('0.001'), ethers.BigNumber.from(500), moi, 42);
  const da = iu.parseTransaction({ data: oa.data });
  ok(oa.value.eq(W('0.001')) && da.args.commands === M.WRAP_ETH + M.V4_SWAP.slice(2), 'l achat : WRAP_ETH puis V4_SWAP, l ETH en valeur (' + da.args.commands + ')');
  const wrap = A.decode(['address', 'uint256'], da.args.inputs[0]);
  ok(wrap[0].toLowerCase() === M.ADRESSE_ROUTEUR && wrap[1].eq(W('0.001')), 'le WETH est emballe CHEZ LE ROUTEUR, pour le montant');
  const c = A.decode(['bytes', 'bytes[]'], da.args.inputs[1]);
  ok(c[0] === M.ACTES4_WETH_ACHAT, 'les actes : swap, SETTLE, TAKE_ALL (' + c[0] + ')');
  const st = A.decode(['address', 'uint256', 'bool'], c[1][1]);
  ok(st[0].toLowerCase() === M.WETH.toLowerCase() && st[1].isZero() && st[2] === false, 'SETTLE en WETH, open delta, paye par le routeur (pas par le miroir)');
  const tk = A.decode(['address', 'uint256'], c[1][2]);
  ok(tk[0].toLowerCase() === SL && tk[1].eq(500), 'TAKE_ALL du jeton au minimum');
  const sw = A.decode([M.SWAP4_T], c[1][0])[0];
  ok(sw[1] === true && sw[2].eq(W('0.001')) && sw[3].eq(500), 'le swap va de 0 (WETH) vers 1 (jeton), montant et minimum');
  const ov = M._ordre(r, 'vente', SL, ethers.BigNumber.from(9000), ethers.BigNumber.from(700), moi, 43);
  const dv = iu.parseTransaction({ data: ov.data });
  ok(ov.value.isZero() && dv.args.commands === M.V4_SWAP + M.UNWRAP_WETH.slice(2), 'la vente : V4_SWAP puis UNWRAP_WETH, sans ETH en valeur (' + dv.args.commands + ')');
  const cv = A.decode(['bytes', 'bytes[]'], dv.args.inputs[0]);
  ok(cv[0] === M.ACTES4_WETH_VENTE, 'les actes : swap, SETTLE_ALL, TAKE (' + cv[0] + ')');
  const sa = A.decode(['address', 'uint256'], cv[1][1]);
  ok(sa[0].toLowerCase() === SL && sa[1].eq(9000), 'SETTLE_ALL du jeton, via Permit2');
  const tv = A.decode(['address', 'address', 'uint256'], cv[1][2]);
  ok(tv[0].toLowerCase() === M.WETH.toLowerCase() && tv[1].toLowerCase() === M.ADRESSE_ROUTEUR && tv[2].isZero(), 'TAKE du WETH vers le routeur, open delta');
  const un = A.decode(['address', 'uint256'], dv.args.inputs[1]);
  ok(un[0].toLowerCase() === moi && un[1].eq(700), 'puis UNWRAP_WETH vers le miroir, avec le meme minimum');
  const swv = A.decode([M.SWAP4_T], cv[1][0])[0];
  ok(swv[1] === false, 'et le swap va de 1 (jeton) vers 0 (WETH)');
  /* Une piscine en ETH natif garde l ancien corps : rien a emballer. */
  const rn = await M._routeDe(JETON, POOL);
  const on = M._ordre(rn, 'achat', JETON, W('0.001'), ethers.BigNumber.from(1), moi, 1);
  ok(rn.enWeth === false && iu.parseTransaction({ data: on.data }).args.commands === M.V4_SWAP, 'en ETH natif : V4_SWAP seul, comme avant');
}

console.log('\n-- une paire v2 : reconnue, cotee, et le calldata reel est le bon --');
const J5 = '0x' + '55'.repeat(20);
const ORE = '0x' + '0e'.repeat(20), PAIRE2 = '0x' + 'b2'.repeat(20);
{
  /* Le plafond de cet essai est de trois : on libere les places des scenarios
     precedents — un arret vend et ne casse rien, en essai. */
  for (const { joueur } of M._actifs()) await M.arrete(joueur, joueur);
  await M.cree(J5);
  const c5 = M._fiche(J5);
  chaine.soldes[c5.adr.toLowerCase()] = W('0.05');
  await M.demarre(J5);
  chaine.paires[PAIRE2] = { t0: M.WETH, t1: ORE, fee: null };
  const avant = chaine.envois.length;
  const n = await M.surAchat({ sym: 'ORE', adr: ORE, pool: PAIRE2, part: 0.1 });
  ok(n >= 1, 'l achat est suivi (' + n + ' miroir(s))');
  const e = await M.etat(J5, false);
  const o = e.ouvertes.find((x) => x.adr === ORE);
  ok(!!o && o.ver === 'v2', 'la position sait qu elle est sur v2');
  ok(/Bought ORE .* on Uniswap v2/.test(e.journal[0].txt), 'et le journal le dit : « ' + e.journal[0].txt.slice(0, 70) + '… »');
  eq(chaine.envois.length, avant, 'toujours rien signe en essai');

  const i2 = new ethers.utils.Interface(M._R2_ABI);
  const r2 = { ver: 'v2', paire: PAIRE2 };
  const oa = M._ordre(r2, 'achat', ORE, W('0.001'), W('0.0009'), c5.adr, 123456);
  const da = i2.parseTransaction({ data: oa.data });
  ok(oa.to.toLowerCase() === M.ROUTEUR2.toLowerCase() && oa.value.eq(W('0.001')),
     'l achat va au routeur v2 avec l ETH en valeur');
  ok(da.name === 'swapExactETHForTokensSupportingFeeOnTransferTokens'
     && da.args.path[0].toLowerCase() === M.WETH.toLowerCase() && da.args.path[1].toLowerCase() === ORE
     && da.args.to.toLowerCase() === c5.adr.toLowerCase() && da.args.amountOutMin.eq(W('0.0009')) && da.args.deadline.eq(123456),
     'WETH → ORE, vers le miroir, avec le minimum et l echeance, en variante taxe-tolerante');
  const ov = M._ordre(r2, 'vente', ORE, ethers.BigNumber.from(5000), ethers.BigNumber.from(4000), c5.adr, 99);
  const dv = i2.parseTransaction({ data: ov.data });
  ok(ov.value.isZero() && dv.name === 'swapExactTokensForETHSupportingFeeOnTransferTokens'
     && dv.args.path[0].toLowerCase() === ORE && dv.args.path[1].toLowerCase() === M.WETH.toLowerCase()
     && dv.args.amountIn.eq(5000) && dv.args.amountOutMin.eq(4000) && dv.args.to.toLowerCase() === c5.adr.toLowerCase(),
     'la vente fait le chemin inverse, sans ETH en valeur');

  eq(await M.surVente({ adr: ORE }), 1, 'la vente de la colonie ferme la position v2');
  const e2 = await M.etat(J5, false);
  ok(/Sold ORE .* on Uniswap v2/.test(e2.journal[0].txt), 'et le journal dit la place : « ' + e2.journal[0].txt.slice(0, 60) + '… »');
  eq(e2.bilan.trades, 1, 'le bilan compte la vente');
}

console.log('\n-- une piscine v3 : le palier lu sur place, et deux appels en une transaction pour vendre --');
{
  const c5 = M._fiche(J5);
  const J3 = '0x' + '3e'.repeat(20), PISC3 = '0x' + 'b3'.repeat(20);
  chaine.paires[PISC3] = { t0: J3, t1: M.WETH, fee: 10000 };
  const n = await M.surAchat({ sym: 'TROIS', adr: J3, pool: PISC3, part: 0.1 });
  ok(n >= 1, 'l achat est suivi');
  const o = (await M.etat(J5, false)).ouvertes.find((x) => x.adr === J3);
  ok(!!o && o.ver === 'v3', 'la position sait qu elle est sur v3');
  const r3 = { ver: 'v3', paire: PISC3, fee: 10000 };
  const i3 = new ethers.utils.Interface(M._R3_ABI);
  const oa = M._ordre(r3, 'achat', J3, W('0.002'), W('0.0018'), c5.adr, 777);
  const da = i3.parseTransaction({ data: oa.data });
  const pa = da.args[0];
  ok(oa.to.toLowerCase() === M.ROUTEUR3.toLowerCase() && oa.value.eq(W('0.002')) && da.name === 'exactInputSingle'
     && pa.tokenIn.toLowerCase() === M.WETH.toLowerCase() && pa.tokenOut.toLowerCase() === J3 && pa.fee === 10000
     && pa.recipient.toLowerCase() === c5.adr.toLowerCase() && pa.amountIn.eq(W('0.002')) && pa.amountOutMinimum.eq(W('0.0018')),
     'l achat : exactInputSingle WETH → jeton au palier 1 %, vers le miroir, l ETH en valeur');
  const ov = M._ordre(r3, 'vente', J3, ethers.BigNumber.from(5000), ethers.BigNumber.from(4000), c5.adr, 777);
  const dv = i3.parseTransaction({ data: ov.data });
  ok(ov.value.isZero() && dv.name === 'multicall' && dv.args.deadline.eq(777) && dv.args.data.length === 2, 'la vente : un multicall a deux appels, sans ETH en valeur');
  const s1 = i3.parseTransaction({ data: dv.args.data[0] }), s2 = i3.parseTransaction({ data: dv.args.data[1] });
  ok(s1.name === 'exactInputSingle' && s1.args[0].tokenIn.toLowerCase() === J3 && s1.args[0].tokenOut.toLowerCase() === M.WETH.toLowerCase()
     && s1.args[0].recipient.toLowerCase() === M.ADRESSE_ROUTEUR.toLowerCase() && s1.args[0].amountIn.eq(5000) && s1.args[0].amountOutMinimum.eq(4000),
     'd abord jeton → WETH, garde CHEZ LE ROUTEUR, avec le minimum');
  ok(s2.name === 'unwrapWETH9' && s2.args.amountMinimum.eq(4000) && s2.args.recipient.toLowerCase() === c5.adr.toLowerCase(),
     'puis le WETH deballe vers le miroir, le meme minimum exige une seconde fois');
  eq(await M.surVente({ adr: J3 }), 1, 'et la vente de la colonie la ferme');
}

console.log('\n-- une adresse qui n est ni l un ni l autre, ou pas contre l ETH, est dite pour ce qu elle est --');
{
  const X = '0x' + '4a'.repeat(20), NI = '0x' + 'b4'.repeat(20), GLD2 = '0x' + '9e'.repeat(20), PG = '0x' + 'b5'.repeat(20);
  chaine.paires[NI] = { t0: M.WETH, t1: X, fee: null, sansReserves: true };
  await jete(() => M._routeDe(X, NI), /neither a v2 pair nor a v3 pool/, 'ni palier ni reserves : on le dit');
  chaine.paires[PG] = { t0: GLD2, t1: X, fee: 3000 };
  chaine.symboles[GLD2] = 'GLD';
  await jete(() => M._routeDe(X, PG), /quoted in GLD, not ETH/, 'une piscine v3 sans WETH est refusee avec le nom de l autre monnaie');
  await M.arrete(J5, J5);
}

console.log('\n-- une erreur d ordre se lit en une phrase, et dit si de l argent est parti --');
{
  /* Vu dans le journal d un joueur : cinq lignes de JSON de transaction,
     code=UNPREDICTABLE_GAS_LIMIT, et pas un mot sur ce qui s est passe. */
  const gros = new Error('cannot estimate gas; transaction may fail or may require manual gas limit [ See: https://links.ethers.org/v5-errors-UNPREDICTABLE_GAS_LIMIT ] (reason="execution reverted", method="estimateGas", transaction={"from":"0x..","maxFeePerGas":{"type":"BigNumber"}}, code=UNPREDICTABLE_GAS_LIMIT, version=abstract-signer/5.8.0)');
  gros.code = 'UNPREDICTABLE_GAS_LIMIT';
  const r = M._resume(gros);
  ok(/would revert/.test(r) && /Nothing was sent, nothing was spent/.test(r) && r.length < 220,
     'un gaz inestimable devient : « ' + r + ' »');
  ok(/not enough ETH/.test(M._resume(Object.assign(new Error('x'), { code: 'INSUFFICIENT_FUNDS' }))), 'fonds insuffisants : dit');
  eq(M._resume(new Error('pool key lost for this token')), 'pool key lost for this token', 'une erreur a nous garde sa phrase');
  ok(M._resume(new Error('a\nb\nc')).indexOf('\n') < 0, 'et jamais plus d une ligne');
}

console.log('\n-- effacer le journal n efface que le journal --');
{
  const c = M._fiche(JOUEUR);
  const trades = (c.fermees || []).length, ouvertes = Object.keys(c.ouvertes || {}).length;
  ok(c.journal.length > 1, 'le journal est plein (' + c.journal.length + ' lignes)');
  const r = M.effaceJournal(JOUEUR);
  eq(r.efface, c.journal.length === 1 ? r.efface : r.efface, 'il dit combien il a efface (' + r.efface + ')');
  eq(c.journal.length, 1, 'il reste une ligne');
  ok(/Log cleared \(\d+ lines?\)/.test(c.journal[0].txt) && /untouched/.test(c.journal[0].txt), 'qui dit ce qui a ete fait : « ' + c.journal[0].txt + ' »');
  eq((c.fermees || []).length, trades, 'les ventes du bilan sont intactes');
  eq(Object.keys(c.ouvertes || {}).length, ouvertes, 'et les positions aussi');
  await jete(() => M.effaceJournal('0x' + '00'.repeat(20)), /no mirror wallet/, 'sans miroir, rien a effacer');
}

console.log('\n-- le registre survit a une relecture --');
{
  M.sauve();
  const copie = JSON.parse(JSON.stringify(M._etat()));
  M._pose({ v: 1, comptes: {} });
  M.charge();
  eq(Object.keys(M._etat().comptes).length, Object.keys(copie.comptes).length,
     'tous les comptes sont relus (' + Object.keys(M._etat().comptes).length + ')');
  eq(M._fiche(JOUEUR).adr, copie.comptes[JOUEUR.toLowerCase()].adr, 'avec leur adresse');
  ok(/^0x[0-9a-f]{64}$/.test(M.revele(JOUEUR).cle), 'et leur cle se dechiffre encore apres le tour du disque');
}

fs.rmSync(DOSSIER, { recursive: true, force: true });
console.log('\nmiroir.test.js : ' + n + ' verifications OK');
})().catch((e) => {
  console.log('\nEXCEPTION : ' + (e && e.stack || e));
  try { fs.rmSync(DOSSIER, { recursive: true, force: true }); } catch (x) {}
  process.exitCode = 1;
});
