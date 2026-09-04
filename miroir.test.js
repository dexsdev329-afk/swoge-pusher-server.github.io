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
  }
  detectNetwork() { return Promise.resolve({ chainId: 4663, name: 'faux' }); }
  async send(methode, params) {
    if (methode === 'eth_chainId') return '0x1237';
    if (methode === 'eth_blockNumber') return '0x' + this.bloc.toString(16);
    if (methode === 'eth_gasPrice') return '0x' + (1000000000).toString(16);
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
  logsInitialize(filtre) {
    const t = (filtre && filtre.topics) || [];
    if (!t[1] || !t[2]) return [];
    const A = ethers.utils.defaultAbiCoder;
    return [{
      address: M.PM4, blockNumber: '0x1', transactionHash: '0x' + 'ab'.repeat(32),
      transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), logIndex: '0x0', removed: false,
      topics: [M.SUJET_INIT, t[1], t[2]],
      data: A.encode(['uint24', 'int24', 'address', 'uint160', 'int24'],
                     [3000, 60, '0x' + '00'.repeat(20), '79228162514264337593543950336', 0]),
    }];
  }
  appel(tx) {
    const a = String(tx.to || '').toLowerCase();
    const A = ethers.utils.defaultAbiCoder;
    if (a === M.QUOTEUR4.toLowerCase()) return A.encode(['uint256', 'uint256'], [this.sortieDevis, 100000]);
    if (a === M.PERMIT2.toLowerCase()) return A.encode(['uint160', 'uint48', 'uint48'], [0, 0, 0]);
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

console.log('\n-- le miroir suit la vente --');
{
  const suivis = await M.surVente({ adr: JETON });
  eq(suivis, 1, 'la vente de la colonie ferme la position du miroir');
  const e = await M.etat(JOUEUR, false);
  eq(e.ouvertes.length, 1, 'il ne reste que l autre');
  ok(/Sold TEST/.test(e.journal[0].txt), 'et le journal dit ce qui a ete vendu : « ' + e.journal[0].txt + ' »');
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
