'use strict';
/* Les lectures Robinhood Chain vendues aux agents (lectures_rh.js), contre un
   faux noeud qui decode les VRAIS encodages : Multicall3 aggregate3, ERC-20,
   emplacements EIP-1967, recus et journaux. Ce que ces outils doivent tenir :
   lecture seule, bornes, la colonie d'abord (le seau), decodage juste. */
const { ethers } = require('ethers');
const L = require('./lectures_rh');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const { faux, JETON, USDG, IMPL, PORTEUR, PROXY } = require('./faux_noeud_rh');

(async () => {
  console.log('-- robinhood_rpc : lecture seule, bornee --');
  {
    const { X, vus } = faux();
    const r = await X.robinhood_rpc({ method: 'eth_chainId' });
    ok(r.donnees && r.donnees.result === '0x1237' && r.donnees.chainId === 4663, 'eth_chainId : rendu tel quel, avec la chaine');
    for (const m of ['eth_sendRawTransaction', 'eth_sign', 'eth_newFilter', 'debug_traceTransaction', 'eth_subscribe']) {
      const x = await X.robinhood_rpc({ method: m, params: [] });
      ok(x.erreur && /read-only/.test(x.erreur), m + ' : refusee (lecture seule)');
    }
    ok((await X.robinhood_rpc({ method: 'eth_getBlockByNumber', params: ['latest', true] })).erreur, 'un bloc avec ses transactions completes : refuse (des megaoctets)');
    ok((await X.robinhood_rpc({ method: 'eth_getBalance', params: ['0x12', 'latest'] })).erreur, 'une adresse mal formee n atteint pas le noeud');
    ok((await X.robinhood_rpc({ method: 'eth_call', params: [{ to: JETON, data: '0x06fdde03', gas: '0x1' }, 'latest'] })).erreur, 'eth_call : un champ inconnu (gas) est refuse');
    ok((await X.robinhood_rpc({ method: 'eth_getLogs', params: [{ address: JETON, fromBlock: '0x1', toBlock: 'latest' }] })).erreur.includes('10,000 blocks'), 'eth_getLogs sur 100 000 blocs : refuse (10 000 au plus)');
    ok((await X.robinhood_rpc({ method: 'eth_getLogs', params: [{ address: JETON, toBlock: 'latest' }] })).erreur, 'eth_getLogs sans fromBlock numerique : refuse');
    const lg = await X.robinhood_rpc({ method: 'eth_getLogs', params: [{ address: JETON, fromBlock: '0x' + (99000).toString(16), toBlock: 'latest' }] });
    ok(lg.donnees && lg.donnees.result.length === 3 && lg.donnees.truncated === false, 'eth_getLogs sur 1 000 blocs : rendu');
    ok(!vus.includes('eth_sendRawTransaction') && !vus.includes('eth_sign'), 'aucune methode refusee n a atteint le noeud');
  }
  {
    const { X } = faux({ logs: 900 });
    const lg = await X.robinhood_rpc({ method: 'eth_getLogs', params: [{ address: JETON, fromBlock: '0x' + (99000).toString(16), toBlock: 'latest' }] });
    ok(lg.donnees.result.length === L.LOGS_MAX && lg.donnees.truncated === true, '900 journaux : coupes a ' + L.LOGS_MAX + ', et le resultat le dit');
  }
  console.log('\n-- le seau : la colonie passe avant --');
  {
    const { X, avance } = faux({ seau: true });
    let occupes = 0;
    for (let i = 0; i < 12; i++) { const r = await X.robinhood_rpc({ method: 'eth_blockNumber' }); if (r.erreur && /busy/.test(r.erreur)) occupes++; }
    ok(occupes === 4 && X.MESURE.occupe === 4, '12 appels d un coup : 8 servis (la rafale), 4 « occupe », rien facture');
    avance(1000);
    ok((await X.robinhood_rpc({ method: 'eth_blockNumber' })).donnees, 'une seconde plus tard : 4 jetons revenus, servi');
    avance(1000);
    const t1 = await X.robinhood_token({ address: '0x3333333333333333333333333333333333333333' });
    const t2 = await X.robinhood_token({ address: '0x3333333333333333333333333333333333333333' });
    ok(t1.donnees && t1.donnees.powers.readFrom === 'implementation' && t2.erreur && /busy/.test(t2.erreur),
       'robinhood_token reserve ses 5 lectures d un coup : servi entier (pouvoirs lus chez l implementation), puis « occupe » — jamais a moitie');
  }
  console.log('\n-- robinhood_token --');
  {
    const { X } = faux();
    const r = await X.robinhood_token({ address: JETON });
    const d = r.donnees;
    ok(d.erc20.symbol === 'SWOGE' && d.erc20.decimals === 18 && d.erc20.totalSupplyUnits === 1e9 && d.owner === 'renounced (zero address)', 'ERC-20 lu en un Multicall3 : SWOGE, 18 decimales, 1 milliard, proprietaire renonce');
    ok(d.proxy === null && d.powers.readFrom === 'contract' && !d.powers.mint && !d.powers.pause, 'pas de proxy ; aucun pouvoir expose');
    ok(d.market && d.market.priceUsd === 0.00002579 && d.market.marketCapUsd === 25790, 'prix DexScreener et capitalisation = prix x offre (25 790 $)');
    const p = (await X.robinhood_token({ address: PROXY })).donnees;
    ok(p.proxy && p.proxy.implementation.toLowerCase() === IMPL && p.powers.readFrom === 'implementation' && p.powers.mint && !p.powers.pause,
       'proxy EIP-1967 : l implementation est trouvee, et les pouvoirs se lisent dans SON code (mint), pas dans celui du proxy (pause)');
    ok(p.owner === '0x4444444444444444444444444444444444444444' && p.market === null, 'proprietaire lu ; sans piscine : market null');
    const w = await X.robinhood_token({ address: PORTEUR });
    ok(w.donnees.isContract === false && /wallet/.test(w.texte), 'une adresse sans code : un portefeuille, dit comme tel');
    ok((await X.robinhood_token({ address: 'nope' })).erreur, 'adresse invalide : refusee');
  }
  console.log('\n-- robinhood_wallet --');
  {
    const { X, vus } = faux();
    const n0 = vus.filter((m) => m === 'eth_call').length;
    const r = await X.robinhood_wallet({ address: PORTEUR });
    const d = r.donnees, s = d.tokens.find((x) => x.symbol === 'SWOGE'), u = d.tokens.find((x) => x.symbol === 'USDG');
    ok(vus.filter((m) => m === 'eth_call').length - n0 === 1, 'ETH + 2 jetons (symbole, decimales, solde) : UN seul eth_call (Multicall3)');
    ok(d.eth.balance === 0.5 && d.eth.valueUsd === 2000 && s.balanceUnits === 1234.5 && u.balanceUnits === 42, '0,5 ETH (2 000 $), 1 234,5 SWOGE, 42 USDG');
    ok(s.valueUsd === 0.03 && u.priceUsd === null && u.valueUsd === null && d.totalValueUsd === 2000.03, 'SWOGE valorise au prix DexScreener ; USDG sans prix : null, pas 0 — total sur les prix connus');
    ok((await X.robinhood_wallet({ address: PORTEUR, tokens: Array(21).fill(JETON) })).erreur, '21 jetons : refuse (20 au plus)');
    const autre = await X.robinhood_wallet({ address: PORTEUR, tokens: ['0x9999999999999999999999999999999999999999'] });
    ok(autre.donnees.tokens[0].readable === false && autre.donnees.tokens[0].balanceUnits === null, 'un jeton illisible : readable false, jamais un 0 invente');
  }
  console.log('\n-- robinhood_tx --');
  {
    const { X } = faux();
    const r = await X.robinhood_tx({ hash: '0x' + 'ab'.repeat(32) });
    const d = r.donnees;
    ok(d.status === 'success' && d.block === 16 && d.method === '0xa9059cbb' && d.feeEth === 0.000021 && d.feeUsd === 0.084, 'succes, bloc 16, methode transfer, frais 21 000 gaz x 1 gwei = 0,000021 ETH (0,084 $)');
    ok(d.transfers.length === 1 && d.transfers[0].symbol === 'SWOGE' && d.transfers[0].amountUnits === 10 && d.transfers[0].to.toLowerCase() === PROXY,
       'le Transfer decode : 10 SWOGE, symbole et decimales lus sur la chaine');
    ok(d.swaps.length === 1 && d.swaps[0].uniswap === 'v2' && /today/.test(d.note), 'le swap Uniswap v2 repere ; la valeur USD dit qu elle est au prix d aujourd hui');
    ok((await X.robinhood_tx({ hash: '0x' + 'cd'.repeat(32) })).erreur.includes('nothing was charged'), 'transaction inconnue : erreur, rien facture');
  }
  console.log('\n-- noeud en panne --');
  {
    const { X } = faux({ panne: true });
    const r = await X.robinhood_token({ address: JETON });
    ok(r.erreur && /nothing was charged/.test(r.erreur) && X.MESURE.erreurs > 0, 'le noeud tombe : une erreur (donc aucun debit), comptee');
    const b = await X.robinhood_rpc({ method: 'eth_blockNumber' });
    ok(b.erreur && /node refused/.test(b.erreur), 'robinhood_rpc : le refus du noeud est rendu, rien facture');
  }
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
