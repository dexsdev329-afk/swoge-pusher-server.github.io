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
 *      metadonnees partent en UN lot ; smart_money sert /ai/smart/lancements.
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
    const l = String(url).split('/').pop().split(',');
    appels.push(l.length);
    const corps = l.filter((j) => marche.has(j)).map((j) => ({ chainId: 'robinhood', dexId: 'uniswap', pairAddress: A(9999), baseToken: { address: j }, priceUsd: String(marche.get(j).prix),
      fdv: marche.get(j).fdv, marketCap: marche.get(j).fdv, liquidity: { usd: marche.get(j).liq }, volume: { h24: 1234 }, txns: { h24: { buys: 10, sells: 5 } }, priceChange: { h24: -12 } }));
    return { ok: true, status: 200, text: async () => JSON.stringify(corps) };
  };
  const C = K.cree({ dossier, prendre, horloge: () => H.now });
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
  eq(b.C.aLire().length, K.META_PAR_CYCLE, 'au plus 4 jetons par cycle');
  b.C.meta(A(1), { nom: 'Doge AI Agent', symbole: 'DAGI', description: 'The first AI dog on Robinhood Chain', socials: ['https://x.com/dagi', 'https://t.me/dagi', 'https://dagi.xyz'], logo: 'ipfs://x' });
  const f1 = b.C._fiches.get(A(1));
  ok(f1.th.includes('ai') && f1.th.includes('dog') && f1.th.includes('robinhood'), 'themes tires du nom et de la description : ' + f1.th.join(','));
  ok(f1.res.x && f1.res.tg && f1.res.site && f1.res.n === 3, 'reseaux : X, Telegram, site');
  ok(!b.C.aLire().some((x) => x.jeton === A(1)), 'lu : il quitte la file');
  b.C.meta(A(2), null); b.C.meta(A(2), null);
  ok(b.C.aLire().length === 4 && b.C._etat().file.some((x) => x.jeton === A(2)), 'deux lectures vides : encore en file (en fin)');
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

  console.log('-- 6. branche dans les lancements et le serveur');
  const src = fs.readFileSync(path.join(__dirname, 'smart_lancements.js'), 'utf8');
  ok(/s\.t2 = \{ acheteurs: j2\.acheteurs[^\n]*\n[^\n]*\n\s*if \(deps\.carnet\) \{ try \{ deps\.carnet\.naissance\(/.test(src), 'au T+2 de CHAQUE courbe (pas seulement les alertees) : naissance au carnet');
  ok(/if \(deps\.carnet\) await metasDuCarnet\(bilan\);/.test(src) && /catch \(e\) \{ bilan\.carnetMetas = 'erreur/.test(src), 'les metadonnees en fin de cycle ; une erreur ne coupe rien');
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
  ok(lots.length === 1 && lots[0] === 10, 'deux jetons : UN lot de 10 eth_call (nom, symbole, description, reseaux, logo)');
  const m1 = pris.find((x) => x.meta === A(1)), m2 = pris.find((x) => x.meta === A(2));
  ok(m1 && m1.m && m1.m.nom === 'Dog One' && m1.m.symbole === 'DOG1' && m1.m.description === 'hello' && m1.m.logo === 'ipfs://l', 'A1 : nom, symbole, description, logo decodes');
  ok(m2 && m2.m === null && bl.carnetMetas === 2, 'A2 sans reponse : null (relu plus tard)');
  R.lot = async () => { throw new Error('budget'); };
  const bl2 = {};
  await LZ._metasDuCarnet(bl2);
  ok(/^erreur/.test(bl2.carnetMetas), 'un lot refuse : note, rien ne casse');
  const M = require('./smart_money');
  ok(typeof M.cree({ env: { SMART_MONEY: '1' } }).carnetLancements === 'function' && M.cree({ env: { SMART_MONEY: '1' } }).carnetLancements().actif === false, 'smart_money : carnetLancements (inactif avant l allumage)');
  ok(/path === '\/ai\/smart\/lancements'/.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')), 'la route /ai/smart/lancements (meme debit que /ai/smart)');

  console.log(rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK');
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
