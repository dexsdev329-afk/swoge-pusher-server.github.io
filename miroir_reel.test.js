'use strict';
/*
 * LE MIROIR EN MODE REEL : LES PERTES SE COMPTENT SUR LE SOLDE
 *
 * « Il ne calcule pas correctement les pertes, c'est sûr. En mode réel,
 *   vérifie. »
 *
 * Mesure le 4 septembre sur deux miroirs en reel : la barre disait
 * -0,000025 ETH sur deux ventes, quand le solde du premier etait passe de
 * 0,003277 a 0,002336 ETH. Le bilan comptait le DEVIS du quoteur comme sortie
 * et la MISE comme entree — ni le gaz des transactions, ni celui des
 * autorisations, ni l'ecart entre le devis et le bloc. Sur un ordre de
 * 0,000025 ETH, le gaz seul en valait autant.
 *
 * Ce banc tourne avec MIROIR_EXECUTE=1 sur une fausse chaine qui fait ce que
 * la vraie fait : chaque transaction signee coute du gaz, un achat retire sa
 * valeur, une vente rend ce que la piscine a bien voulu rendre. Le bilan doit
 * dire ce que le SOLDE a fait.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ethers } = require('ethers');

const DOSSIER = fs.mkdtempSync(path.join(os.tmpdir(), 'miroir-reel-'));
process.env.DATA_DIR = DOSSIER;
process.env.MIROIR_CLE = 'une phrase de passe d essai';
process.env.MIROIR_EXECUTE = '1';
process.env.MIROIR_MAX = '3';
process.env.MIROIR_PAUSE_MS = '0';

const M = require('./miroir');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; console.log('  ok   ' + m); };
const W = (x) => ethers.utils.parseUnits(String(x), 18);
const F = (x) => ethers.utils.formatUnits(x, 18);
const JOUEUR = '0x' + '11'.repeat(20);
const JETON = '0x' + 'aa'.repeat(20);
const GAZ_TX = W('0.00003');            /* ce qu'une transaction coute sur la chaine, mesure : 0,134 gwei x ~220 000 */
const RENDU_VENTE = W('0.004');         /* ce que la piscine rend a la vente, moins que le devis */

