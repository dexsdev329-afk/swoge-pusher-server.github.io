'use strict';
/* famille_client.js et son compte : qui demande un prix ? Un code parmi une liste fixe,
   jamais le User-Agent brut ; sonde ou vraie demande ; expose en codes seulement. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./famille_client');
const C = require('./compteurs');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const cas = [['x402scan/1.0 (+https://x402scan.com)', 'x402scan'], ['AgentCash-Validator/2', 'agentcash'], ['Coinbase-Bazaar-Indexer', 'coinbase'],
  ['python-requests/2.32', 'python'], ['node-fetch/1.0', 'node'], ['undici', 'node'], ['Go-http-client/2.0', 'go'], ['curl/8.5.0', 'curl'],
  ['Mozilla/5.0 (Windows NT 10.0) Chrome/140', 'browser'], ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'bot'], ['Claude-User', 'claude'],
  ['', 'none'], [undefined, 'none'], ['WeirdClient 0.1', 'other']];
ok(cas.every(([ua, f]) => F.famille(ua) === f), 'chaque User-Agent tombe dans sa famille : ' + cas.map(([ua]) => F.famille(ua)).join(','));
ok(cas.every(([ua]) => F.CODES.includes(F.famille(ua))) && F.CODES.every((c) => /^[a-z0-9]+$/.test(c)), 'toujours un code de la liste fixe, jamais le texte');

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'famille-'));
const t = Date.UTC(2026, 8, 29, 12);
const K = C.cree({ dossier: d, maintenant: () => t, signaux: false, delaiMs: 60000, sel: 'essai' });
K.note('demande402', { outil: 'scan_token', canal: 'rest', qui: 'ip1', sorte: 'sonde:x402scan' });
K.note('demande402', { outil: 'scan_token', canal: 'rest', qui: 'ip1', sorte: 'sonde:x402scan' });
K.note('demande402', { outil: 'ask_agent', canal: 'rest', qui: 'ip2', sorte: 'demande:python' });
K.note('refus_sans_cle', { outil: 'scan_token', canal: 'mcp', qui: 'ip3', sorte: 'claude' });
K.note('demande402', { outil: 'scan_token', canal: 'rest', qui: 'ip4', sorte: 'Mozilla/5.0 <script>' });
const j = K.publique(1).parJour[0].evenements;
ok(j.demande402.sortes['sonde:x402scan'].n === 2 && j.demande402.sortes['demande:python'].n === 1 && j.refus_sans_cle.sortes.claude.n === 1,
   'les demandes de prix se lisent : sonde ou demande, et la famille du client');
ok(!JSON.stringify(j).includes('Mozilla') && !JSON.stringify(j).includes('<script>') && j.demande402.sortes.other.n === 1, 'un texte libre devient « other » : jamais publie tel quel');
ok(!JSON.stringify(K.publique(1)).match(/ip1|ip2|ip3/), 'jamais l IP ni son empreinte');
fs.rmSync(d, { recursive: true, force: true });

const x = fs.readFileSync(path.join(__dirname, 'x402.js'), 'utf8'), srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
ok(/sorte: \(sonde \? 'sonde' : 'demande'\) \+ \(client \? ':' \+ client : ''\)/.test(x), 'x402 compte chaque 402 avec la famille de son client');
ok((srv.match(/require\('\.\/famille_client'\)\.famille\(req\.headers\['user-agent'\]\)/g) || []).length === 5, 'REST, MCP, refus sans cle, eSIM et credit portent la famille du client');

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
