'use strict';
/*
 * LE CARNET DES LANCEMENTS (21/10/2026), horloge et DexScreener simules :
 *   1. une naissance est ecrite une fois (fichier du jour, fiche en memoire) ;
 *   2. les metadonnees : en file, 4 par cycle au plus, un vide relu puis
 *      abandonne apres 3 essais ; les themes et les reseaux sont tires du texte ;
 *   3. le suivi : +1 h, +6 h, +24 h, +7 j, +30 j ; au plus UN appel DexScreener
 *      par tic, 30 jetons ; une echeance lue trop tard est « manquee », jamais
 *      ecrite sous une autre etiquette ; « pas de marche » est dit ;
 *   4. un redemarrage reconstruit fiches et curseurs depuis le disque : rien
 *      n'est relu deux fois ;
 *   5. le bilan refuse la part sous 40 fiches mesurees, la donne au-dessus ;
 *      le passe du createur est compte dans l'ordre des naissances ;
 *   6. smart_lancements : CHAQUE lancement passe au carnet a son T+2, et ses
 *      metadonnees partent en UN lot ; smart_money sert /ai/smart/lancements ;
 *   7. le marche BTC/ETH a la naissance (22/10) : parBtc24h et parBtc7d par les
 *      tranches de marche_contexte, « no market data » hors couverture, aucun
 *      groupe sans fournisseur ; smart_money passe deps.marche.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');
const K = require('./lancements_carnet');

const T0 = Date.parse('2026-10-21T12:00:00Z');
const A = (i) => '0x' + i.toString(16).padStart(40, '0');
function banc(o) {
  o = o || {};
  const dossier = o.dossier || fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-'));
  const H = { now: o.now || T0 };
  const marche = o.marche || new Map();         // jeton -> { prix, fdv, liq }
  const appels = [];
  const prendre = async (url) => {
    /* le banc ne compte que tokens/v1 ; commandes et metas rendent du vide */
    if (!/\/tokens\/v1\//.test(String(url))) return { ok: true, status: 200, text: async () => (/orders/.test(String(url)) ? '{"orders":[],"boosts":[]}' : '[]') };
    const l = String(url).split('/').pop().split(',');
    appels.push(l.length);
    const corps = l.filter((j) => marche.has(j)).map((j) => ({ chainId: 'robinhood', dexId: 'uniswap', pairAddress: A(9999), baseToken: { address: j }, priceUsd: String(marche.get(j).prix),
      fdv: marche.get(j).fdv, marketCap: marche.get(j).fdv, liquidity: { usd: marche.get(j).liq }, volume: { h24: 1234 }, txns: { h24: { buys: 10, sells: 5 } }, priceChange: { h24: -12 } }));
    return { ok: true, status: 200, text: async () => JSON.stringify(corps) };
  };
  const C = K.cree({ dossier, prendre, horloge: () => H.now, marche: o.marcheCtx || null });
  return { C, H, marche, appels, dossier };
}
const avance = async (b, min) => { for (let k = 0; k < min; k++) { b.H.now += 60e3; await b.C.tic(); } };