class ChaineReelle extends ethers.providers.StaticJsonRpcProvider {
  constructor() {
    super('http://127.0.0.1:1/faux', { chainId: 4663, name: 'faux' });
    this.soldes = {};
    this.envois = [];
    this.sortieDevis = W(1000);
    this.jetonsTenus = W(1000);
    this.nonces = {};
  }
  detectNetwork() { return Promise.resolve({ chainId: 4663, name: 'faux' }); }
  async send(methode, params) {
    if (methode === 'eth_chainId') return '0x1237';
    if (methode === 'eth_blockNumber') return '0x' + (5000000).toString(16);
    if (methode === 'eth_gasPrice') return '0x' + (134102000).toString(16);
    if (methode === 'eth_getBlockByNumber')
      return { number: '0x4c4b40', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '10'.repeat(32),
               timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), gasLimit: '0x1c9c380', gasUsed: '0x0',
               miner: '0x' + '00'.repeat(20), extraData: '0x', transactions: [], nonce: '0x0000000000000000',
               difficulty: '0x0', _difficulty: '0x0' };
    if (methode === 'eth_getBalance') {
      const a = String(params[0]).toLowerCase();
      return (this.soldes[a] || ethers.BigNumber.from(0)).toHexString();
    }
    if (methode === 'eth_getTransactionCount') {
      const a = String(params[0]).toLowerCase();
      return '0x' + (this.nonces[a] || 0).toString(16);
    }
    if (methode === 'eth_estimateGas') return '0x' + (220000).toString(16);
    if (methode === 'eth_getLogs') return this.logsInitialize(params[0]);
    if (methode === 'eth_call') return this.appel(params[0]);
    if (methode === 'eth_sendRawTransaction') {
      /* ---- CE QUE LA CHAINE FAIT D UNE TRANSACTION SIGNEE ----
         Elle prend le gaz. Un achat retire en plus sa valeur. Une vente rend
         ce que la piscine donne — pas le devis. Une autorisation ne fait que
         couter. C est exactement ce qu un bilan honnete doit voir. */
      const tx = ethers.utils.parseTransaction(params[0]);
      const de = String(tx.from).toLowerCase();
      const vers = String(tx.to || '').toLowerCase();
      this.nonces[de] = (this.nonces[de] || 0) + 1;
      let solde = this.soldes[de] || ethers.BigNumber.from(0);
      solde = solde.sub(GAZ_TX);
      const routeur = vers === M.ROUTEUR4.toLowerCase() || vers === M.ROUTEUR2.toLowerCase() || vers === M.ROUTEUR3.toLowerCase();
      if (routeur && tx.value.gt(0)) solde = solde.sub(tx.value);            /* achat */
      else if (routeur) solde = solde.add(RENDU_VENTE);                       /* vente */
      this.soldes[de] = solde;
      this.envois.push({ de, vers, valeur: tx.value, data: tx.data });
      return ethers.utils.keccak256(params[0]);       /* ethers verifie que le hash rendu est celui de la transaction signee */
    }
    if (methode === 'eth_getTransactionReceipt') {
      return { transactionHash: params[0], blockNumber: '0x4c4b40', blockHash: '0x' + '11'.repeat(32),
               transactionIndex: '0x0', gasUsed: '0x35b60', cumulativeGasUsed: '0x35b60', status: '0x1', logs: [],
               effectiveGasPrice: '0x' + (134102000).toString(16), from: '0x' + '00'.repeat(20), to: '0x' + '00'.repeat(20) };
    }
    throw new Error('methode non simulee : ' + methode);
  }
  logsInitialize(filtre) {
    const t = (filtre && filtre.topics) || [];
    if (!(!t[1] && t[2] && t[3])) return [];
    const A = ethers.utils.defaultAbiCoder;
    const ZERO = '0x' + '00'.repeat(20);
    const c0 = '0x' + t[2].slice(26), c1 = '0x' + t[3].slice(26);
    return [{
      address: M.PM4, blockNumber: '0x1', transactionHash: '0x' + 'ab'.repeat(32),
      transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), logIndex: '0x0', removed: false,
      topics: [M.SUJET_INIT, M._idV4([c0, c1, 3000, 60, ZERO]), t[2], t[3]],
      data: A.encode(['uint24', 'int24', 'address', 'uint160', 'int24'], [3000, 60, ZERO, '79228162514264337593543950336', 0]),
    }];
  }
  appel(tx) {
    const a = String(tx.to || '').toLowerCase();
    const A = ethers.utils.defaultAbiCoder;
    if (a === M.QUOTEUR4.toLowerCase()) return A.encode(['uint256', 'uint256'], [this.sortieDevis, 100000]);
    if (a === M.PERMIT2.toLowerCase()) return A.encode(['uint160', 'uint48', 'uint48'], [0, 0, 0]);
    return A.encode(['uint256'], [this.jetonsTenus]);
  }
}
const chaine = new ChaineReelle();
M._poseProvider(chaine);
const poolDe = (j) => {
  const p = M.ETH4.toLowerCase() < j.toLowerCase() ? [M.ETH4, j] : [j, M.ETH4];
  return M._idV4([p[0], p[1], 3000, 60, '0x' + '00'.repeat(20)]);
};

