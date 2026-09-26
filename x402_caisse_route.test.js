'use strict';
/*
 * LE MODE CAISSE SUR LE VRAI SERVEUR (X402_CAISSE=1) — décision du
 * propriétaire, 26 septembre 2026 : la caisse est le portefeuille de gaz.
 *   - le 402 fait payer le portefeuille de GAZ, pas la trésorerie ;
 *   - la preuve de propriété est signée par le serveur lui-même (plus rien à
 *     faire à la main), et elle est juste : l'origine, signée par le payTo ;
 *   - l'état public dit la caisse, la trésorerie, la part de rachat ;
 *   - la clé du portefeuille de gaz n'apparaît nulle part.
 */
const net = require('net');
const http = require('http');
const fs = require('fs');
const { ethers } = require('ethers');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const de64 = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const GAZ = ethers.Wallet.createRandom();
const TRESOR = ethers.Wallet.createRandom().address;

/* Un faux nœud minimal : la chaîne 4663, le gaz, des soldes. */
function fauxNoeud() {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const q = JSON.parse(b);
      const un = (m) => {
        const r = (result) => ({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'eth_chainId') return r('0x1237');
        if (m.method === 'net_version') return r('4663');
        if (m.method === 'eth_gasPrice') return r('0x' + (28000000).toString(16));
        if (m.method === 'eth_blockNumber') return r('0x10');
        if (m.method === 'eth_getBalance') return r(ethers.utils.parseEther('0.003').toHexString());
        if (m.method === 'eth_call') return r(ethers.utils.defaultAbiCoder.encode(['uint256'], [0]));
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'faux noeud : ' + m.method } };
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(q) ? q.map(un) : un(q)));
    });
  });
}

const BAC = fs.mkdtempSync('/tmp/x402-caisse-');
Object.assign(process.env, { DATA_DIR: BAC, RPC_URL: '', ADMIN_KEY: 'k', AI_COLONIE: '0', PERP_COLONIES: '0', PERP_JOURNAL: '0', ODDS_API_KEY: '', MONITEUR_URL: '',
  STUDIO_DEX: '0', SWOGE_PRIX_USD: '0.00002493', ETH_PRIX_USD: '2688.57', STUDIO_MARGE: '1.5', X402_CAISSE: '1', X402_CAISSE_PREMIER_MS: String(3600e3) });
delete process.env.PERPLEXITY_API_KEY; delete process.env.X402_PREUVE; delete process.env.X402_RACHAT_PART;
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

(async () => {
  const noeud = fauxNoeud();
  const pn = await libre();
  await new Promise((r) => noeud.listen(pn, '127.0.0.1', r));
  const port = await libre();
  Object.assign(process.env, { PORT: String(port), PUBLIC_URL: 'http://127.0.0.1:' + port, X402_RPC: 'http://127.0.0.1:' + pn, X402_PAYTO: TRESOR, X402_CLE: GAZ.privateKey });
  require('./config');
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const base = 'http://127.0.0.1:' + port;
  const tout = [];
  const lis = async (r) => { const t = await r.text(); tout.push(t, JSON.stringify([...r.headers])); return t; };

  const r1 = await fetch(base + '/agentic/call/colony_activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await lis(r1.clone());
  const acc = de64(r1.headers.get('payment-required')).accepts;
  ok(r1.status === 402 && acc.every((a) => a.payTo === GAZ.address), 'le 402 fait payer le portefeuille de GAZ (la caisse), en USDG comme en $SWOGE');
  await new Promise((r) => setTimeout(r, 200));        /* la signature de l'origine est asynchrone */
  const et = JSON.parse(await lis(await fetch(base + '/agentic/x402')));
  ok(et.caisse.actif && et.caisse.caisse === GAZ.address && et.caisse.tresor === TRESOR && et.tresor === TRESOR && et.caisse.part === 0.05,
     'l etat public : la caisse, la tresorerie ou tout est verse, la part de rachat (5 %)');
  const oa = JSON.parse(await lis(await fetch(base + '/openapi.json')));
  const preuves = (oa['x-discovery'] || {}).ownershipProofs || [];
  ok(preuves.length === 1 && ethers.utils.verifyMessage(base, preuves[0]) === GAZ.address, 'la preuve de propriete est signee par le SERVEUR (plus rien a faire a la main) et elle est juste : l origine, signee par le payTo');
  const wk = JSON.parse(await lis(await fetch(base + '/.well-known/x402')));
  eq(wk.ownershipProofs && wk.ownershipProofs[0], preuves[0], 'et /.well-known/x402 la porte aussi');
  const k = GAZ.privateKey.slice(2).toLowerCase();
  ok(!tout.some((t) => t.toLowerCase().includes(k)), 'la cle du portefeuille de gaz n apparait dans AUCUNE reponse (' + tout.length + ')');

  noeud.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
