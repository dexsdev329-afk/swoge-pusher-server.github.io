'use strict';
/* store_agents.js : les fiches de l'Agent Store. Seul ce qui est MESURE : l'usage des agents
   EXTERIEURS (nos essais exclus), aucune reussite sous 10 tentatives, des permissions et des
   facons de payer vraies (Solana seulement ou elle est vendue), rien d'invente. */
const fs = require('fs');
const path = require('path');
const S = require('./store_agents');
const D = require('./decouverte');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };
const c = (ext, maison) => ({ n: ext + (maison || 0), usd: 0, exterieur: { n: ext, usd: ext * 0.02 }, maison: { n: maison || 0, usd: 0 } });

const catalogue = { outils: [
  { name: 'scan_token', description: 'Use this before buying an EVM token, to check its market and its contract in one call. More text.', prix: { usd: 0.02, swoge: '714' },
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'The token contract (0x...).' } }, required: ['address'] } },
  { name: 'ask_agent', description: 'Use this for a research task that needs several tools.', prix: { variable: true, maxUsd: 1.34, note: 'real cost' }, inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'video_status', description: 'Use this to poll a video.', prix: { usd: 0, gratuit: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'generate_image', description: 'Use this to create an image.', prix: { variable: true, maxUsd: 0.2 }, inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }] };
const compteurs = { outils: {
  scan_token: { demande402: c(300), paye_x402: c(9, 40), paye_cle: c(3), echec: c(2, 5) },
  ask_agent: { demande402: c(20), paye_x402: c(2), echec: c(1) } } };
const f = S.fiches({ catalogue, compteurs, x402Payable: (x) => x !== 'video_status', solana: (x) => x !== 'ask_agent', etiquettes: D.ETIQUETTES_OUTIL, api: 'https://api', page: 'https://site/swogeagentic.html' });
const par = (x) => f.find((a) => a.name === x);

ok(f.length === 4 && par('scan_token').id === 'swoge:scan_token' && par('scan_token').owner.name === 'SWOGE', 'une fiche par outil, un identifiant, un proprietaire');
ok(par('scan_token').summary === 'Use this before buying an EVM token, to check its market and its contract in one call.', 'le resume : la premiere phrase de la description');
ok(par('scan_token').capabilities.includes('Crypto') && par('generate_image').capabilities.join() === 'Image', 'les capacites viennent des etiquettes de decouverte');
ok(par('scan_token').price.usd === 0.02 && par('ask_agent').price.variable && par('ask_agent').price.maxUsd === 1.34 && par('video_status').price.free, 'le prix : fixe, au cout reel avec son maximum, ou gratuit');
ok(par('scan_token').input[0].name === 'address' && par('scan_token').input[0].required, 'l entree et ses champs requis');
const u = par('scan_token').usage;
ok(u.paidCalls === 12 && u.attemptsWithoutResult === 2 && u.priceQuotes === 300, 'l usage : agents EXTERIEURS seulement (40 paiements et 5 echecs maison ecartes)');
ok(u.verdict === 'completed 12 of 14 paid attempts (85.7%)', 'au-dela de 10 tentatives : la part aboutie, avec son effectif');
ok(par('ask_agent').usage.verdict === 'not enough paid calls yet (3/10)' && par('generate_image').usage.verdict === 'not enough paid calls yet (0/10)', 'sous 10 tentatives : aucun taux, l effectif seulement');
/* 29/09 : le journal relu avec la maison d'aujourd'hui remplace le compteur x402 fige. Mesure : 24 paiements
   comptes exterieurs le 27/09 etaient notre portefeuille d'inscription. Le compteur de cle reste. */
const fj = S.fiches({ catalogue, compteurs, x402Payable: () => true, etiquettes: D.ETIQUETTES_OUTIL, api: 'https://api', page: 'https://p', x402Journal: { ask_agent: { n: 1, usd: 0.5 } } });
const uj = fj.find((a) => a.name === 'scan_token').usage, ua = fj.find((a) => a.name === 'ask_agent').usage;
ok(uj.paidCalls === 3 && uj.paidUsd === 0.06 && ua.paidCalls === 1 && ua.paidUsd === 0.5,
   'avec le journal : les 9 paiements x402 « exterieurs » du compteur ne comptent plus (le journal n en voit aucun), les 3 appels par cle restent');
ok(par('scan_token').permissions[0] === 'read-only: never buys, sells or signs' && /creates images/.test(par('generate_image').permissions.join()) && par('scan_token').permissions.length === 1,
   'les permissions : lecture seule pour tous, et ce que certains font de plus');
ok(/USDC on Base or Solana/.test(par('scan_token').payment[0]) && /USDC on Base, or USDG/.test(par('ask_agent').payment[0]) && !/x402/.test(par('video_status').payment.join()),
   'les facons de payer : Solana seulement ou elle est vendue, pas de x402 pour un outil non payable');
ok(par('scan_token').payment.some((p) => /dollar credit/.test(p)) && par('scan_token').endpoints.rest === 'https://api/agentic/call/scan_token', 'la cle (credit ou $SWOGE), le MCP, les adresses d appel');
ok(!JSON.stringify(f).match(/reputation|rating|stars/i), 'aucune note ni reputation inventee');

const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
ok(/path === '\/agentic\/store'/.test(srv) && /compteurs\.publique\(30\)/.test(srv.slice(srv.indexOf("if (path === '/agentic/store')"))) && /Date\.now\(\) - STORE\.t > 60000/.test(srv), 'la route : les compteurs des 30 jours, 60 s en cache');

{ const r = srv.slice(srv.indexOf("if (path === '/agentic/store')"), srv.indexOf("if (path === '/agentic/x402')"));
  ok(/P\.preuves\(lignesX, \(a\) => mz\.has\(a\)\)/.test(r) && /P\.usageParOutil\(lignesX, \(a\) => mz\.has\(a\), Date\.parse\(cpt\.depuis/.test(r)
     && /new Set\(adressesMaison\(\)\)/.test(r) && /mz\.add\(xv\.porteGaz\.toLowerCase\(\)\)/.test(r),
     'les paiements verifiables (29/09) : le journal x402, la maison ET le portefeuille de gaz ecartes, comme dans les compteurs'); }
ok(/r && r\.catalogue > 0 \? r : null/.test(srv), 'catalogue pas encore relu (apres un demarrage) : pas de resume, jamais « 0 service »');

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
