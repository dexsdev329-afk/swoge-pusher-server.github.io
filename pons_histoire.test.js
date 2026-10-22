'use strict';
/*
 * L'HISTOIRE COMPLETE DE PONS (21/10/2026), contre un faux noeud :
 *   1. une requete eth_getLogs par pas, jamais pendant une pause du direct ;
 *   2. les lancements d'abord (usine Pons), puis les courbes depuis le premier
 *      lancement, les piscines v4 des jetons gradues, leurs echanges ;
 *   3. la fenetre se coupe en deux sur « exceeds limit », grandit sous 3 000 ;
 *   4. une phase en retard passe avant les suivantes ; rattrapee, elle laisse la place ;
 *   5. fichiers .jsonl.gz compacts, curseurs relus au redemarrage ;
 *   6. smart_money : client a lui (file et plafond du jour), route /ai/smart/histoire ;
 *   7. noeud DEDIE (PONS_HISTOIRE_RPC_URL, HyperRPC) : la pause du direct ne compte plus,
 *      le conseil « this block range should work: [a, b] » cale la fenetre, les plafonds
 *      et la cadence sont ceux du dedie, l'URL (qui porte le token) n'est jamais servie.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');
const PH = require('./pons_histoire');
const SP = require('./smart_pons');
const A = (i) => '0x' + i.toString(16).padStart(40, '0');
const pad = (x) => '0x' + '0'.repeat(24) + String(x).slice(2);
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const POINTE = 1000000;
const LANCE = 400000;
const ID = '0x' + 'ab'.repeat(32);
function monde() {
  const logs = [];
  const lance = (jeton, courbe, bloc) => logs.push({ address: SP.ADR.USINE_PONS, topics: [SP.TOPIC.LANCE_PONS, pad(jeton), pad(courbe), pad(A(900))], data: '0x' + w(0) + w(1) + w(42) , blockNumber: '0x' + bloc.toString(16), logIndex: '0x0', transactionHash: '0x' + 'aa'.repeat(32) });
  const achat = (courbe, bloc) => logs.push({ address: courbe, topics: [SP.TOPIC.ACHAT, pad(A(777)), pad(A(778))], data: '0x' + w(10) + w(1000), blockNumber: '0x' + bloc.toString(16), logIndex: '0x1', transactionHash: '0x' + 'bb'.repeat(32) });
  const grad = (courbe, bloc) => logs.push({ address: courbe, topics: [SP.TOPIC.GRADUATION_COURBE], data: '0x', blockNumber: '0x' + bloc.toString(16), logIndex: '0x2', transactionHash: '0x' + 'cc'.repeat(32) });
  const init = (jeton, bloc) => logs.push({ address: PH.PM4, topics: [PH.TOPIC_INIT4, ID, pad('0x0000000000000000000000000000000000000000'), pad(jeton)], data: '0x' + w(0).repeat(5), blockNumber: '0x' + bloc.toString(16), logIndex: '0x3', transactionHash: '0x' + 'dd'.repeat(32) });
  const swap = (bloc) => logs.push({ address: PH.PM4, topics: [PH.TOPIC_SWAP4, ID, pad(A(555))], data: '0x' + w(1), blockNumber: '0x' + bloc.toString(16), logIndex: '0x4', transactionHash: '0x' + 'ee'.repeat(32) });
  lance(A(1), A(101), LANCE); lance(A(2), A(102), LANCE + 50000);
  for (let b = LANCE + 10; b < LANCE + 300000; b += 1000) achat(A(101), b);
  grad(A(101), LANCE + 200000); init(A(1), LANCE + 200010); swap(LANCE + 200020); swap(LANCE + 500000);
  return logs;
}
function faux(o) {
  o = o || {};
  const logs = monde();
  const req = [];
  const R = {
    nouvellePasse() {}, jour: () => ({ http: req.length }),
    pointe: async () => ({ pointe: POINTE + 5 }),
    appel: async (m, [f]) => {
      req.push({ m, f });
      const de = parseInt(f.fromBlock, 16), a = parseInt(f.toBlock, 16);
      const t0 = [].concat(f.topics[0]);
      const r = logs.filter((l) => { const b = parseInt(l.blockNumber, 16); if (b < de || b > a) return false; if (f.address && l.address !== f.address) return false; if (!t0.includes(l.topics[0])) return false;
        for (let k = 1; k < f.topics.length; k++) { const v = f.topics[k]; if (v == null) continue; const x = '0x' + l.topics[k].slice(-40); if (!([].concat(v).includes(l.topics[k]) || [].concat(v).includes(x))) return false; } return true; });
      if (o.limite && r.length > o.limite) return { erreur: { message: 'logs matched by query exceeds limit of ' + o.limite } };
      return { result: r };
    },
  };
  return { R, req };
}
(async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'histoire-'));
  let pause = false;
  const F = faux({ limite: 15 });   // 20 achats par fenetre de 20 000 blocs : la fenetre doit se couper
  let H = PH.cree({ R: F.R, dossier, horloge: () => 1, pauseDirect: () => pause });
  console.log('-- 1. une requete par pas, jamais pendant une pause du direct');
  pause = true;
  eq((await H.pas()).fait, 'pause du direct', 'direct en pause : rien');
  eq(F.req.length, 0, 'aucune requete');
  pause = false;
  let r = await H.pas();
  ok(F.req.length === 1 && r.ph === 'lancements' && r.de === 0, 'un pas = une requete ; les lancements d abord, depuis le bloc 0');
  ok(F.req[0].f.address === SP.ADR.USINE_PONS && F.req[0].f.topics[0] === SP.TOPIC.LANCE_PONS, 'filtre : usine Pons, TokenLaunched');
  console.log('-- 2. jusqu a la pointe, toutes les phases');
  for (let k = 0; k < 400; k++) { const x = await H.pas(); if (x.fait === 'a jour') break; }
  const v = H.vue();
  ok(v.compte.lancements === 2 && v.debut === LANCE, '2 lancements, le premier au bloc ' + LANCE);
  ok(v.compte.courbes === 301, '300 achats + 1 graduation sur les courbes (' + v.compte.courbes + ')');
  ok(v.gradues === 1 && v.piscinesTrouvees === 1 && H._etat().aPiscine[A(1)] === ID, 'le jeton gradue et sa piscine v4 (Initialize, currency1)');
  eq(v.compte.echanges, 2, 'les 2 echanges de sa piscine');
  ok(F.req.filter((q) => q.f.topics[0] === PH.TOPIC_SWAP4).every((q) => JSON.stringify(q.f.topics[1]) === JSON.stringify([ID]) && q.f.address === PH.PM4), 'les echanges sont FILTRES par identifiant de piscine, sur le PoolManager');
  console.log('-- 3. la fenetre');
  ok(v.mesure.coupes >= 1 && F.req.every((q) => parseInt(q.f.toBlock, 16) - parseInt(q.f.fromBlock, 16) < 10000000), 'coupee sur « exceeds limit » (' + v.mesure.coupes + ' fois), jamais plus de 10 M blocs');
  console.log('-- 4. fichiers et redemarrage');
  const dl = fs.readdirSync(path.join(dossier, 'pons_histoire', 'lancements'));
  const l0 = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dossier, 'pons_histoire', 'lancements', dl[0]))).toString().split('\n')[0]);
  ok(l0[0] === LANCE && l0[3] === A(1) && l0[4] === A(101) && l0[5] === A(900), 'ligne compacte : bloc, index, tx, jeton, courbe, deployer, cote, seuil');
  const avant = F.req.length;
  H = PH.cree({ R: F.R, dossier, horloge: () => 1, pauseDirect: () => false });
  eq((await H.pas()).fait, 'a jour', 'redemarrage : curseurs relus, rien a relire');
  eq(F.req.length, avant, 'aucune requete de plus');
  console.log('-- 5. une phase en retard passe d abord, rattrapee elle laisse la place');
  const F2 = faux();
  const H2 = PH.cree({ R: F2.R, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'histoire2-')), horloge: () => 1, pauseDirect: () => false });
  const E2 = H2._etat();
  E2.debut = LANCE; E2.curseurs = { lancements: POINTE - 10 };
  ok((await H2.pas()).ph === 'courbes', 'lancements a 10 blocs de la pointe : les courbes avancent');
  E2.curseurs.lancements = POINTE - PH.RATTRAPE - 10;
  ok((await H2.pas()).ph === 'lancements', 'lancements a plus de ' + PH.RATTRAPE + ' blocs : ils repassent devant');
  console.log('-- 6. smart_money');
  const M = require('./smart_money');
  const src = fs.readFileSync(path.join(__dirname, 'smart_money.js'), 'utf8');
  ok(/rythme: SR\.nouveauRythme\(\), budgetAppels: 2/.test(src) && /jourPropre: true,\s*plafondJourHttp: dedie \? PH\.JOUR_HTTP_DEDIE : PH\.JOUR_HTTP/.test(src), 'client a lui : sa file (rythme propre), son plafond du jour (celui du dedie ou du public)');
  ok(/pauseDirect: \(\) => rythme\.pause > deps\.horloge\(\)/.test(src), 'il se tait tant que le direct est en pause');
  ok(typeof M.cree({ env: { SMART_MONEY: '1' } }).histoire === 'function' && M.cree({ env: { SMART_MONEY: '1' } }).histoire().actif === false, 'smart_money.histoire() (inactif avant l allumage)');
  ok(/path === '\/ai\/smart\/histoire'/.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')), 'route /ai/smart/histoire');
  ok(PH.JOUR_HTTP === 3000 && PH.JOUR_OCTETS === 1.5e9, 'plafonds du jour : 3 000 requetes, 1,5 Go');
  console.log('-- 7. le noeud dedie (HyperRPC)');
  {
    const F3 = faux();
    let pause3 = true;
    const H3 = PH.cree({ R: F3.R, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'histoire3-')), horloge: () => 1, dedie: true, pauseDirect: () => pause3 });
    ok((await H3.pas()).fait === 'lu' && F3.req.length === 1, 'dedie : la pause du direct ne le retient pas (un autre noeud)');
    const v3 = H3.vue();
    ok(v3.dedie === true && v3.pasS === 5 && v3.plafonds.http === PH.JOUR_HTTP_DEDIE && v3.plafonds.octets === PH.JOUR_OCTETS_DEDIE, 'vue : dedie, 5 s par pas, 20 000 requetes et 60 Go par jour');
    ok(!JSON.stringify(v3).includes('hypersync') && !JSON.stringify(v3).includes('rpc.'), 'la vue ne porte aucune URL');
    /* le conseil de HyperRPC : la fenetre se cale dessus, sans etre coupee en deux */
    /* le premier pas a mis les lancements a la pointe (fenetre de 2 M blocs) : le suivant ouvre les courbes au premier lancement */
    const E3 = H3._etat();
    const de = E3.curseurs.courbes == null ? E3.debut : E3.curseurs.courbes + 1;
    const conseilA = de + 2727;
    const appelOrig = F3.R.appel;
    let conseille = 0;
    F3.R.appel = async (m, p) => { if (!conseille) { conseille++; return { erreur: { message: 'Limit exceeded: More than 50000 logs returned; this block range should work: [0x' + de.toString(16) + ', 0x' + conseilA.toString(16) + ']' } }; } return appelOrig(m, p); };
    const r3 = await H3.pas();
    ok(r3.fait === 'fenetre conseillee' && r3.ph === 'courbes' && E3.fenetres.courbes === 2728 && H3.vue().mesure.conseils === 1 && H3.vue().mesure.coupes === 0, 'conseil [de, de+2727] : fenetre de 2 728 blocs, comptee comme conseil, pas comme coupe (' + JSON.stringify(r3) + ')');
    const r4 = await H3.pas();
    ok(r4.fait === 'lu' && r4.ph === 'courbes' && r4.de === de && r4.a === conseilA, 'le pas suivant lit exactement la fenetre conseillee (' + JSON.stringify(r4) + ')');
    const srcM = fs.readFileSync(path.join(__dirname, 'smart_money.js'), 'utf8');
    ok(/PONS_HISTOIRE_RPC_URL/.test(srcM) && /optsH\.url = urlH; optsH\.corpsMax = PH\.CORPS_MAX_DEDIE;/.test(srcM), 'smart_money : l URL dediee va au client de l histoire, avec une reponse de 64 Mio admise (33 Mo pour 50 000 evenements)');
    ok(/PONS_HISTOIRE_RPC_URL;\s*const ms = [^\n]*\? 5000 : 30000\)/.test(srcM), 'cadence : 5 s par pas quand le noeud est dedie, 30 s sinon');
    ok(PH.CORPS_MAX_DEDIE === 64 * 1024 * 1024 && PH.PAS_DEDIE_MS === 5000, 'constantes du dedie');
  }
  console.log(rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK');
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
