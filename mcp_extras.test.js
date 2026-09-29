'use strict';
/* mcp_extras.js dans le serveur MCP : l'eSIM (gratuite, sans cle) et la passerelle de depense
   (une cle, une idempotency_key) listees a cote des outils de lecture ; la consigne dit
   l'exception a « rien n'achete ». */
const M = require('./agentic_mcp');
const X = require('./mcp_extras');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

(async () => {
  const vus = { paie: [], plans: [] };
  let boutiqueOuverte = true, paiements = true;
  const extras = X.cree({ api: 'https://srv',
    boutique: () => ({ actif: () => boutiqueOuverte, plans: async (a) => { vus.plans.push(a); return { ok: true, destination: 'France', compatibility: 'https://c',
      plans: [{ plan: 'eu-1gb', name: 'Europe 1GB', covers: 'Region of 33 countries', gb: 1, days: 7, priceUsd: 1.6 }] }; } }),
    passerelle: () => ({ paie: async (cle, a, idem) => { vus.paie.push({ cle, a, idem }); return { code: 200, corps: { ok: true, resultat: '{"price":119}', recu: { usd: 0.001, factureUsd: 0.0011, tx: '5Tx' }, audit: { seq: 4, h: 'ab' } } }; },
      audit: (addr, id) => ({ ok: true, lignes: [{ t: 0, statut: 'paye', hote: 'x402factory.ai', usd: 0.001, tx: '5Tx' }], chaine: { ok: true, lignes: 4 } }) }),
    paiementsActifs: () => paiements });
  const agentic = { appelle: async () => ({ ok: false, code: 404, raison: 'unknown tool' }) };
  const rpc = async (corps, cle) => JSON.parse((await M.traite({ methode: 'POST', entetes: {}, corps: JSON.stringify(Object.assign({ jsonrpc: '2.0', id: 1 }, corps)), cle: cle || null, clePresentee: !!cle, qui: 'ip', origines: [] },
    { agentic, actifs: () => ({}), api: 'https://srv', extras })).corps);

  console.log('\n-- la liste et la consigne --');
  const noms = (await rpc({ method: 'tools/list' })).result.tools.map((t) => t.name);
  ok(['find_esim_plans', 'pay_service', 'payment_audit'].every((x) => noms.includes(x)) && noms.includes('scan_token'), 'les trois outils a cote des outils de lecture');
  const pay = (await rpc({ method: 'tools/list' })).result.tools.find((t) => t.name === 'pay_service');
  ok(pay.annotations.readOnlyHint === false && pay.annotations.destructiveHint === false && pay.inputSchema.required.join() === 'url,idempotency_key', 'pay_service : pas en lecture seule (dit), url et idempotency_key requises');
  const ins = (await rpc({ method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result.instructions;
  ok(/Read-only except pay_service/.test(ins) && /turned payments on/.test(ins) && !/Read-only: nothing here buys/.test(ins), 'la consigne nomme la seule exception a « rien n achete »');
  paiements = false; boutiqueOuverte = false;
  const n2 = (await rpc({ method: 'tools/list' })).result.tools.map((t) => t.name);
  ok(!n2.includes('pay_service') && !n2.includes('find_esim_plans') && /Read-only: nothing here buys/.test((await rpc({ method: 'initialize', params: {} })).result.instructions), 'modules eteints : outils absents, consigne d avant');
  paiements = true; boutiqueOuverte = true;

  console.log('\n-- les appels --');
  const e = (await rpc({ method: 'tools/call', params: { name: 'find_esim_plans', arguments: { country: 'France' } } })).result;
  ok(!e.isError && /Europe 1GB \(covers Region of 33 countries\) - 1 GB, 7 days - \$1\.6 - plan id: eu-1gb/.test(e.content[0].text) && /\/esim\/buy/.test(e.content[0].text), 'find_esim_plans sans cle : les forfaits et comment acheter');
  const sans = (await rpc({ method: 'tools/call', params: { name: 'pay_service', arguments: { url: 'https://a.b/c', idempotency_key: 'k-12345678' } } })).result;
  ok(sans.isError && /send your API key/.test(sans.content[0].text) && !vus.paie.length, 'pay_service sans cle : refuse, rien paye');
  const CLE = { h: 'h', id: 'abc123def456', addr: '0xabc' };
  const p = (await rpc({ method: 'tools/call', params: { name: 'pay_service', arguments: { url: 'https://x402factory.ai/solana/coinprice', idempotency_key: 'k-12345678', query: { symbol: 'SOL' } } } }, CLE)).result;
  ok(!p.isError && vus.paie[0].cle === CLE && vus.paie[0].idem === 'k-12345678' && vus.paie[0].a.query.symbol === 'SOL' && /paid \$0\.001, billed \$0\.0011 in \$SWOGE, transaction 5Tx, audit line 4/.test(p.content[0].text),
     'pay_service avec la cle : la passerelle, son idempotency_key, la reponse et le recu');
  const a = (await rpc({ method: 'tools/call', params: { name: 'payment_audit', arguments: {} } }, CLE)).result;
  ok(!a.isError && /paye x402factory\.ai \$0\.001 tx 5Tx/.test(a.content[0].text) && /intact \(4 lines\)/.test(a.content[0].text), 'payment_audit : les lignes et l etat de la chaine');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
