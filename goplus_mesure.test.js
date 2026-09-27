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
/* Le code que GoPlus met dans le CORPS d'une reponse HTTP 200 (27/09) :
   1 = reussite, 2 = fiche partielle, 2021 = inconnu, 4029 = trop de
   requetes, 4012 = signature refusee. */
let codeCorps = 1;
global.fetch = async (url) => {
  appels.push(String(url));
  await new Promise((r) => setTimeout(r, 30));
  const addr = String(url).split('contract_addresses=')[1];
  const res = connu ? { [addr]: { is_honeypot: '0', holder_count: '120', is_open_source: '1', buy_tax: '0', sell_tax: '0', holders: [] } } : { [addr]: {} };
  /* 2 = « Partial data obtained » : la fiche est la, incomplete (table GoPlus
     relue le 27/09/2026) ; 2021 = « No info for this contract ». */
  const corps = codeCorps === 1 ? { code: 1, result: res }
    : codeCorps === 2 ? { code: 2, message: 'Partial data obtained', result: { [addr]: { is_honeypot: '1', sell_tax: '0.9', holder_count: '12', is_open_source: '1' } } }
    : codeCorps === 2021 ? { code: 2021, message: 'No info for this contract', result: {} }
    : { code: codeCorps, message: codeCorps === 4029 ? 'too many requests' : 'signature verification failure', result: {} };
  return { ok: true, status: 200, json: async () => corps, text: async () => '' };
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

  console.log('\n-- 4. le code du corps : seul 1 est une reussite, une erreur n est pas un jeton inconnu --');
  {
    const B = '0x' + 'b2'.repeat(20);
    const v0 = cpt();
    const muet0 = v0.goplusReseauMuet || 0, err0 = v0.goplusErreur || 0;
    const serv0 = (C.vue().services.find((x) => x.cle === 'goplus') || {});
    codeCorps = 4029;
    const tb = tok(B);
    await C._lisGoplus(tb);
    const v1 = cpt();
    eq(v1.goplusCode_4029, 1, 'un 200 qui porte code 4029 est compte sous son code');
    eq((v1.goplusErreur || 0) - err0, 1, 'et compte comme une erreur');
    eq((v1.goplusReseauMuet || 0) - muet0, 0, 'PAS comme « GoPlus ne connait pas le jeton »');
    ok(!C._goplusSilences.has(B), 'aucun silence n est date : une erreur ne dit rien du jeton');
    ok(tb.g.have === false && /code 4029 too many requests/.test(tb.g.erreur || ''), 'sans fiche, le Warden se tait comme avant, et l erreur est gardee : « ' + tb.g.erreur + ' »');
    const serv1 = C.vue().services.find((x) => x.cle === 'goplus');
    ok(serv1.reussites === (serv0.reussites || 0) && serv1.essais === (serv0.essais || 0) + 1 && /4029/.test(serv1.dernierEchec || ''),
       'le service compte un ECHEC, plus une « reussite » : ' + JSON.stringify({ essais: serv1.essais, reussites: serv1.reussites, dernier: serv1.dernierEchec }));
    ok((C._cacheGoplus()[B] || {}).ttl === C.TTL_GOPLUS_MUET, 'et il se relit au meme delai qu un silence (8 min) : rien ne change pour la decision');
    delete C._cacheGoplus()[B];
    codeCorps = 4012;
    await C._lisGoplus(tok(B));
    eq(cpt().goplusCode_4012, 1, 'un 4012 (signature) a son propre compteur');
    delete C._cacheGoplus()[B];
    codeCorps = 1; connu = false;
    await C._lisGoplus(tok(B));
    ok((cpt().goplusCode_1 || 0) >= 1 && (cpt().goplusReseauMuet || 0) - muet0 === 1 && C._goplusSilences.has(B),
       'code 1 avec une fiche vide : ca, c est un jeton que GoPlus ne connait pas (silence date)');
    const g = C.vue().goplus;
    ok(g.codes['4029'] === 1 && g.codes['4012'] === 1 && g.erreurs === (err0 + 2), 'la vue expose les codes par valeur : ' + JSON.stringify(g.codes));
  }

  console.log('\n-- 5. code 2 (fiche partielle) : lue, le Warden refuse toujours le pot de miel --');
  {
    /* Revue du 27/09/2026 : jeter le code 2 donnait have=false sur un jeton
       que GoPlus signale pot de miel a 90 % de taxe — le Warden se taisait. */
    const D = '0x' + 'd4'.repeat(20);
    const v0 = cpt(), err0 = v0.goplusErreur || 0, muet0 = v0.goplusReseauMuet || 0;
    codeCorps = 2;
    const td = tok(D);
    await C._lisGoplus(td);
    eq(cpt().goplusCode_2, 1, 'le code 2 garde son propre compteur');
    ok(td.g.have === true && td.g.honeypot === true && td.g.sellTax === 90 && !td.g.erreur,
       'la fiche partielle est lue : ' + JSON.stringify({ have: td.g.have, honeypot: td.g.honeypot, sellTax: td.g.sellTax, erreur: td.g.erreur }));
    eq(C.vetoWarden(td), 'honeypot', 'et le Warden refuse le pot de miel, comme avant le 27/09');
    eq((cpt().goplusErreur || 0) - err0, 0, 'un code 2 n est pas une erreur');
    eq((cpt().goplusReseauMuet || 0) - muet0, 0, 'ni un silence');
    eq((C._cacheGoplus()[D] || {}).ttl, C.TTL_GOPLUS_MUET, 'et il se relit au delai court : la fiche complete arrive « dans ~15 s »');

    console.log('\n-- 6. code 2021 (« No info for this contract ») : un silence, pas une erreur --');
    const E2 = '0x' + 'e5'.repeat(20);
    codeCorps = 2021;
    const te = tok(E2);
    await C._lisGoplus(te);
    ok(te.g.have === false && !te.g.erreur, 'aucune fiche, aucune erreur');
    eq((cpt().goplusErreur || 0) - err0, 0, 'goplusErreur ne bouge pas');
    eq((cpt().goplusReseauMuet || 0) - muet0, 1, 'compte comme un silence');
    ok(C._goplusSilences.has(E2), 'et le silence est date');
    codeCorps = 1;
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
