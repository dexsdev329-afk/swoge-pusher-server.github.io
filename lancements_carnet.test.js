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
 *      groupe sans fournisseur ; smart_money passe deps.marche ;
 *   8. les copies de jetons (22/10, methode novamp reecrite) : cles serree et
 *      lache (sosies, leetspeak, invisibles, remplissage), grappes par symbole,
 *      par nom ou a 1 edition (48 h), premier ne par bloc, rangs renumerotes
 *      quand l'original est lu apres, douteux a 2 faits (createur en serie :
 *      aucun des 5 d'avant vivant a 24 h), redemarrage relu, direct differe
 *      pendant la migration, rang illisible ignore, rangs deduits des rangs
 *      notes quand l'original est sorti des 32 j, parClone refuse sous 40.
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

  console.log('-- 6 quinquies. les copies de jetons (22/10)');
  {
    /* les cles (pures) */
    const cs = K.clesDe('Рере the Frog', 'PЕPE');          // Р е р е cyrilliques dans le nom, Е cyrillique dans le symbole
    ok(cs.nom.s === 'pepethefrog' && cs.nom.l === 'pepefrog' && cs.sym.s === 'pepe' && cs.sym.l === 'pepe', 'sosies cyrilliques replies, « the » retire de la cle lache : ' + JSON.stringify(cs));
    const cl = K.clesDe('P3P3 C0IN', 'P3PE');
    ok(cl.nom.s === 'p3p3c0in' && cl.nom.l === 'pepe' && cl.sym.l === 'pepe', 'leetspeak et « coin » : la serree garde les chiffres (p3p3c0in), la lache dit pepe');
    ok(K.clesDe('Pe​pe­', 'PE‍PE').sym.s === 'pepe' && K.clesDe('Pe​pe­', null).nom.s === 'pepe', 'zero-width et soft hyphen retires');
    eq(K.clesDe('Pépé Cöin', null).nom.l, 'pepe', 'accents (marques combinantes) retires');
    ok(['Pepe Coin', 'The Pepe Token', 'PEPE INU', 'PepeCoin', 'Pepe on ETH', 'ThePepe'].every((x) => K.clesDe(x, null).nom.l === 'pepe'), 'mots de remplissage : coin, the, token, inu, on, eth, colles ou non -> pepe');
    ok(K.clesDe('AI Coin', null).nom.l === 'aicoin' && K.clesDe('Bonsai', null).nom.l === 'bonsai' && K.clesDe('Moon', null).nom.l === 'mon', 'jamais videe (AI Coin), « ai »/« on » colles gardes (bonsai), lettres repetees reduites (moon -> mon)');
    ok(K.clesDe('Moooon', 'MOOON').nom.l === 'mon' && K.clesDe(null, 'BOO').sym.l === 'boo', 'moooon -> mon ; boo reste boo (pas en dessous de 3)');
    ok(K.clesDe(null, 'PEPE').nom === null && K.clesDe(null, 'PEPE').sym.s === 'pepe', 'nom absent : cle de symbole seule');
    ok(K.clesDe('Pep', 'PE').nom === null && K.clesDe('Pep', 'PE').sym === null && K.clesDe('🐸🐸🐸🐸', '🐸').nom === null && K.clesDe('', '').sym === null, 'trop court (nom < 4, symbole < 3), emojis seuls ou vide : pas de cle');
    eq(K.clesDe(null, 'P@PE$').sym.l, 'papes', '@ et $ en leetspeak');
    ok(K.clesDe('ＤＯＧＥ', null).nom.s === 'doge' && K.clesDe('Dοge', null).nom.s === 'doge', 'pleine largeur et omicron grec : doge');
    ok(K.clesProches('pepe', 'pepo') && K.clesProches('shiba', 'shibo') && !K.clesProches('shiba', 'shabo') && !K.clesProches('abc', 'abd') && K.clesProches('longkeyname', 'lngokeyname') && K.distanceDL('abcd', 'bacd', 2) === 1, 'distance : 1 edition a partir de 4, 2 a partir de 9, stricte en dessous, transposition = 1');

    /* le regroupement, dans le carnet */
    const g6 = banc();
    const F6 = g6.C._fiches;
    const ne = (i, bloc, t, o) => g6.C.naissance(Object.assign({ jeton: A(i), bloc, t, deployer: A(800 + i), courbe: A(300 + i), plateforme: 'pons' }, o || {}));
    const lignesClone = (D) => fs.readdirSync(path.join(D, 'lancements')).filter((x) => /\.jsonl$/.test(x)).sort()
      .flatMap((x) => fs.readFileSync(path.join(D, 'lancements', x), 'utf8').split('\n').filter(Boolean).map(JSON.parse)).filter((o) => o.k === 'clone');
    ne(1, 100, T0, { exemptions: 5 }); ne(2, 101, T0 + 60e3); ne(3, 102, T0 + 120e3); ne(4, 103, T0 + 180e3); ne(5, 104, T0 + 240e3);
    g6.C.meta(A(1), { nom: 'Pepe', symbole: 'PEPE' });
    g6.C.meta(A(2), { nom: 'Рере', symbole: 'PEPE2' });        // cyrillique, et un symbole a 1 edition
    g6.C.meta(A(3), { nom: 'Pepe The Frog', symbole: 'FROG' });
    g6.C.meta(A(4), { nom: 'Doge', symbole: 'PEPE' });          // meme symbole, autre nom
    g6.C.meta(A(5), { nom: 'Pepo Coin', symbole: 'PPO' });      // nom a 1 edition (pepo / pepe), symbole de 3 sans egal
    const c6 = (i) => F6.get(A(i)).cl;
    ok(c6(1) && c6(1).g === A(1) && c6(1).rang === 1 && c6(1).douteux === false, 'A1 Pepe : original (rang 1, sa propre grappe)');
    ok(c6(2).g === A(1) && c6(2).rang === 2, 'A2 (Рере cyrillique, PEPE2) : copie #2 de A1');
    ok(c6(3).g === A(3) && c6(3).rang === 1, 'A3 (Pepe The Frog / FROG) : une autre grappe (pepefrog est a 4 editions)');
    ok(c6(4).g === A(1) && c6(4).rang === 3, 'A4 (Doge / PEPE) : meme symbole -> copie #3');
    ok(c6(5).g === A(1) && c6(5).rang === 4, 'A5 (Pepo Coin / PPO) : nom a 1 edition de pepe -> copie #4');
    const l2 = lignesClone(g6.dossier).find((o) => o.jeton === A(2));
    ok(l2 && l2.groupe === A(1) && l2.rang === 2 && l2.douteux === false && typeof l2.t === 'number', 'la ligne « clone » : jeton, groupe (le premier ne), rang, douteux');
    ne(7, 110, T0 + 600e3); ne(8, 111, T0 + 660e3); ne(9, 112, T0 + 720e3);
    g6.C.meta(A(7), { nom: 'Shiba', symbole: 'SHIB' });
    g6.C.meta(A(8), { nom: 'Shabo', symbole: 'SHABO' });
    ok(c6(8).g === A(8) && c6(8).rang === 1, 'Shabo apres Shiba : 2 editions a longueur 5 -> pas de fusion, original de sa grappe');
    g6.C.meta(A(9), { nom: 'Shibo', symbole: 'SHIBO' });      // a 1 edition de Shiba ET de Shabo : les deux grappes fusionnent
    ok(c6(9).g === A(7) && c6(9).rang === 3 && c6(8).g === A(7) && c6(8).rang === 2 && c6(7).rang === 1, 'Shibo (1 edition des deux) : Shiba, Shabo, Shibo une seule grappe, premier ne Shiba ; Shabo renotee copie #2');
    ne(10, 50, T0 - 600e3);                                   // ne AVANT A1 (bloc 50) ; sa metadonnee arrive apres celles des copies
    g6.C.meta(A(10), { nom: 'PEPE', symbole: 'PEPE' });
    ok(c6(10).g === A(10) && c6(10).rang === 1 && c6(1).g === A(10) && c6(1).rang === 2 && c6(2).rang === 3 && c6(4).rang === 4 && c6(5).rang === 5, 'un Pepe ne avant (bloc 50) lu apres : il devient l original, A1 copie #2, A5 copie #5');
    ne(11, 131, T0 + 900e3); ne(12, 130, T0 + 900e3);         // meme instant : A12 a le bloc le plus bas mais la ligne suivante
    g6.C.meta(A(11), { nom: 'Zorro', symbole: 'ZORRO' }); g6.C.meta(A(12), { nom: 'Zorro', symbole: 'ZRR' });
    ok(c6(12).rang === 1 && c6(11).g === A(12) && c6(11).rang === 2, 'meme instant : le bloc le plus bas (A12) est le premier ne, meme ecrit apres');
    /* douteux : 2 faits sur le premier ne */
    const p = (pct) => '0x' + (BigInt(pct) * 10n ** 25n).toString(16);
    ne(13, 140, T0 + 1200e3, { exemptions: 4 }); g6.C.solde(A(13), 't2', p(12));     // 4 exemptes ET 12 % de l'offre au dev
    ne(14, 141, T0 + 1260e3);
    g6.C.meta(A(13), { nom: 'Bonk', symbole: 'BONK' }); g6.C.meta(A(14), { nom: 'Bonk', symbole: 'BONK' });
    ok(c6(14).g === A(13) && c6(14).rang === 2 && c6(14).douteux === true, 'copie d un original a 2 faits (4 exemptes, dev a 12 %) : douteux');
    ne(15, 150, T0 + 1500e3, { exemptions: 4 }); ne(16, 151, T0 + 1560e3);
    g6.C.meta(A(15), { nom: 'Wif', symbole: 'WIF' }); g6.C.meta(A(16), { nom: 'Wif Coin', symbole: 'WIF' });
    ok(c6(16).g === A(15) && c6(16).douteux === false, 'un seul fait (4 exemptes) : sain ; Wif (3 lettres) se groupe par le symbole');
    ok(g6.C.douteuxDe(F6.get(A(13))) === 2 && g6.C.douteuxDe(F6.get(A(15))) === 1 && g6.C.douteuxDe(F6.get(A(10))) === 0, 'douteuxDe compte les faits : 2, 1, 0');
    const B6 = g6.C.bilan();
    ok(B6.parClone.original.n === 5 && B6.parClone['original, doubtful'].n === 1 && B6.parClone['copy #2'].n === 5 && B6.parClone['copy #3+'].n === 4, 'bilan parClone : 5 originaux, 1 douteux, 5 copies #2, 4 copies #3+ (' + JSON.stringify(Object.fromEntries(Object.entries(B6.parClone).map(([k, x]) => [k, x.n]))) + ')');
    ok(B6.parGroupeTaille['1'].n === 1 && B6.parGroupeTaille['2-3'].n === 9 && B6.parGroupeTaille['4+'].n === 5, 'par taille de grappe : 1 seul, 9 en 2-3, 5 en 4+');
    ok(B6.parClone.original['24h'].mesures === 0 && B6.parClone.original['24h'].vivantsPct === null, 'la part vivante : rien de mesure, rien de dit');
    /* un fait lu apres la detection compte au bilan : le top 10 de Wif a 24 h */
    const pad = (x) => '0x' + '0'.repeat(24) + x.slice(2);
    g6.C.detenteurs(A(15), '24h', [{ topics: [K.TOPIC_TRANSFER, pad(A(315)), pad(A(777))], data: '0x' + (10n ** 20n).toString(16), blockNumber: '0x96', logIndex: '0x0' }], 200);
    g6.H.now += 11 * 60e3;     // le cache du bilan (10 min)
    ok(g6.C.bilan().parClone['original, doubtful'].n === 2 && c6(16).douteux === false, 'Wif : top 10 a 100 % lu a 24 h -> 2 faits, douteux au bilan ; la ligne de sa copie garde ce qu on savait alors');
    const v6 = g6.C.vue().clones;
    /* 9 fiches a rang > 1 : A1 A2 A4 A5 (PEPE), A8 A9 (Shiba), A11, A14, A16 — A1, notee « original » puis renumerotee copie
       quand A10 est lu, compte (un compteur par detection la manquait : il disait 6) */
    ok(v6.reperes === 9 && v6.revus === 6 && v6.grappes === 5 && v6.plusGrosDuJour && v6.plusGrosDuJour.n === 5 && v6.plusGrosDuJour.original === A(10) && v6.plusGrosDuJour.nom === 'PEPE', 'vue : 9 copies en memoire (fiches a rang > 1), 6 fiches renotees, 5 grappes, la plus grosse du jour : PEPE x5 (' + JSON.stringify(v6) + ')');
    /* createur en serie : ≥ 5 lancements avant ET aucun vivant a 24 h (le « aucun gradue » de novamp, sur la definition du carnet) */
    for (let i = 40; i <= 45; i++) ne(i, 1600 + i, T0 + 1800e3 + i * 1000, { deployer: A(999), exemptions: i === 45 ? 4 : 0 });
    ok(g6.C.douteuxDe(F6.get(A(45))) === 2 && g6.C.douteuxDe(F6.get(A(44))) === 0, '6e lancement du meme createur, aucun des 5 d avant vivant a 24 h, 4 exemptes : 2 faits ; le 5e (4 avant, 0 exempte) : 0');
    F6.get(A(41)).s['24h'] = { m: true, liq: 9000 };          // l'un des cinq vivait a 24 h (le champ que lit le bilan pour parDevDejaVivant)
    ok(g6.C.douteuxDe(F6.get(A(45))) === 1 && g6.C.douteuxDe(F6.get(A(45)), 5, true) === 1 && g6.C.douteuxDe(F6.get(A(45)), 5, false) === 2, 'un des cinq vivait a 24 h : plus un fait (1) ; par le passe du bilan (5, vivant) : 1 ; (5, aucun) : 2');
    /* la distance d'edition ne regarde que 48 h ; la cle exacte n'a pas d'age */
    ne(20, 200, T0 + 3600e3); g6.C.meta(A(20), { nom: 'Kumo', symbole: 'KUMO' });     // (« Bork » serait a 1 edition de Bonk : voulu)
    g6.H.now = T0 + 50 * 3600e3;
    ne(21, 300, g6.H.now); g6.C.meta(A(21), { nom: 'Kumi', symbole: 'KUMI' });       // 1 edition, mais 49 h plus tard
    g6.H.now = T0 + 99 * 3600e3;
    ne(22, 400, g6.H.now); g6.C.meta(A(22), { nom: 'Kumo', symbole: 'XKMO' });       // meme cle exacte, 98 h plus tard
    ok(c6(21).g === A(21) && c6(21).rang === 1, 'Kumi 49 h apres Kumo : la distance d edition ne compare qu a 48 h -> grappe a part');
    ok(c6(22).g === A(20) && c6(22).rang === 2, 'Kumo 98 h apres Kumo : la cle exacte n a pas d age -> copie #2');
    /* le redemarrage relit grappes et rangs tels qu'ecrits, et l'index sert les suivants */
    const nLignes = lignesClone(g6.dossier).length;
    const g7 = banc({ dossier: g6.dossier, now: g6.H.now });
    const F7 = g7.C._fiches;
    ok(F7.get(A(1)).cl.g === A(10) && F7.get(A(1)).cl.rang === 2 && F7.get(A(8)).cl.g === A(7) && F7.get(A(8)).cl.rang === 2 && F7.get(A(22)).cl.g === A(20) && F7.get(A(14)).cl.douteux === true, 'redemarrage : grappes, rangs et douteux relus du disque, tels qu ecrits');
    eq(lignesClone(g7.dossier).length, nLignes, 'et rien n est reecrit');
    ok(g7.C.vue().clones.grappes === 6 && g7.C._grappes().get(A(10)).size === 5, 'l index et les grappes sont reconstruits (6 grappes, PEPE x5)');
    g7.C.naissance({ jeton: A(30), bloc: 500, t: g7.H.now, deployer: A(830) });
    g7.C.meta(A(30), { nom: 'Doge Pepe', symbole: 'PEPE' });
    ok(F7.get(A(30)).cl.g === A(10) && F7.get(A(30)).cl.rang === 6, 'apres redemarrage, un nouveau PEPE rejoint la grappe de A10 : copie #6');
    g7.C.meta(A(30), { nom: 'Doge Pepe', symbole: 'PEPE' });
    eq(lignesClone(g7.dossier).length, nLignes + 1, 'le meme jeton relu : aucune nouvelle ligne, meme grappe');
    g7.C.naissance({ jeton: A(31), bloc: 501, t: g7.H.now, deployer: A(831) }); g7.C.meta(A(31), { nom: 'AI', symbole: 'AI' });
    g7.C.naissance({ jeton: A(32), bloc: 502, t: g7.H.now, deployer: A(832) }); g7.C.meta(A(32), { nom: null, symbole: 'AI' });
    ok(!F7.get(A(31)).cl && !F7.get(A(32)).cl && lignesClone(g7.dossier).length === nLignes + 1, 'AI / AI (trop court) : aucune cle, aucune grappe, jamais dit « original »');
    /* des fiches d'avant ce lot : nom lu, pas de ligne clone -> reperees au demarrage, une fois */
    const D8 = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-c-'));
    fs.mkdirSync(path.join(D8, 'lancements'));
    fs.writeFileSync(path.join(D8, 'lancements', '2026-10-21.jsonl'), [{ k: 'n', t: T0, jeton: A(1), bloc: 10, deployer: A(801) }, { k: 'n', t: T0 + 1, jeton: A(2), bloc: 11, deployer: A(802) },
      { k: 'm', t: T0 + 5, jeton: A(1), nom: 'Neiro', symbole: 'NEIRO' }, { k: 'm', t: T0 + 6, jeton: A(2), nom: 'Neiro', symbole: 'NEIRO2' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const g8 = banc({ dossier: D8, now: T0 + 3600e3 });
    ok(!g8.C._fiches.get(A(2)).cl && g8.C.vue().clones.aReperer === 2 && lignesClone(D8).length === 0, 'fiches d avant ce lot (nom lu, pas de ligne clone) : en attente au demarrage, rien d ecrit en bloc');
    g8.C.naissance({ jeton: A(3), bloc: 12, t: g8.H.now, deployer: A(803) }); g8.C.meta(A(3), { nom: 'Neiro', symbole: 'NEIRO3' }); g8.C.meta(A(3), { nom: 'Neiro', symbole: 'NEIRO3' });
    ok(!g8.C._fiches.get(A(3)).cl && g8.C.vue().clones.aReperer === 3 && lignesClone(D8).length === 0, 'une metadonnee en direct pendant la migration attend en fin de file, une fois (reperee tout de suite, elle serait « original » des plus vieux en attente)');
    await g8.C.tic();
    const F8 = g8.C._fiches, v8 = g8.C.vue().clones;
    ok(F8.get(A(2)).cl && F8.get(A(2)).cl.g === A(1) && F8.get(A(2)).cl.rang === 2 && F8.get(A(3)).cl.g === A(1) && F8.get(A(3)).cl.rang === 3 && lignesClone(D8).length === 3 && v8.migres === 3 && v8.aReperer === 0 && v8.revus === 0, 'au premier tic : reperees dans l ordre des naissances, ecrites une fois, le direct en dernier (copie #3), rien de renumerote');
    const g9 = banc({ dossier: D8, now: T0 + 3600e3 });
    await g9.C.tic();
    ok(lignesClone(D8).length === 3 && g9.C.vue().clones.aReperer === 0 && g9.C.vue().clones.migres === 0 && g9.C.vue().compteurs.clonesIncoherents === 0, 'au redemarrage suivant : relues, rien a reperer, rien de reecrit, aucune incoherence');
    /* une ligne au rang illisible n'est pas un « original » par defaut ; l'original sorti de la memoire nomme encore la grappe */
    const D11 = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-c-'));
    fs.mkdirSync(path.join(D11, 'lancements'));
    fs.writeFileSync(path.join(D11, 'lancements', '2026-10-21.jsonl'), [{ k: 'n', t: T0, jeton: A(1), bloc: 10, deployer: A(801) }, { k: 'n', t: T0 + 1, jeton: A(2), bloc: 11, deployer: A(802) }, { k: 'n', t: T0 + 2, jeton: A(3), bloc: 12, deployer: A(803) },
      { k: 'm', t: T0 + 5, jeton: A(1), nom: 'Neiro', symbole: 'NEIRO' }, { k: 'm', t: T0 + 6, jeton: A(2), nom: 'Neiro', symbole: 'NEIRO2' }, { k: 'm', t: T0 + 7, jeton: A(3), nom: 'Neiro', symbole: 'NEIRO3' },
      { k: 'clone', t: T0 + 8, jeton: A(1), groupe: A(77), rang: 2, douteux: false }, { k: 'clone', t: T0 + 8, jeton: A(2), groupe: A(77), rang: 3, douteux: false }, { k: 'clone', t: T0 + 8, jeton: A(3), groupe: A(77), rang: 'abc', douteux: false }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const g11 = banc({ dossier: D11, now: T0 + 3600e3 });
    const F11 = g11.C._fiches, v11 = g11.C.vue().clones;
    ok(F11.get(A(1)).cl.g === A(77) && F11.get(A(1)).cl.rang === 2 && !F11.get(A(3)).cl && v11.aReperer === 1 && v11.reperes === 2 && v11.grappes === 1, 'rang « abc » : la ligne est ignoree, la fiche attend le tic (jamais rang 1 par defaut) ; les deux autres gardent leur grappe dont l original (A77) est hors memoire');
    ok(v11.plusGrosDuJour && v11.plusGrosDuJour.n === 2 && v11.plusGrosDuJour.original === A(77) && v11.plusGrosDuJour.nom === 'Neiro' && v11.plusGrosDuJour.sym === 'NEIRO', 'la plus grosse du jour est nommee par son plus vieux membre en memoire quand l original est sorti des 32 j (' + JSON.stringify(v11.plusGrosDuJour) + ')');
    await g11.C.tic();
    ok(F11.get(A(3)).cl && F11.get(A(3)).cl.g === A(77) && F11.get(A(3)).cl.rang === 4 && lignesClone(D11).length === 4 && g11.C.vue().clones.plusGrosDuJour.n === 3 && g11.C.vue().compteurs.clonesIncoherents === 0, 'au tic : reperee par la cle exacte, copie #4 derriere l original hors memoire et les deux relues ; une ligne ecrite');
    /* la memoire ne remonte qu'a 32 j (JOURS_MEMOIRE) : l'original ET la copie #2 d'une grappe vivante depuis plus d'un mois
       sont sortis (fichier de 41 j), #3 et #4 relues (fichier de 2 j) ; les rangs se deduisent des rangs notes, jamais de
       la taille en memoire (mesure du 22/10 : le 5e recevait 4, un original tardif ne avant #3 recevait 2) */
    const D13 = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-c-'));
    fs.mkdirSync(path.join(D13, 'lancements'));
    const TV = Date.parse('2026-09-10T12:00:00Z'), TR = Date.parse('2026-10-19T12:00:00Z');
    const j13 = (f, l) => fs.writeFileSync(path.join(D13, 'lancements', f), l.map((o) => JSON.stringify(o)).join('\n') + '\n');
    j13('2026-09-10.jsonl', [{ k: 'n', t: TV, jeton: A(77), bloc: 1, deployer: A(877) }, { k: 'n', t: TV + 60e3, jeton: A(78), bloc: 2, deployer: A(878) },
      { k: 'm', t: TV + 5, jeton: A(77), nom: 'Pepe', symbole: 'PEPE' }, { k: 'm', t: TV + 65e3, jeton: A(78), nom: 'Pepe', symbole: 'PEPE2' },
      { k: 'clone', t: TV + 5, jeton: A(77), groupe: A(77), rang: 1, douteux: false }, { k: 'clone', t: TV + 65e3, jeton: A(78), groupe: A(77), rang: 2, douteux: false }]);
    j13('2026-10-19.jsonl', [{ k: 'n', t: TR, jeton: A(1), bloc: 10, deployer: A(801) }, { k: 'n', t: TR + 60e3, jeton: A(2), bloc: 11, deployer: A(802) }, { k: 'n', t: TR - 3600e3, jeton: A(4), bloc: 9, deployer: A(804) },
      { k: 'm', t: TR + 5, jeton: A(1), nom: 'Pepe', symbole: 'PEPE3' }, { k: 'm', t: TR + 65e3, jeton: A(2), nom: 'Pepe', symbole: 'PEPE4' },
      { k: 'clone', t: TR + 5, jeton: A(1), groupe: A(77), rang: 3, douteux: false }, { k: 'clone', t: TR + 65e3, jeton: A(2), groupe: A(77), rang: 4, douteux: false }]);
    const g13 = banc({ dossier: D13, now: T0 + 3600e3 });
    const F13 = g13.C._fiches, c13 = (i) => F13.get(A(i)).cl;
    ok(!F13.has(A(77)) && !F13.has(A(78)) && c13(1).rang === 3 && c13(2).rang === 4 && g13.C._grappes().get(A(77)).size === 3 && lignesClone(D13).length === 4, 'au demarrage : l original (A77) et la copie #2 sont sortis des 32 j, #3 et #4 relues ; la grappe en memoire fait 3, racine comprise');
    g13.C.naissance({ jeton: A(3), bloc: 12, t: g13.H.now, deployer: A(803) }); g13.C.meta(A(3), { nom: 'Pepe', symbole: 'PEPE5' });
    ok(c13(3).g === A(77) && c13(3).rang === 5 && lignesClone(D13).length === 5, 'un 5e Pepe : copie #5 (le plus haut rang note + 1), pas « taille en memoire » = 4 en double avec #4');
    g13.C.meta(A(4), { nom: 'Pepe', symbole: 'PEPE6' });     // ne avant #3 (bloc 9), metadonnee lue en dernier
    const rangs13 = [4, 1, 2, 3].map((i) => c13(i).rang);
    ok(rangs13.join() === '3,4,5,6' && [1, 2, 3, 4].every((i) => c13(i).g === A(77)), 'un Pepe ne avant #3 lu apres : rang 3 (derriere les deux sortis), #3/#4/#5 renumerotes 4/5/6, aucun rang en double ni en dessous de 3 (' + JSON.stringify(rangs13) + ')');
    ok(lignesClone(D13).length === 9 && g13.C.vue().clones.revus === 3 && g13.C.vue().compteurs.clonesIncoherents === 0, '4 lignes ecrites en un appel (A4 et les trois decalees), clonesRevus 3');
    const g14 = banc({ dossier: D13, now: g13.H.now });
    ok([4, 1, 2, 3].map((i) => g14.C._fiches.get(A(i)).cl.rang).join() === '3,4,5,6' && g14.C.vue().compteurs.clonesIncoherents === 0 && g14.C._grappes().get(A(77)).size === 5 && g14.C.vue().clones.reperes === 4, 'au redemarrage : rangs 3 a 6 relus, la grappe fait 5 en memoire, 4 copies, aucune incoherence');
    /* un seul jeton : pas de grappe, pas de « plus grosse du jour » a 1 */
    const g12 = banc();
    g12.C.naissance({ jeton: A(1), bloc: 10, t: T0, deployer: A(801) }); g12.C.meta(A(1), { nom: 'Alone', symbole: 'ALONE' });
    const v12 = g12.C.vue().clones, c12 = g12.C.vue().compteurs;
    ok(g12.C._fiches.get(A(1)).cl.rang === 1 && v12.reperes === 0 && v12.grappes === 0 && v12.plusGrosDuJour === null && v12.indexes === 1 && c12.erreursClone === 0 && c12.clonesIncoherents === 0, 'un seul jeton : original de sa grappe, 0 copie, 0 grappe de 2+, pas de « plus grosse du jour » a 1 (' + JSON.stringify(v12) + ')');
    /* le bilan refuse la part sous 40 fiches mesurees, la donne a 40 */
    const g10 = banc();
    const noms = ['Neiro', 'Brett', 'Mog', 'Andy', 'Bonk', 'Wojak', 'Turbo', 'Floki', 'Popcat', 'Giga'];
    for (let i = 1; i <= 60; i++) {
      g10.C.naissance({ jeton: A(i), t: T0 + i * 1000, bloc: 1000 + i, deployer: A(900 + i) });
      g10.C.meta(A(i), { nom: noms[(i - 1) % 10], symbole: noms[(i - 1) % 10].toUpperCase() });
      if (i <= 30) g10.marche.set(A(i), { prix: 1, fdv: 2e5, liq: 9000 });
    }
    await avance(g10, 61);
    g10.H.now = T0 + 1441 * 60e3; await g10.C.tic(); await g10.C.tic();
    const B10 = g10.C.bilan();
    ok(B10.parClone.original.n === 10 && B10.parClone['copy #2'].n === 10 && B10.parClone['copy #3+'].n === 40, '60 fiches, 10 noms x 6 : 10 originaux, 10 copies #2, 40 copies #3+');
    ok(B10.parClone.original['24h'].mesures === 10 && B10.parClone.original['24h'].assez === false && B10.parClone.original['24h'].vivantsPct === null, 'originaux : 10 mesures a 24 h, sous 40 -> la part est REFUSEE');
    ok(B10.parClone['copy #3+']['24h'].mesures === 40 && B10.parClone['copy #3+']['24h'].assez && B10.parClone['copy #3+']['24h'].vivantsPct === 25, 'copies #3+ : 40 mesures, 10 vivantes -> 25 %');
    ok(B10.parGroupeTaille['4+'].n === 60 && g10.C.vue().clones.grappes === 10, 'par taille de grappe : les 60 dans des grappes de 4+ ; 10 grappes');
    ok(!/f\.cl|parClone|douteux/.test(fs.readFileSync(path.join(__dirname, 'smart_lancements.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8')), 'aucune regle d achat, d alerte ni de vente ne lit les copies');
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