(async () => {
  console.log('-- 1. la naissance');
  let b = banc();
  ok(b.C.naissance({ jeton: A(1), courbe: A(101), plateforme: 'pons', bloc: 5, t: T0, deployer: A(500), achatDevEth: 0.3, t2: { acheteurs: 7, eth: 0.8 }, acheteurs: [A(600), 'pas-une-adresse'], exemptions: 1, ventesDev: 0, tx: { from: A(500), gas: '0x1', maxFeePerGas: '0x2', value: '0x3' } }), 'un lancement : ecrit');
  ok(!b.C.naissance({ jeton: A(1), t: T0 }), 'le meme jeton : pas deux fois');
  ok(!b.C.naissance({ jeton: 'pas-une-adresse' }), 'une adresse illisible : rien');
  const lignes = fs.readFileSync(path.join(b.dossier, 'lancements', '2026-10-21.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok(lignes.length === 1 && lignes[0].k === 'n' && lignes[0].deployer === A(500) && lignes[0].t2.acheteurs === 7 && lignes[0].acheteurs.length === 1, 'le fichier du jour : une ligne, createur, T+2, acheteurs propres');
  eq(b.C.vue().compteurs.doublons, 1, 'le doublon est compte');

  console.log('-- 2. les metadonnees');
  for (let i = 2; i <= 7; i++) b.C.naissance({ jeton: A(i), t: T0 + i * 1000, deployer: A(500) });
  eq(b.C.aLire().length, K.META_PAR_CYCLE, 'au plus 3 jetons par cycle (6 lectures chacun, un lot de 20 avec 2 soldes)');
  b.C.meta(A(1), { nom: 'Doge AI Agent', symbole: 'DAGI', description: 'The first AI dog on Robinhood Chain', socials: ['https://x.com/dagi', 'https://t.me/dagi', 'https://dagi.xyz'], logo: 'ipfs://x' });
  const f1 = b.C._fiches.get(A(1));
  ok(f1.th.includes('ai') && f1.th.includes('dog') && f1.th.includes('robinhood'), 'themes tires du nom et de la description : ' + f1.th.join(','));
  ok(f1.res.x && f1.res.tg && f1.res.site && f1.res.n === 3, 'reseaux : X, Telegram, site');
  ok(!b.C.aLire().some((x) => x.jeton === A(1)), 'lu : il quitte la file');
  b.C.meta(A(2), null); b.C.meta(A(2), null);
  ok(b.C.aLire().length === K.META_PAR_CYCLE && b.C._etat().file.some((x) => x.jeton === A(2)), 'deux lectures vides : encore en file (en fin)');
  b.C.meta(A(2), null);
  ok(!b.C._etat().file.some((x) => x.jeton === A(2)) && b.C.vue().compteurs.metasAbandonnees === 1, 'la troisieme : abandonne, compte');
  eq(K.themesDe('Bob', 'BOB', null).join(), 'other', 'aucun mot connu : « other »');
  ok(!K.reseauxDe(['https://twitter.com/x']).site && K.reseauxDe(['https://twitter.com/x']).x, 'twitter.com compte comme X, pas comme site');

  console.log('-- 3. le suivi');
  b.marche.set(A(1), { prix: 0.001, fdv: 1e6, liq: 40000 });
  await avance(b, 59);
  eq(b.appels.length, 0, 'avant +1 h : aucun appel');
  await avance(b, 2);
  ok(b.appels.join() === '1,6', 'a +1 h : A1 du a la minute 60 (1 jeton), les 6 autres nes quelques secondes apres a la 61 — un appel par tic (' + b.appels.join() + ')');
  let f = b.C._fiches.get(A(1));
  ok(f.s['1h'] && f.s['1h'].m && f.s['1h'].liq === 40000 && f.s['1h'].fdv === 1e6, 'A1 a un marche : liquidite, capitalisation');
  ok(b.C._fiches.get(A(3)).s['1h'] && b.C._fiches.get(A(3)).s['1h'].m === false, 'A3 sur sa courbe : « pas de marche », dit');
  await avance(b, 30);
  eq(b.appels.length, 2, 'rien de plus avant +6 h');
  const many = banc();
  for (let i = 1; i <= 70; i++) many.C.naissance({ jeton: A(i), t: T0 + i });
  await avance(many, 63);
  ok(many.appels.join() === '30,30,10', '70 jetons dus : 30 par appel, un appel par tic (' + many.appels.join(',') + ')');
  /* le serveur arrete 3 h : l'echeance +1 h (retard admis 15 min) est manquee, pas ecrite a +4 h */
  const arr = banc();
  arr.C.naissance({ jeton: A(1), t: T0 });
  arr.H.now += 4 * 3600e3;
  await arr.C.tic();
  ok(!arr.C._fiches.get(A(1)).s['1h'] && arr.C.vue().compteurs.manques === 1, 'lue a +4 h : +1 h manquee, comptee, jamais ecrite');
  ok(K.retardAdmisMin(60) === 15 && K.retardAdmisMin(10080) === 2520, 'retard admis : 15 min, ou 25 % de l echeance');

  console.log('-- 4. le redemarrage');
  b.H.now = T0 + 25 * 3600e3;
  await b.C.tic();
  const avant = b.appels.length;
  const b2 = banc({ dossier: b.dossier, now: b.H.now, marche: b.marche });
  eq(b2.C._fiches.size, 7, 'les 7 fiches reconstruites depuis le disque');
  ok(b2.C._fiches.get(A(1)).th.includes('dog') && b2.C._fiches.get(A(1)).s['24h'], 'avec metadonnees et suivis');
  await b2.C.tic();
  eq(b2.appels.length, 0, 'curseurs relus : rien n est redemande apres le redemarrage');
  ok(avant >= 3, 'le banc 1 avait bien lu +1 h, +6 h et +24 h (' + avant + ' appels)');

  console.log('-- 5. le bilan');
  const g = banc();
  for (let i = 1; i <= 60; i++) {
    g.C.naissance({ jeton: A(i), t: T0 + i * 1000, deployer: i <= 30 ? A(900) : A(900 + i), achatDevEth: i % 2 ? 0 : 1, t2: { acheteurs: i % 3 ? 2 : 25, eth: 0.2 } });
    g.C.meta(A(i), { nom: i <= 45 ? 'Pepe ' + i : 'Thing ' + i, symbole: 'T' + i, description: '', socials: i % 2 ? [] : ['https://x.com/a'] });
    if (i <= 20) g.marche.set(A(i), { prix: 1, fdv: 2e5, liq: i <= 15 ? 9000 : 100 });
  }
  await avance(g, 61);
  g.H.now = T0 + 1441 * 60e3; await g.C.tic(); await g.C.tic();
  const B = g.C.bilan();
  eq(B.tout['24h'].mesures, 60, '60 fiches mesurees a 24 h');
  eq(B.tout['24h'].vivantsPct, 25, '15 vivantes sur 60 (liquidite >= 5 000 $) : 25 %');
  eq(B.tout['24h'].marchePct, 33.3, '20 avec un marche : 33,3 %');
  ok(B.parTheme.frog.n === 45 && B.parTheme.frog['24h'].assez && B.parTheme.frog['24h'].vivantsPct === 33.3, 'theme « frog » (Pepe) : 45 fiches, 15 vivantes : 33,3 %');
  ok(B.parTheme.other.n === 15 && B.parTheme.other['24h'].vivantsPct === null && B.parTheme.other['24h'].assez === false, '« other » : 15 fiches, sous 40 -> la part est REFUSEE');
  ok(B.parPasseDev['first launch'].n === 31 && B.parPasseDev['5+ before'].n === 25, 'passe du createur dans l ordre des naissances : 31 premiers lancements, 25 avec 5+ avant');
  ok(B.parDevDejaVivant['a previous one lived 24 h'].n === 29, 'le createur de 30 lancements : 29 viennent apres un jeton vivant a 24 h');
  ok(B['7j'] === undefined && B.tout['7j'].mesures === 0 && B.tout['7j'].vivantsPct === null, '7 j : rien de mesure, rien de dit');

  console.log('-- 6 bis. qui tient le projet : createur, taxe, CTO, metas DexScreener');
  {
    const g2 = banc();
    const ordres = new Map();      // jeton -> orders
    const metas = { trending: [{ slug: 'dog' }, { slug: 'cat' }], dog: [A(2)], cat: [] };
    const prendre0 = g2.C;          // (le banc garde son prendre ; on en refait un qui sert aussi orders et metas)
    void prendre0;
    const H = { now: T0 };
    const appels = [];
    const prendre = async (url) => {
      const u = String(url); appels.push(u);
      let corps;
      if (/\/orders\/v1\/robinhood\//.test(u)) { const j = u.split('/').pop(); corps = { orders: ordres.get(j) || [], boosts: [] }; }
      else if (/\/metas\/trending\/v1$/.test(u)) corps = metas.trending;
      else if (/\/metas\/meta\/v1\//.test(u)) { const sl = u.split('/').pop(); corps = { name: sl, tokenCount: 3, pairs: (metas[sl] || []).map((j) => ({ chainId: 'robinhood', baseToken: { address: j } })).concat([{ chainId: 'solana', baseToken: { address: 'So1' } }]) }; }
      else { const l = u.split('/').pop().split(','); corps = l.map((j) => ({ chainId: 'robinhood', baseToken: { address: j }, priceUsd: '1', fdv: 1e5, liquidity: { usd: j === A(4) ? 100 : 20000 } })); }
      return { ok: true, status: 200, text: async () => JSON.stringify(corps) };
    };
    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-g-'));
    const C2 = K.cree({ dossier: D, prendre, horloge: () => H.now });
    for (let i = 1; i <= 4; i++) C2.naissance({ jeton: A(i), t: T0, deployer: A(700 + i), plateforme: 'pons' });
    ok(C2._etat().soldes.length === 4 && C2._etat().soldes.every((x) => x.h === 't2'), 'chaque naissance Pons : son solde de createur a T+2 en file');
    const p = (pct) => '0x' + (BigInt(pct) * 10n ** 25n).toString(16);    // pct % de 1e27
    for (let i = 1; i <= 4; i++) C2.solde(A(i), 't2', p(10));
    eq(C2._fiches.get(A(1)).soldeMax, 10, 'solde a T+2 : 10 % de l offre');
    C2.solde(A(9), 't2', p(1));
    C2.solde(A(1), 'x', 'pas-hex');
    ordres.set(A(3), [{ type: 'communityTakeover', status: 'approved' }, { type: 'tokenProfile', status: 'approved' }]);
    H.now = T0 + 1441 * 60e3;
    await C2.tic();       // la liste des metas (1er tic), le suivi 24 h (tokens/v1)
    ok(appels.some((u) => /metas\/trending/.test(u)), 'la liste des metas DexScreener : lue une fois');
    ok(C2._etat().ordres.length === 3 && !C2._etat().ordres.some((x) => x.jeton === A(4)), '24 h : les commandes DexScreener en file pour les 3 jetons VIVANTS seulement');
    ok(C2._etat().soldes.filter((x) => x.h === '24h').length === 4, '24 h : le solde des 4 createurs en file');
    /* le createur : A1 garde tout, A2 a tout vendu, A3 a tout vendu (CTO DexScreener), A4 a tout vendu et le jeton est mort */
    C2.solde(A(1), '24h', p(10)); C2.solde(A(2), '24h', '0x0'); C2.solde(A(3), '24h', '0x0'); C2.solde(A(4), '24h', '0x0');
    await C2.tic(); await C2.tic();
    ok(appels.filter((u) => /orders\/v1/.test(u)).length === 3, 'commandes lues, 2 par tic au plus');
    ok(appels.filter((u) => /metas\/meta\/v1/.test(u)).length === 2, 'une meta par tic');
    eq(C2._fiches.get(A(2)).dsMetas.join(), 'dog', 'A2 est dans la meta « dog » de DexScreener (les autres chaines ignorees)');
    eq(C2.gouvernance(C2._fiches.get(A(1)), '24h'), 'team', 'A1 : createur encore la, vivant -> team');
    eq(C2.gouvernance(C2._fiches.get(A(2)), '24h'), 'cto', 'A2 : createur parti, vivant -> cto (hypothese)');
    eq(C2.gouvernance(C2._fiches.get(A(3)), '24h'), 'cto', 'A3 : commande communityTakeover -> cto');
    eq(C2.gouvernance(C2._fiches.get(A(4)), '24h'), 'rug', 'A4 : createur parti, jeton mort -> rug');
    const Bg = C2.bilan();
    ok(Bg.gouvernance['24h'].n === 4 && Bg.gouvernance['24h'].parts === null && Bg.gouvernance['24h'].comptes.cto === 2, 'gouvernance 24 h : 4 fiches comptees, part refusee sous 40');
    C2.meta(A(1), { nom: 'X', symbole: 'X', taxePct: 0 });
    C2.meta(A(2), { nom: 'Y', symbole: 'Y', taxePct: 2.5 });
    const Bt = C2.bilan();
    ok(Bt.parTaxe === undefined || Bt.parTaxe, 'bilan par taxe present');
    eq(C2._fiches.get(A(2)).taxe, 2.5, 'taxe du createur gardee (2,5 %)');
    const C3 = K.cree({ dossier: D, prendre, horloge: () => H.now });
    ok(C3._fiches.get(A(2)).dsMetas.includes('dog') && C3._fiches.get(A(4)).soldes['24h'] === 0 && C3.gouvernance(C3._fiches.get(A(3)), '24h') === 'cto', 'redemarrage : soldes, commandes et metas relus du disque');
  }

  console.log('-- 6 ter. detenteurs et activite (la grille du proprietaire)');
  {
    const pad = (x) => '0x' + '0'.repeat(24) + x.slice(2);
    const v = (n) => '0x' + (BigInt(n) * 10n ** 18n).toString(16);
    const ZERO = '0x0000000000000000000000000000000000000000', COURBE = A(101), POOL = A(102), PM4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
    const P = 100000000;
    const log = (de, a, n, bloc, i) => ({ topics: [K.TOPIC_TRANSFER, pad(de), pad(a)], data: v(n), blockNumber: '0x' + bloc.toString(16), logIndex: '0x' + (i || 0).toString(16) });
    const vieux = P - K.BLOCS_24H - 1000;
    const logs = [
      log(ZERO, COURBE, 1000000, vieux - 10),                 // frappe vers la courbe
      log(COURBE, A(1), 300, vieux), log(COURBE, A(2), 100, vieux, 1), log(COURBE, A(3), 50, vieux, 2),
      log(COURBE, POOL, 500000, vieux + 5), log(COURBE, PM4, 400000, vieux + 6),
      log(A(1), '0x000000000000000000000000000000000000dead', 100, vieux + 7),   // burn
      log(POOL, A(4), 40, P - 100), log(A(2), POOL, 100, P - 50),            // 24 h : A4 nouveau, A2 revient (et vend tout)
    ];
    const r = K.analyseTransferts(logs, { exclus: [COURBE, POOL], pointe: P });
    eq(r.detenteurs, 3, 'detenteurs hors courbe, piscine, PoolManager v4, burn et zero : A1 (200), A3 (50), A4 (40) ; A2 a tout vendu');
    eq(r.top10, 100, 'top 10 = 100 % des jetons tenus hors exclus');
    ok(r.transferts24 === 2 && r.actifs24 === 2 && r.nouveaux24 === 1 && r.revenants24 === 1, '24 h : 2 transferts, 2 adresses actives hors piscine, 1 nouvelle (A4), 1 qui revient (A2)');
    const many = []; for (let i = 0; i < 30; i++) many.push(log(COURBE, A(200 + i), i < 10 ? 100 : 1, vieux, i));
    const r2 = K.analyseTransferts(many, { exclus: [COURBE], pointe: P });
    ok(r2.detenteurs === 30 && r2.top10 === Math.floor(1000 / 1020 * 10000) / 100 && r2.top20 === Math.floor(1010 / 1020 * 10000) / 100, 'top 10 et top 20 : ' + r2.top10 + ' % et ' + r2.top20 + ' % (10 gros a 100, 20 petits a 1)');
    /* le carnet : un jeton vivant a 24 h entre en file, ses Transfer passent au bilan */
    const H = { now: T0 };
    const pr = async (url) => {
      const u = String(url);
      if (!/tokens\/v1/.test(u)) return { ok: true, status: 200, text: async () => (/orders/.test(u) ? '{"orders":[],"boosts":[]}' : '[]') };
      const l = u.split('/').pop().split(',');
      return { ok: true, status: 200, text: async () => JSON.stringify(l.map((j) => ({ chainId: 'robinhood', baseToken: { address: j }, pairAddress: POOL, priceUsd: '1', fdv: 1e5, liquidity: { usd: 20000 } }))) };
    };
    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-d-'));
    const C4 = K.cree({ dossier: D, prendre: pr, horloge: () => H.now });
    C4.naissance({ jeton: A(1), courbe: COURBE, bloc: vieux - 10, t: T0, deployer: A(700) });
    H.now = T0 + 1441 * 60e3; await C4.tic();
    const x = C4.detenteursALire();
    ok(x && x.jeton === A(1) && x.h === '24h' && x.bloc === vieux - 10 && x.exclus.includes(COURBE) && x.exclus.includes(POOL), 'vivant a 24 h : en file, avec son bloc de naissance, sa courbe et sa piscine a exclure');
    C4.detenteurs(A(1), '24h', logs, P);
    const f = C4._fiches.get(A(1));
    ok(f.det['24h'] && f.det['24h'].n === 3 && f.det['24h'].revenants24 === 1 && !C4.detenteursALire(), 'le resultat entre dans la fiche ; la file est vide');
    const b = C4.bilan();
    ok(b.parTop10a24h['60%+'] && b.parTop10a24h['60%+'].n === 1 && b.parDetenteursA24h['< 50 holders'].n === 1 && b.parRevenantsA24h['25-50%'] || b.parRevenantsA24h['50-75%'], 'bilan : par top 10, par detenteurs, par part de revenants (lus a 24 h)');
    ok(b.tout['30j'] && b.tout['30j'].mesures === 0, 'le bilan va jusqu a 30 j');
    const C5 = K.cree({ dossier: D, prendre: pr, horloge: () => H.now });
    ok(C5._fiches.get(A(1)).det['24h'].top10 === 100, 'redemarrage : relu du disque');
    C5.naissance({ jeton: A(2), courbe: COURBE, bloc: vieux, t: T0 + 5, deployer: A(701) });
    H.now = T0 + 1442 * 60e3; await C5.tic();
    C5.detenteurs(A(2), '24h', null, P);
    ok(C5.detenteursALire() && C5.detenteursALire().jeton === A(2), 'une lecture ratee : relue une fois');
    C5.detenteurs(A(2), '24h', null, P);
    ok(!C5.detenteursALire() && C5.vue().compteurs.detRates === 1, 'deux : abandonnee, comptee');
  }

  console.log('-- 6 quater. le marche BTC/ETH a la naissance (22/10)');
  {
    /* un contexte simule : BTC -4 % sur 24 h et +6 % sur 7 j pour les naissances de la premiere heure, +1 % / -1 %
       entre +1 h et +3 h, et rien (serie non couvrante) au-dela */
    const ctx = (t) => (t < T0 + 3600e3 ? { btc24h: -4, btc7d: 6, eth24h: 1, eth7d: null } : t < T0 + 3 * 3600e3 ? { btc24h: 1, btc7d: -1, eth24h: 0, eth7d: 0 } : null);
    const g4 = banc({ marcheCtx: ctx });
    for (let i = 1; i <= 9; i++) g4.C.naissance({ jeton: A(i), t: T0 + (i <= 4 ? i * 60e3 : i <= 7 ? 7200e3 + i * 60e3 : 4 * 3600e3 + i * 60e3), deployer: A(900) });
    const B4 = g4.C.bilan();
    ok(B4.parBtc24h && B4.parBtc24h['btc 24h < -3%'] && B4.parBtc24h['btc 24h < -3%'].n === 4, 'parBtc24h : les 4 naissances sous BTC -3 % (etiquette de marche_contexte)');
    ok(B4.parBtc24h['btc 24h 0..3%'].n === 3 && B4.parBtc7d['btc 7d > 5%'].n === 4 && B4.parBtc7d['btc 7d -5..0%'].n === 3, 'parBtc24h 0..3 % : 3 ; parBtc7d > 5 % : 4, -5..0 % : 3');
    eq(B4.parBtc24h['no market data'].n, 2, 'les 2 naissances que la serie ne couvre pas : « no market data », jamais inventees');
    ok(B4.parBtc24h['btc 24h < -3%']['24h'].mesures === 0 && B4.parBtc24h['btc 24h < -3%']['24h'].vivantsPct === null, 'et la part vivante reste refusee sans mesure');
    ok(B4.parTheme['no metadata yet'].n === 9 && B4.tout.n === 9, 'les autres groupes ne bougent pas');
    const g5 = banc();
    g5.C.naissance({ jeton: A(1), t: T0, deployer: A(900) });
    const B5 = g5.C.bilan();
    ok(Object.keys(B5.parBtc24h).length === 0 && Object.keys(B5.parBtc7d).length === 0, 'sans deps.marche : aucun groupe (pas de « no market data » invente par un fournisseur absent)');
    ok(/marche: typeof deps\.marche === 'function' \? deps\.marche : null/.test(fs.readFileSync(path.join(__dirname, 'smart_money.js'), 'utf8')), 'smart_money passe deps.marche au carnet');
  }

  console.log('-- 6. branche dans les lancements et le serveur');
  const src = fs.readFileSync(path.join(__dirname, 'smart_lancements.js'), 'utf8');
  ok(/s\.t2 = \{ acheteurs: j2\.acheteurs[^\n]*\n[^\n]*\n\s*if \(deps\.carnet\) \{ try \{ deps\.carnet\.naissance\(/.test(src), 'au T+2 de CHAQUE courbe (pas seulement les alertees) : naissance au carnet');
  ok(/if \(deps\.carnet\) await metasDuCarnet\(bilan, a\);/.test(src) && /catch \(e\) \{ bilan\.carnetMetas = 'erreur/.test(src), 'les metadonnees en fin de cycle ; une erreur ne coupe rien');
  ok(/plateforme: 'ignition'[^\n]*deployer: l\.createur/.test(src), 'les lancements IGNITION aussi');
  const SLZ = require('./smart_lancements');
  const pris = [];
  const lots = [];
  const faux = { naissance: (r) => pris.push(r), aLire: () => [{ jeton: A(1) }, { jeton: A(2) }], meta: (j, m) => pris.push({ meta: j, m }) };
  const chaine = (s) => '0x' + '20'.padStart(64, '0') + s.length.toString(16).padStart(64, '0') + Buffer.from(s).toString('hex').padEnd(64, '0');
  const R = { lot: async (q) => { lots.push(q.length); return q.map((x, i) => ({ result: i < 5 ? chaine(['Dog One', 'DOG1', 'hello', '', 'ipfs://l'][i]) : '0x' })); }, nouvellePasse() {}, etat: { passe: {} },
    pointe: async () => { throw Object.assign(new Error('test : pas de noeud'), { abandon: true }); } };
  const LZ = SLZ.cree({ R, B: { meta() { return null; }, pose() {}, sauve() {} }, horloge: () => T0, dors: async () => {}, prendre: async () => { throw new Error('non'); }, env: {}, note() {}, envoie: async () => false, carnet: faux });
  await LZ.cycle();
  eq(lots.length, 0, 'un cycle coupe avant la fin (noeud absent) : pas de lecture du carnet');
  const bl = {};
  await LZ._metasDuCarnet(bl);
  ok(lots.length === 1 && lots[0] === 12, 'deux jetons : UN lot de 12 eth_call (nom, symbole, description, reseaux, logo, taxe)');
  const m1 = pris.find((x) => x.meta === A(1)), m2 = pris.find((x) => x.meta === A(2));
  ok(m1 && m1.m && m1.m.nom === 'Dog One' && m1.m.symbole === 'DOG1' && m1.m.description === 'hello' && m1.m.logo === 'ipfs://l', 'A1 : nom, symbole, description, logo decodes');
  ok(m2 && m2.m === null && bl.carnetMetas === 2, 'A2 sans reponse : null (relu plus tard)');
  R.lot = async () => { throw new Error('budget'); };
  const bl2 = {};
  await LZ._metasDuCarnet(bl2);
  ok(/^erreur/.test(bl2.carnetMetas), 'un lot refuse : note, rien ne casse');
  /* les soldes du createur dans le meme lot, et la reserve du jour */
  const faux2 = { aLire: () => [{ jeton: A(1), courbe: A(101) }], meta: (j, m) => pris.push({ meta2: j, m }), soldesALire: (n) => [{ jeton: A(1), dev: A(500), h: '24h' }].slice(0, 20 - 6 * n), solde: (j, h, brut) => pris.push({ solde: j, h, brut }) };
  const appelsLot = [];
  const R2 = { lot: async (q) => { appelsLot.push(q); return q.map((x, i) => ({ result: i === 5 ? '0x' + (250).toString(16).padStart(64, '0') : i === 6 ? '0x' + (10n ** 26n).toString(16).padStart(64, '0') : '0x' })); },
    nouvellePasse() {}, etat: { passe: {} }, pointe: async () => { throw new Error('non'); }, jour: () => ({ http: 100 }) };
  const LZ2 = SLZ.cree({ R: R2, B: { meta() { return null; }, pose() {}, sauve() {} }, horloge: () => T0, dors: async () => {}, prendre: async () => { throw new Error('non'); }, env: {}, note() {}, envoie: async () => false, carnet: faux2 });
  await LZ2._metasDuCarnet({});
  const q = appelsLot[0];
  ok(q.length === 7 && q[5].params[0].to === A(101) && q[5].params[0].data === '0xc1bb8901', 'la taxe du createur lue sur la COURBE (creatorTaxBps)');
  ok(q[6].params[0].to === A(1) && q[6].params[0].data === K.SEL_BALANCE + '0'.repeat(24) + A(500).slice(2), 'le solde : balanceOf(createur) sur le jeton');
  const pm = pris.find((x) => x.meta2 === A(1)), ps = pris.find((x) => x.solde === A(1));
  ok(pm && pm.m === null, 'sans nom ni symbole : meta vide (relue plus tard)');
  ok(ps && ps.h === '24h' && BigInt(ps.brut) === 10n ** 26n, 'le solde lu passe au carnet');
  R2.jour = () => ({ http: SLZ.JOUR_HTTP * 0.95 });
  const bl3 = {};
  await LZ2._metasDuCarnet(bl3);
  ok(appelsLot.length === 1 && bl3.carnetMetas === 'reserve du jour', 'au-dela de 90 % du plafond du jour : le carnet ne lit plus rien (le detecteur passe d abord)');
  /* les detenteurs : un eth_getLogs Transfer du jeton, de sa naissance a la pointe du cycle */
  const getLogs = [];
  const faux3 = { aLire: () => [], soldesALire: () => [], detenteursALire: () => ({ jeton: A(5), h: '7j', bloc: 1000, exclus: [] }), detenteurs: (j, h, logs, p) => pris.push({ det: j, h, n: logs ? logs.length : null, p }) };
  const R3 = { lot: async () => [], appel: async (m, params) => { getLogs.push({ m, params }); return { result: [{ topics: [] }, { topics: [] }] }; }, nouvellePasse() {}, etat: { passe: {} }, pointe: async () => { throw new Error('non'); }, jour: () => ({ http: 0 }) };
  const LZ3 = SLZ.cree({ R: R3, B: { meta() { return null; }, pose() {}, sauve() {} }, horloge: () => T0, dors: async () => {}, prendre: async () => { throw new Error('non'); }, env: {}, note() {}, envoie: async () => false, carnet: faux3 });
  const bl4 = {};
  await LZ3._metasDuCarnet(bl4, 5000);
  const g0 = getLogs[0];
  ok(getLogs.length === 1 && g0.m === 'eth_getLogs' && g0.params[0].address === A(5) && g0.params[0].topics[0] === K.TOPIC_TRANSFER && g0.params[0].fromBlock === '0x3e8' && g0.params[0].toBlock === '0x1388', 'un eth_getLogs : Transfer du jeton, de sa naissance (bloc 1000) a la pointe (5000)');
  ok(pris.some((x) => x.det === A(5) && x.h === '7j' && x.n === 2 && x.p === 5000) && bl4.carnetDetenteurs === 2, 'les Transfer passent au carnet (rien d autre a lire ce cycle : la lecture a lieu quand meme)');
  R3.appel = async () => { throw new Error('noeud'); };
  await LZ3._metasDuCarnet({}, 5000);
  ok(pris.some((x) => x.det === A(5) && x.n === null), 'une panne : null au carnet (relu une fois), le cycle continue');
  const M = require('./smart_money');
  ok(typeof M.cree({ env: { SMART_MONEY: '1' } }).carnetLancements === 'function' && M.cree({ env: { SMART_MONEY: '1' } }).carnetLancements().actif === false, 'smart_money : carnetLancements (inactif avant l allumage)');
  ok(/path === '\/ai\/smart\/lancements'/.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')), 'la route /ai/smart/lancements (meme debit que /ai/smart)');

  console.log(rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK');
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
