'use strict';
/* Le faux noeud Robinhood Chain des essais (lectures_rh.test.js, decouverte.test.js) :
   il decode les VRAIS encodages — Multicall3 aggregate3, ERC-20, emplacements
   EIP-1967, recus et journaux. Pour les essais seulement. */
const { ethers } = require('ethers');
const L = require('./lectures_rh');
const JETON = '0x8a166fb41cd659a0a43396272ff73973ce29f817';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const IMPL = '0x1111111111111111111111111111111111111111';
const PORTEUR = '0x2222222222222222222222222222222222222222';
const PROXY = '0x3333333333333333333333333333333333333333';
const I20 = new ethers.utils.Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function owner() view returns (address)']);
const IMC = new ethers.utils.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)']);
/* Un code qui expose mint(address,uint256) derriere un PUSH4 ; un autre, pause(). */
const CODE_MINT = '0x6080' + '6340c10f19' + '00';
const CODE_PAUSE = '0x6080' + '638456cb59' + '00';

function faux(o) {
  o = o || {};
  const vus = [];
  const jetons = {
    [JETON]: { name: 'Swole Doge', symbol: 'SWOGE', decimals: 18, totalSupply: ethers.utils.parseUnits('1000000000', 18), owner: ethers.constants.AddressZero,
      balances: { [PORTEUR]: ethers.utils.parseUnits('1234.5', 18) } },
    [USDG]: { name: 'Global Dollar', symbol: 'USDG', decimals: 6, totalSupply: ethers.utils.parseUnits('5000000', 6), balances: { [PORTEUR]: ethers.utils.parseUnits('42', 6) } },
    [PROXY]: { name: 'Proxied', symbol: 'PRX', decimals: 18, totalSupply: ethers.utils.parseUnits('10', 18), owner: '0x4444444444444444444444444444444444444444', balances: {} },
  };
  const repond = (cible, data) => {
    if (cible.toLowerCase() === L.MULTICALL3.toLowerCase() && data.startsWith(IMC.getSighash('getEthBalance'))) return IMC.encodeFunctionResult('getEthBalance', [ethers.utils.parseEther('0.5')]);
    const j = jetons[cible.toLowerCase()];
    if (!j) return null;
    const f = I20.parseTransaction({ data });
    if (f.name === 'balanceOf') return I20.encodeFunctionResult('balanceOf', [j.balances[f.args[0].toLowerCase()] || 0]);
    if (j[f.name] === undefined) return null;
    return I20.encodeFunctionResult(f.name, [j[f.name]]);
  };
  const rpc = async (m, p) => {
    vus.push(m);
    if (o.panne) throw new Error('rpc 429 Too Many Requests');
    if (m === 'eth_blockNumber') return '0x' + (100000).toString(16);
    if (m === 'eth_getCode') return p[0].toLowerCase() === PORTEUR ? '0x' : p[0].toLowerCase() === IMPL ? CODE_MINT : p[0].toLowerCase() === PROXY ? CODE_PAUSE : CODE_PAUSE.replace('638456cb59', '6300000000');
    if (m === 'eth_getStorageAt') return p[0].toLowerCase() === PROXY && p[1] === L.SLOT_IMPL ? '0x' + '0'.repeat(24) + IMPL.slice(2) : '0x' + '0'.repeat(64);
    if (m === 'eth_call') {
      if (p[0].to.toLowerCase() !== L.MULTICALL3.toLowerCase()) return repond(p[0].to, p[0].data) || '0x';
      const calls = IMC.decodeFunctionData('aggregate3', p[0].data)[0];
      return IMC.encodeFunctionResult('aggregate3', [calls.map((c) => { let r = null; try { r = repond(c.target, c.callData); } catch (e) { r = null; }
        return { success: r !== null, returnData: r || '0x' }; })]);
    }
    if (m === 'eth_getTransactionByHash') return p[0] === '0x' + 'ab'.repeat(32) ? { hash: p[0], from: PORTEUR, to: JETON, value: '0x0', input: '0xa9059cbb' + '00'.repeat(64), blockNumber: '0x10', gasPrice: '0x3b9aca00' } : null;
    if (m === 'eth_getTransactionReceipt') return { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [
      { address: JETON, topics: [L.TOPIC.transfer, '0x' + '0'.repeat(24) + PORTEUR.slice(2), '0x' + '0'.repeat(24) + PROXY.slice(2)], data: ethers.utils.hexZeroPad(ethers.utils.parseUnits('10', 18).toHexString(), 32) },
      { address: '0x5555555555555555555555555555555555555555', topics: [L.TOPIC.swapV2, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: '0x' }] };
    if (m === 'eth_getLogs') return Array.from({ length: o.logs || 3 }, (_, i) => ({ logIndex: '0x' + i.toString(16) }));
    if (m === 'eth_chainId') return '0x1237';
    return null;
  };
  const fetch = async (u) => ({ json: async () => (o.sansPrix ? [] : [{ baseToken: { address: JETON }, priceUsd: '0.00002579', liquidity: { usd: 13568 }, pairAddress: '0xpool', url: 'https://dexscreener.com/robinhood/0xpool' }]) });
  let t = 1e12;
  /* Hors de l essai du seau, l horloge avance de 10 s a chaque lecture : le seau est plein. */
  const X = L.cree({ rpc, fetch, ethUsd: async () => 4000, maintenant: () => (o.seau ? t : (t += 10000)) });
  return { X, vus, avance: (ms) => { t += ms; } };
}

module.exports = { faux, JETON, USDG, IMPL, PORTEUR, PROXY };
