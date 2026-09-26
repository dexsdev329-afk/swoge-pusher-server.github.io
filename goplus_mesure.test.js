'use strict';
/*
 * GOPLUS : CE QU'IL NOUS COUTE VRAIMENT — demande du proprietaire, 26 septembre
 * 2026 : « eviter de gaspiller des jetons GoPlus en n'analysant pas plusieurs
 * fois le meme jeton dans un temps court ». Rien ne change aux decisions ; on
 * mesure, et on supprime le seul gaspillage sans risque :
 *   1. deux lectures SIMULTANEES du meme jeton : un seul appel reseau ;
 *   2. une lecture servie par le cache n'est plus comptee comme un appel ;
 *   3. le delai premier silence → premiere vraie reponse est range par tranche.
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-'));
process.env.AI_COLONIE = '0';
delete process.env.GOPLUS_APP_KEY; delete process.env.GOPLUS_APP_SECRET;

const appels = [];
let connu = false;
global.fetch = async (url) => {
  appels.push(String(url));
  await new Promise((r) => setTimeout(r, 30));
  const addr = String(url).split('contract_addresses=')[1];
  const res = connu ? { [addr]: { is_honeypot: '0', holder_count: '120', is_open_source: '1', buy_tax: '0', sell_tax: '0', holders: [] } } : { [addr]: {} };
  return { ok: true, status: 200, json: async () => ({ code: 1, result: res }), text: async () => '' };
};
const C = require('./ai_colonie');
const cpt = () => C.vue().compteurs || {};
const tok = (a) => ({ addr: a, pool: '0xpool', lu: {}, appels: 0 });

(async () => {
  console.log('-- 1. deux lectures simultanees : un seul appel --');
  const A = '0x' + 'a1'.repeat(20);
  const avant = appels.length, r0 = cpt().goplusReseau || 0;
  const [t1, t2] = [tok(A), tok(A)];
  await Promise.all([C._lisGoplus(t1), C._lisGoplus(t2)]);
  eq(appels.length - avant, 1, 'un seul appel GoPlus pour deux lectures simultanees du meme jeton');
  ok(t1.g && t2.g && t1.g.have === t2.g.have, 'les deux lecteurs ont la meme reponse');
  eq((cpt().goplusReseau || 0) - r0, 1, 'goplusReseau compte l appel reseau, une fois');

  console.log('\n-- 2. le cache n est pas un appel --');
  const c0 = cpt().goplusCache || 0, a1 = appels.length;
  await C._lisGoplus(tok(A));
  ok(appels.length === a1 && (cpt().goplusCache || 0) - c0 >= 1, 'relu dans les 8 minutes du silence : cache, aucun appel reseau');

  console.log('\n-- 3. le delai premier silence -> premiere vraie reponse --');
  ok(C._goplusSilences.has(A), 'le premier silence est date');
  eq((cpt().goplusReseauMuet || 0) >= 1, true, 'goplusReseauMuet compte les appels revenus sans rien');
  C._goplusSilences.set(A, Date.now() - 40 * 60e3);        /* le silence date de 40 min */
  delete C._cacheGoplus()[A];                               /* le cache du silence a expire */
  connu = true;
  const t3 = tok(A);
  await C._lisGoplus(t3);
  ok(t3.g.have === true && (cpt()['goplusConnuApres_30-60min'] || 0) === 1 && !C._goplusSilences.has(A), 'connu 40 min apres son premier silence : range en 30-60 min, silence oublie');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
