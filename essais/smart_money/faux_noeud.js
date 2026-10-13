'use strict';
/* Un FAUX NOEUD aux regles du vrai (sonde du 13/10/2026), pour les essais du
 * detecteur smart money. Il sert une chaine ecrite par l'essai et applique les
 * memes refus, avec les MEMES messages :
 *   une valeur par position + adresse  10 000 000 blocs
 *   une position en tableau            100 000 blocs
 *   sans adresse                       30 000 blocs
 *   plafond de lignes                  10 000 (-32000 « logs matched by query exceeds limit of 10000 »)
 *   valeurs par requete                1 000 au plus
 *   au-dela de la pointe               [] sans erreur
 * `pannes` : file de reponses forcees (429, 403, 'html', 'json429') consommees
 * dans l'ordre, une par requete HTTP.
 */
const viem = require('viem');

const ABI_MC = viem.parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const ABI_20 = viem.parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)',
  'function token0() view returns (address)', 'function token1() view returns (address)']);

function fauxNoeud(o) {
  const etat = { http: 0, requetes: [], refus: 0, limites: Object.assign({ simple: 10000000, multi: 100000, sansAdresse: 30000, lignes: 10000 }, o.limites || {}) };
  const pannes = o.pannes || [];
  const logs = () => (typeof o.logs === 'function' ? o.logs() : o.logs || []);
  const pointe = () => (typeof o.pointe === 'function' ? o.pointe() : o.pointe);
  const correspond = (l, f, de, a) => {
    const b = parseInt(l.blockNumber, 16);
    if (b < de || b > a) return false;
    if (f.address) {
      const ad = Array.isArray(f.address) ? f.address.map((x) => x.toLowerCase()) : [String(f.address).toLowerCase()];
      if (!ad.includes(String(l.address).toLowerCase())) return false;
    }
    const t = f.topics || [];
    for (let k = 0; k < t.length; k++) {
      if (t[k] == null) continue;
      const v = Array.isArray(t[k]) ? t[k].map((x) => String(x).toLowerCase()) : [String(t[k]).toLowerCase()];
      if (!l.topics[k] || !v.includes(String(l.topics[k]).toLowerCase())) return false;
    }
    return true;
  };
  function une(q) {
    const rep = (result) => ({ jsonrpc: '2.0', id: q.id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id: q.id, error: { code, message } });
    etat.requetes.push({ method: q.method, params: q.params });
    if (o.surRequete) { const r = o.surRequete(q); if (r) return r; }
    switch (q.method) {
      case 'eth_blockNumber': return rep('0x' + pointe().toString(16));
      case 'eth_chainId': return rep('0x1237');
      case 'eth_getLogs': {
        const f = q.params[0];
        const de = parseInt(f.fromBlock, 16), a = parseInt(f.toBlock, 16);
        if (de > a) return rep([]);
        const n = (f.address && Array.isArray(f.address) ? f.address.length : f.address ? 1 : 0) + (f.topics || []).reduce((s, t) => s + (t == null ? 0 : Array.isArray(t) ? t.length : 1), 0);
        if (n > 1000) return err(-32602, `${n} address and topic selectors specified in query, but only 1000 are allowed`);
        const multi = (Array.isArray(f.address) && f.address.length > 1) || (f.topics || []).some((t) => Array.isArray(t) && t.length > 1);
        const lim = !f.address ? etat.limites.sansAdresse : multi ? etat.limites.multi : etat.limites.simple;
        const span = a - de + 1;
        if (span > lim) return err(-32602, `query spans ${span} blocks (${de} to ${a}), but only ${lim} are allowed for this request; narrow the block range`);
        const haut = Math.min(a, pointe());
        const r = logs().filter((l) => correspond(l, f, de, haut));
        if (r.length > etat.limites.lignes) return err(-32000, `logs matched by query exceeds limit of ${etat.limites.lignes}`);
        return rep(r);
      }
      case 'eth_getBlockByNumber': {
        const b = parseInt(q.params[0], 16);
        if (b > pointe()) return rep(null);
        const t = o.horodatage ? o.horodatage(b) : 1700000000 + Math.floor(b / 10);
        return rep({ number: '0x' + b.toString(16), timestamp: '0x' + t.toString(16) });
      }
      case 'eth_getTransactionReceipt': return rep((o.recus || {})[String(q.params[0]).toLowerCase()] || null);
      case 'eth_getTransactionByHash': return rep((o.txs || {})[String(q.params[0]).toLowerCase()] || null);
      case 'eth_call': {
        const { to, data } = q.params[0];
        if (String(to).toLowerCase() !== '0xca11bde05977b3631167028862be2a173976ca11') return err(-32000, 'execution reverted');
        const { args } = viem.decodeFunctionData({ abi: ABI_MC, data });
        const res = args[0].map((c) => {
          let fn, a2;
          try { const d = viem.decodeFunctionData({ abi: ABI_20, data: c.callData }); fn = d.functionName; a2 = d.args; } catch (e) { return { success: false, returnData: '0x' }; }
          const v = o.contrat ? o.contrat(String(c.target).toLowerCase(), fn, (a2 || []).map((x) => (typeof x === 'string' ? x.toLowerCase() : x))) : undefined;
          if (v === undefined || v === null) return { success: false, returnData: '0x' };
          return { success: true, returnData: viem.encodeFunctionResult({ abi: ABI_20, functionName: fn, result: v }) };
        });
        return rep(viem.encodeFunctionResult({ abi: ABI_MC, functionName: 'aggregate3', result: res }));
      }
      default: return err(-32601, 'method not found');
    }
  }
  async function prendre(url, init) {
    etat.http++;
    const corps = JSON.parse(init.body);
    const p = pannes.length ? pannes.shift() : null;
    const r = (status, texte) => ({ status, ok: status === 200, headers: { get: () => null }, text: async () => texte });
    if (p === 429) { etat.refus++; return r(429, JSON.stringify({ jsonrpc: '2.0', error: { code: 429, message: 'Too Many Requests' } })); }
    if (p === 403) { etat.refus++; return r(403, '<html>Just a moment...</html>'); }
    if (p === 'html') { etat.refus++; return r(200, '<html>bad gateway</html>'); }
    if (p === 'json429') { etat.refus++; return r(200, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too Many Requests' } })); }
    const out = Array.isArray(corps) ? corps.map(une) : une(corps);
    return r(200, JSON.stringify(out));
  }
  return { prendre, etat };
}

/** Fabriques de journaux bruts. */
const hex = (x) => '0x' + BigInt(x).toString(16);
const mot = (x) => { let v = BigInt(x); if (v < 0n) v += 2n ** 256n; return v.toString(16).padStart(64, '0'); };
const pad = (a) => '0x' + String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
function journal(adresse, topics, mots, bloc, tx, i) {
  return { address: adresse, topics, data: '0x' + mots.map(mot).join(''), blockNumber: hex(bloc), transactionHash: tx, logIndex: hex(i) };
}

module.exports = { fauxNoeud, journal, hex, mot, pad, ABI_20 };
