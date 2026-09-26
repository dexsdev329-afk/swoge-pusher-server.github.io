'use strict';
/*
 * SE FAIRE TROUVER (decouverte.js) — ce que lisent les annuaires d'agents,
 * d'après les spécifications relues le 26 septembre 2026 :
 *   1. /openapi.json : OpenAPI 3.1, info.x-guidance, x-payment-info en $
 *      DÉCIMAUX (pas en unités atomiques), un outil par chemin avec son schéma ;
 *   2. la preuve de propriété : une signature EIP-191 de l'origine NUE par la
 *      trésorerie — une fausse, une autre origine, un autre signataire sont écartés ;
 *   3. /.well-known/x402 : { version 1, x402Version 2, resources, ownershipProofs } ;
 *   4. la fiche du registre MCP : les contraintes du schéma server.json 2025-12-11.
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const { ethers } = require('ethers');
const D = require('./decouverte');
const A = require('./agentic');

(async () => {
  const BASE = 'https://api.example.dog';
  const tresor = ethers.Wallet.createRandom();
  const outils = A.definitions({ recherche: true });
  const prixX402 = { scan_token: { min: 0.02, max: 0.16 }, swoge_economy: { min: 0.02, max: 0.02 }, generate_image: { min: 0.09, max: 2.4 } };
  const x402 = { actif: true, network: 'eip155:4663', assets: [{ symbol: 'USDG', assetTransferMethod: 'eip3009' }, { symbol: 'SWOGE', assetTransferMethod: 'permit2' }] };

  console.log('-- 1. /openapi.json --');
  const doc = D.openapi({ base: BASE, outils, x402, prixX402, preuves: [], page: 'https://site/swogeagentic.html', docs: 'https://site/docs' });
  ok(doc.openapi === '3.1.0' && doc.info.title && doc.info.version && doc.info['x-guidance'] && doc.paths, 'les champs obligatoires : openapi, info.title, info.version, info.x-guidance, paths');
  ok(/PAYMENT-SIGNATURE/.test(doc.info['x-guidance']) && /SAME arguments/.test(doc.info['x-guidance']) && /USDG via eip3009/.test(doc.info['x-guidance']), 'x-guidance dit comment payer, avec quels jetons, et de garder les memes arguments');
  eq(doc.servers[0].url, BASE, 'servers : l adresse de l API');
  ok(outils.every((o) => doc.paths['/agentic/call/' + o.name] && doc.paths['/agentic/call/' + o.name].post), 'chaque outil du catalogue a son chemin (' + outils.length + ')');
  const st = doc.paths['/agentic/call/scan_token'].post;
  ok(st.requestBody.content['application/json'].schema.properties.arguments.properties.address && st.requestBody.content['application/json'].schema.required.includes('arguments'),
     'le corps : `arguments` avec le schema d entree de l outil');
  ok(JSON.stringify(st['x-payment-info'].protocols) === '[{"x402":{}}]' && st['x-payment-info'].price.mode === 'dynamic' && st['x-payment-info'].price.min === '0.020000' && st['x-payment-info'].price.currency === 'USD',
     'x-payment-info : protocole x402, prix en DOLLARS decimaux (0.020000), intervalle quand le gaz le fait bouger');
  eq(JSON.stringify(doc.paths['/agentic/call/swoge_economy'].post['x-payment-info'].price), '{"mode":"fixed","currency":"USD","amount":"0.020000"}', 'un prix qui ne bouge pas : mode fixed');
  ok(!doc.paths['/agentic/call/ask_agent'].post['x-payment-info'] && !doc.paths['/agentic/call/generate_video'].post['x-payment-info'], 'agent et video : pas de x-payment-info (cle seulement)');
  ok(st.responses['402'] && st.security.some((x) => !Object.keys(x).length), 'le 402 est documente, et l appel sans cle est permis pour un outil payable');
  ok(!D.openapi({ base: BASE, outils, x402: null, prixX402: {} }).paths['/agentic/x402'] && !/PAYMENT-SIGNATURE/.test(D.openapi({ base: BASE, outils, x402: null, prixX402: {} }).info['x-guidance']),
     'x402 eteint : l OpenAPI ne promet aucun paiement sans cle');

  console.log('\n-- 2. la preuve de propriete --');
  const orig = D.origine(BASE + '/agentic/call/scan_token?x=1');
  eq(orig, BASE, 'l origine NUE : sans chemin, sans barre finale');
  const bonne = await tresor.signMessage(BASE);
  const autreOrigine = await tresor.signMessage(BASE + '/');
  const autreSignataire = await ethers.Wallet.createRandom().signMessage(BASE);
  const v = D.preuvesValides([bonne, autreOrigine, autreSignataire, '0xdeadbeef', ''].join(','), orig, tresor.address);
  ok(v.length === 1 && v[0] === bonne, 'seule la signature de l origine par la TRESORERIE est gardee (autre origine, autre signataire, charabia : ecartes)');
  eq(D.preuvesValides(undefined, orig, tresor.address).length, 0, 'sans X402_PREUVE : aucune preuve (rien d invente)');
  const avec = D.openapi({ base: BASE, outils, x402, prixX402, preuves: v });
  eq(JSON.stringify(avec['x-discovery']), JSON.stringify({ ownershipProofs: [bonne] }), 'l OpenAPI porte x-discovery.ownershipProofs quand la preuve est juste');

  console.log('\n-- 3. /.well-known/x402 --');
  const m = D.manifeste({ base: BASE, prixX402, preuves: v, docs: 'https://site/docs' });
  ok(m.version === 1 && m.x402Version === 2 && Array.isArray(m.resources), 'la forme lue par x402scan : version 1, x402Version 2, resources');
  eq(m.resources.join(','), [BASE + '/agentic/call/scan_token', BASE + '/agentic/call/swoge_economy', BASE + '/agentic/call/generate_image'].join(','), 'les ressources : les outils payables d avance, en URL absolues');
  ok(m.ownershipProofs[0] === bonne && !('ownershipProofs' in D.manifeste({ base: BASE, prixX402, preuves: [] })), 'la preuve y est quand elle existe, absente sinon');

  console.log('\n-- 4. la fiche du registre MCP (server.json) --');
  const f = D.ficheMcp({ nom: 'io.github.dexsdev329-afk/swogeagentic', base: BASE });
  ok(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(f.name) && f.name.length <= 200, 'name : forme reverse-DNS avec une seule barre (motif du schema)');
  ok(f.description.length >= 1 && f.description.length <= 100 && f.title.length <= 100, 'description ≤ 100 caracteres (' + f.description.length + '), title ≤ 100');
  ok(f.name && f.description && f.version && f.$schema === 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', 'les champs requis (name, description, version) et le schema 2025-12-11');
  const r = f.remotes[0];
  ok(r.type === 'streamable-http' && r.url === BASE + '/mcp' && r.headers[0].name === 'Authorization' && r.headers[0].isSecret === true && r.headers[0].isRequired === true,
     'remote streamable-http sur /mcp, en-tete Authorization secret et requis');

  /* La fiche publiee dans le depot (celle que `mcp-publisher publish` lit) ne vieillit pas en silence. */
  const fs = require('fs');
  const depot = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'server.json'), 'utf8'));
  eq(JSON.stringify(depot), JSON.stringify(D.ficheMcp({ nom: 'io.github.dexsdev329-afk/swogeagentic', base: 'https://web-production-220a3.up.railway.app' })),
     'server.json du depot = la fiche generee (sinon : la regenerer avec decouverte.ficheMcp)');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