(async () => {
  ok(M.EXECUTE === true, 'ce banc tourne en mode REEL : les transactions sont signees et envoyees');

  console.log('\n-- un achat reel coute la mise PLUS le gaz, et la position le note --');
  await M.cree(JOUEUR);
  const c = M._fiche(JOUEUR);
  chaine.soldes[c.adr.toLowerCase()] = W('0.05');
  await M.demarre(JOUEUR);
  const mise = M._miseDe(W('0.05'), 0.1);
  const suivi = await M.surAchat({ sym: 'TEST', adr: JETON, pool: poolDe(JETON), part: 0.1 });
  console.log('   journal : ' + JSON.stringify((await M.etat(JOUEUR, false)).journal[0]));
  eq(suivi, 1, 'l achat est suivi');
  eq(chaine.envois.length, 1, 'une transaction est partie');
  ok(chaine.envois[0].valeur.eq(mise), 'avec la mise en valeur (' + F(mise) + ' ETH)');
  const o = c.ouvertes[JETON];
  ok(o && o.cout !== null, 'la position note son cout reel');
  ok(W(o.cout).eq(mise.add(GAZ_TX)), 'et ce cout est la mise plus le gaz : ' + o.cout + ' ETH, pas ' + o.entree);
  const e1 = await M.etat(JOUEUR, false);
  ok(/cost incl\. gas/.test(e1.journal[0].txt) && !/dry run/.test(e1.journal[0].txt),
     'le journal dit le cout gaz compris, et ne dit pas « dry run » : « ' + e1.journal[0].txt.slice(0, 90) + '… »');

  console.log('\n-- une vente reelle rend ce que le solde a regagne, autorisations et gaz deduits --');
  const avant = chaine.soldes[c.adr.toLowerCase()];
  eq(await M.surVente({ adr: JETON }), 1, 'la vente est suivie');
  /* Permit2 n autorisait rien : une autorisation part, puis la vente. */
  eq(chaine.envois.length, 3, 'deux transactions de plus : l autorisation Permit2, puis la vente');
  const apres = chaine.soldes[c.adr.toLowerCase()];
  const recu = apres.sub(avant);
  ok(recu.eq(RENDU_VENTE.sub(GAZ_TX).sub(GAZ_TX)), 'le solde a regagne le rendu de la piscine moins DEUX gaz : ' + F(recu) + ' ETH');
  const f = c.fermees[0];
  eq(f.reel, true, 'la ligne du bilan est marquee reelle');
  ok(W(f.sortie).eq(recu), 'sa sortie est ce que le solde a regagne (' + f.sortie + '), pas le devis (' + f.devis + ')');
  ok(W(f.entree).eq(mise.add(GAZ_TX)), 'son entree est ce que le solde a perdu a l achat (' + f.entree + ')');
  const e2 = await M.etat(JOUEUR, false);
  eq(e2.bilan.trades, 1, 'un trade au bilan');
  eq(e2.bilan.reel, true, 'et le bilan se dit reel');
  const attendu = recu.sub(mise.add(GAZ_TX));
  ok(Math.abs(Number(e2.bilan.profitEth) - Number(F(attendu))) < 1e-6,
     'le profit est solde regagne moins solde perdu, gaz des deux cotes compris : ' + e2.bilan.profitEth + ' ETH');
  ok(Number(e2.bilan.profitEth) < 0, 'ici une perte — le devis disait ' + F(chaine.sortieDevis) + ', la piscine a rendu ' + F(RENDU_VENTE));
  ok(/net of gas/.test(e2.journal[0].txt) && /result -/.test(e2.journal[0].txt),
     'et le journal ecrit le net et le resultat : « ' + e2.journal[0].txt.slice(0, 110) + '… »');
  const soldeFinal = chaine.soldes[c.adr.toLowerCase()];
  ok(W('0.05').sub(soldeFinal).eq(attendu.mul(-1)),
     'et le solde du portefeuille a bouge d exactement ce chiffre : 0.05 → ' + F(soldeFinal));

  console.log('\n-- un ordre dont le gaz mange plus d un dixieme ne part pas, meme en reel --');
  chaine.soldes[c.adr.toLowerCase()] = W('0.0023');
  const n0 = chaine.envois.length;
  const J2 = '0x' + 'bb'.repeat(20);
  await M.surAchat({ sym: 'PETIT', adr: J2, pool: poolDe(J2), part: 0.03 });
  eq(chaine.envois.length, n0, 'rien n est parti');
  const e3 = await M.etat(JOUEUR, false);
  ok(/Skipped PETIT: 0\.0008 ETH \(RH\) free/.test(e3.journal[0].txt) && /at least 0\.001 ETH/.test(e3.journal[0].txt),
     'le journal dit le libre, le plancher et quoi faire : « ' + e3.journal[0].txt.slice(0, 120) + '… »');

  console.log('\n-- stop en reel : vendre, puis balayer vers le compte --');
  chaine.soldes[c.adr.toLowerCase()] = W('0.05');
  await M.surAchat({ sym: 'TEST', adr: JETON, pool: poolDe(JETON), part: 0.1 });
  const n1 = chaine.envois.length;
  const r = await M.arrete(JOUEUR, JOUEUR);
  eq(r.vendus.length, 1, 'stop vend la position');
  ok(chaine.envois.length >= n1 + 2, 'la vente et le balayage sont partis (' + (chaine.envois.length - n1) + ' transactions)');
  const dernier = chaine.envois[chaine.envois.length - 1];
  eq(dernier.vers, JOUEUR.toLowerCase(), 'la derniere va au portefeuille du compte');
  eq((await M.etat(JOUEUR, false)).bilan.trades, 2, 'la vente du stop est au bilan');

  console.log('\nmiroir_reel.test.js : ' + n + ' verifications OK');
})().catch((e) => { console.error('EXCEPTION :', e); process.exit(1); });
