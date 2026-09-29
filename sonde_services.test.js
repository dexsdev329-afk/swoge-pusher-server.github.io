'use strict';
/* sonde_services.js : le catalogue x402 note par nos mesures, sans payer ; aucun verdict sous 3 sondes. */
const fs = require('fs'), os = require('os'), path = require('path');
const S = require('./sonde_services');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

(async () => {
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'sondes-'));
  let horloge = Date.UTC(2026, 8, 29, 4, 0);
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const item = (url, desc, amount, extra) => Object.assign({ resource: url, type: 'http', x402Version: 2, description: desc,
    accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: USDC_BASE, amount: String(amount) }] }, extra || {});
  const CAT = [item('https://ok.example/price', 'Solana price feed', 1000), item('https://mort.example/x', 'Solana price oracle', 500),
    item('https://redir.example/x', 'weather forecast', 2000), item('https://v1.example/x', 'solana token data', 3000),
    item('https://post.example/x', 'solana analytics', 4000, { extensions: { bazaar: { info: { input: { method: 'POST' } } } } }),
    { resource: 'http://clair.example/x', accepts: [] }, item('https://ok.example/price', 'doublon', 1)];
  const vus = [];
  const fetch = async (url, o) => {
    vus.push({ url, m: o.method, body: o.body });
    horloge += 120;
    if (url.startsWith('https://ok.')) return { status: 402, headers: { get: (k) => (k === 'payment-required' ? b64({ accepts: [{}] }) : null) }, json: async () => ({}) };
    if (url.startsWith('https://mort.')) throw new Error('connect ECONNREFUSED');
    if (url.startsWith('https://redir.')) return { status: 302, headers: { get: () => null }, json: async () => ({}) };
    if (url.startsWith('https://v1.')) return { status: 402, headers: { get: () => null }, json: async () => ({ x402Version: 1, accepts: [{ scheme: 'exact' }] }) };
    if (url.startsWith('https://post.')) return { status: 500, headers: { get: () => null }, json: async () => ({}) };
    throw new Error('?');
  };
  const payes = [{ url: 'https://ok.example/price', ok: true }, { url: 'https://ok.example/price', ok: false }];
  const mk = () => S.cree({ catalogue: async () => CAT, fetch, dossier: dos, maintenant: () => horloge, paiements: () => payes });
  const X = mk();

  console.log('\n-- sonder sans payer --');
  const t1 = await X.tour();
  ok(t1.ok && t1.catalogue === 5 && t1.sondes === 5, 'le catalogue : 5 services https distincts (le http en clair et le doublon ecartes), 5 sondes');
  ok(vus.every((v) => v.m === 'GET' || (v.url.startsWith('https://post.') && v.m === 'POST' && v.body === '{}')), 'la methode du catalogue, un corps vide en POST ; aucun paiement envoye');
  ok((await X.tour()).sondes === 0, 'une sonde par service toutes les 20 h au plus : le tour suivant ne sonde rien');
  for (let i = 0; i < 2; i++) { horloge += S.ECART_MS; await X.tour(); }

  console.log('\n-- ce que la recherche dit --');
  const r = await X.recherche('solana price');
  const u = (x) => r.services.find((s) => s.url === x);
  ok(r.services[0].url === 'https://ok.example/price' && u('https://ok.example/price').verdict === 'answered every probe' && u('https://ok.example/price').probes.n === 3,
     'le mieux classe : le plus de mots, et il a repondu aux 3 sondes');
  ok(u('https://mort.example/x').verdict === 'never answered' && /connection failed/.test(u('https://mort.example/x').probes.lastFailure.reason), 'le mort : « never answered », avec la raison');
  ok(u('https://v1.example/x').verdict === 'answered every probe', 'un 402 x402 v1 (accepts dans le corps) compte comme une reponse');
  ok(u('https://post.example/x').probes.lastFailure.reason === 'HTTP 500 instead of 402', 'un 500 : dit tel quel');
  const w = await X.recherche('weather');
  ok(w.services[0].probes.lastFailure.reason === 'redirects elsewhere', 'une redirection : jamais suivie, dite');
  ok(u('https://ok.example/price').priceUsd === 0.001 && u('https://ok.example/price').networks.join() === 'eip155:8453' && typeof u('https://ok.example/price').probes.medianMs === 'number',
     'le prix USDC, le reseau, la latence mediane');
  ok(u('https://ok.example/price').paidCalls.n === 2 && u('https://ok.example/price').paidCalls.succeededPct === 50, 'les paiements reels faits par SWOGE : combien, et combien ont abouti');
  ok(r.summary.judged === 5 && r.summary.neverAnsweredPct === 60 && /No verdict under 3 probes/.test(r.note), 'le resume : 5 juges, 60 % jamais repondu, et la regle dite');

  console.log('\n-- sous 3 sondes, pas de verdict ; relu apres redemarrage --');
  const Y = S.cree({ catalogue: async () => CAT.concat([item('https://neuf.example/x', 'solana new', 100)]), fetch, dossier: dos, maintenant: () => horloge });
  horloge += S.ECART_MS; await Y.tour();
  const neuf = (await Y.recherche('solana')).services.find((s) => s.url === 'https://neuf.example/x');
  ok(neuf.verdict === 'not enough probes yet (1/3)', 'un service sonde une fois : « not enough probes yet (1/3) »');
  ok((await Y.recherche('solana')).services.find((s) => s.url === 'https://ok.example/price').probes.n === 4, 'relu depuis le disque : les sondes d avant comptent');
  process.env.SONDES_SERVICES = '0'; ok((await Y.tour()) === null, 'SONDES_SERVICES=0 coupe'); delete process.env.SONDES_SERVICES;

  fs.rmSync(dos, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
