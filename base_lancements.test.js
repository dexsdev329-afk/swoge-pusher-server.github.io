'use strict';
/* base_lancements.js : les lancements Clanker/Zora de Base lus sur la chaine, les echanges
   comptes apres le bloc de lancement pendant 24 h, le bilan d'un deployeur contre tous. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const B = require('./base_lancements');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const A = (k) => '0x' + String(k).padStart(40, '0');
const H = (k) => '0x' + String(k).padStart(64, '0');
const WETH = '0x4200000000000000000000000000000000000006';
let tete = 1_000_000, horloge = Date.UTC(2026, 8, 28, 18, 0);
const CHAINE = [];     /* { blockNumber, logIndex, address, topics, data, transactionHash } */
let li = 0;
function pousse(adresse, ev, args, bloc) {
  const f = B.IFC.encodeEventLog(B.IFC.getEvent(ev), args);
  CHAINE.push({ blockNumber: bloc, logIndex: li++, address: adresse, topics: f.topics, data: f.data, transactionHash: H(li) });
}
const clanker = (jeton, admin, piscine, bloc, o) => pousse(B.CLANKER, 'TokenCreated', [(o && o.sender) || admin, jeton, admin, 'img', (o && o.nom) || 'Token ' + jeton.slice(-2), (o && o.sym) || 'T' + jeton.slice(-2), '{}', '{}', 0,
  A(9), piscine, WETH, A(8), A(7), 0, []], bloc);
const zora = (jeton, caller, piscine, bloc, ev) => pousse(B.ZORA, ev || 'CoinCreatedV4', [caller, caller, A(0), WETH, 'ipfs://x', 'Coin ' + jeton.slice(-2), 'C' + jeton.slice(-2), jeton,
  [jeton < WETH ? jeton : WETH, jeton < WETH ? WETH : jeton, 30000, 60, A(0)], piscine, '2.6.0'], bloc);
const Q96 = ethers.BigNumber.from(2).pow(96);
const echange = (piscine, bloc, sqrt) => pousse(B.POOL_MANAGER, 'Swap', [piscine, A(5), 1, -1, sqrt || Q96, 1000, 0, 3000], bloc);
const panne = { on: false };
async function rpc(m, p) {
  if (m === 'eth_blockNumber') return '0x' + tete.toString(16);
  if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + Math.floor(horloge / 1000).toString(16) };
  if (m === 'eth_getLogs') {
    if (panne.on) throw new Error('503 from node');
    const q = p[0], de = parseInt(q.fromBlock, 16), a = parseInt(q.toBlock, 16);
    const adrs = q.address.map((x) => x.toLowerCase()), sujets = q.topics[0];
    return CHAINE.filter((l) => l.blockNumber >= de && l.blockNumber <= a && adrs.includes(l.address.toLowerCase()) && sujets.includes(l.topics[0]))
      .map((l) => Object.assign({}, l, { blockNumber: '0x' + l.blockNumber.toString(16), logIndex: '0x' + l.logIndex.toString(16) }));
  }
  throw new Error('methode ' + m);
}
const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'base-'));
const mk = () => B.cree({ rpc, dossier: dos, maintenant: () => horloge });
const avance = (blocs) => { tete += blocs; horloge += blocs * B.BLOC_MS; };
/* Tourne jusqu'a la tete (en production : 2 000 blocs par tour pour 15 produits entre deux tours). */
const rattrape = async (x) => { for (let i = 0; i < 200 && x.etat().dernierBloc < tete; i++) await x.tour(); };

(async () => {
  console.log('\n-- lire la chaine : les lancements, puis leurs echanges --');
  const X = mk();
  const P = [H(101), H(102), H(103), H(104)];
  const b0 = tete - 1000;
  clanker(A(0xa1), A(0xd1), P[0], b0, { sender: A(0xb07), nom: 'Evil\u0007Name <script>' + 'x'.repeat(80) });
  zora(A(0xa2), A(0xd2), P[1], b0 + 1);
  zora(A(0xa3), A(0xd2), P[2], b0 + 2, 'CreatorCoinCreated');
  echange(P[0], b0);                                  /* meme bloc que le lancement : l'achat du deployeur */
  echange(P[0], b0 + 5, Q96); echange(P[0], b0 + 6, Q96.mul(2));
  echange(H(999), b0 + 7);                            /* une piscine qu'on ne suit pas */
  await X.tour();
  const r = X.recents({ limit: 10 });
  const l0 = r.launches.find((l) => l.token === A(0xa1));
  ok(r.launches.length === 3 && r.launches.map((l) => l.platform).sort().join() === 'clanker,zora,zora-creator', 'Clanker, Zora et les creator coins : trois lancements lus');
  ok(l0.swapsFirstHour === 2 && l0.swaps24h === 2, 'les echanges du bloc de lancement ne comptent pas ; les suivants oui (2)');
  ok(l0.deployer === A(0xd1) && l0.sender === A(0xb07), 'le deployeur (tokenAdmin) et l envoyeur (msgSender) quand ils different');
  ok(!/[\x00-\x1f]/.test(l0.name) && l0.name.length <= 60, 'un nom pose par le deployeur : sans caractere de controle, 60 caracteres au plus');
  const prixJeton = (s, est0) => B.prixDe(s, est0);
  ok(Math.abs(prixJeton(Q96.mul(2), true) / prixJeton(Q96, true) - 4) < 1e-9 && Math.abs(prixJeton(Q96.mul(2), false) / prixJeton(Q96, false) - 0.25) < 1e-9,
     'le prix suit le sens de la paire : sqrt x2 = prix x4 si le jeton est currency0, /4 sinon');
  ok(l0.priceChangePct === (A(0xa1) < WETH ? 300 : -75), 'la variation entre le premier et le dernier echange : ' + l0.priceChangePct + ' %');

  console.log('\n-- 1 h, 24 h, puis juge --');
  echange(P[1], tete + 500); avance(600); await X.tour();         /* 1 499 blocs apres le lancement : ~50 min */
  echange(P[1], tete + 1500); avance(1600); await X.tour();       /* ~1 h 30 apres : 24 h mais pas 1 h */
  const z = X.recents({ limit: 10 }).launches.find((l) => l.token === A(0xa2));
  ok(z.swapsFirstHour === 1 && z.swaps24h === 2, 'la premiere heure et les 24 heures, comptees a part');
  avance(Math.ceil(24 * 3600e3 / B.BLOC_MS)); echange(P[1], tete); avance(10); await rattrape(X);
  const zj = X.createur(A(0xd2)).launches.find((l) => l.token === A(0xa2));
  ok(zj.swaps24h === 2 && zj.judged, 'apres 24 h : plus rien ne compte, le jeton est juge');

  console.log('\n-- le bilan d un deployeur, contre tous --');
  const d2 = X.createur(A(0xd2));
  ok(d2.record.tokens === 2 && d2.record.judged === 2 && !d2.record.enough && /2\/5/.test(d2.record.note), 'deux jetons juges : pas de comparaison (2/5)');
  for (let k = 0; k < 5; k++) { clanker(A(0xc0 + k), A(0xd9), H(200 + k), tete + 1 + k); if (k < 4) echange(H(200 + k), tete + 10 + k); }
  avance(40); await X.tour();
  avance(Math.ceil(24 * 3600e3 / B.BLOC_MS) + 10); await rattrape(X);
  const d9 = X.createur(A(0xd9));
  ok(d9.record.enough && d9.record.judged === 5 && d9.record.tradedWithin24hPct === 80 && Array.isArray(d9.record.ci95), 'cinq jetons juges : 80 % echanges en 24 h, avec son intervalle de confiance');
  ok(d9.reference.judged === 8 && d9.reference.tradedWithin24hPct === 75, 'la reference : tous les jetons juges de la fenetre (6 sur 8 echanges)');
  ok(X.createur(A(0xb07)).record.tokens === 1, 'une adresse retrouvee aussi comme envoyeur');

  console.log('\n-- filtres, panne, redemarrage, fenetre --');
  clanker(A(0xe1), A(0xd5), H(301), tete + 1); zora(A(0xe2), A(0xd6), H(302), tete + 2); echange(H(302), tete + 3);
  avance(10); await X.tour();
  ok(X.recents({ platform: 'zora' }).launches.every((l) => l.platform.startsWith('zora')) && X.recents({ traded_only: true }).launches.every((l) => l.swaps24h > 0)
     && X.recents({ limit: 1 }).launches.length === 1, 'plateforme, echanges seulement, limite');
  const avant = X.etat().dernierBloc;
  panne.on = true; avance(50); await X.tour(); panne.on = false;
  ok(X.etat().dernierBloc === avant && X.MESURE.erreurs === 1 && /503/.test(X.MESURE.derniereErreur), 'le noeud en panne : rien de perdu, le bloc repris au tour suivant');
  await X.tour(); X.sauve();
  const Y = mk();
  ok(Y.recents({ limit: 25 }).launches.length === X.recents({ limit: 25 }).launches.length && Y.etat().dernierBloc === X.etat().dernierBloc, 'relu apres un redemarrage : memes lancements, meme bloc');
  ok(/indexedSince/.test(JSON.stringify(Y.recents().window)) && /untrusted/.test(Y.recents().window.note), 'chaque reponse dit depuis quand on indexe, et que les noms ne sont pas surs');
  avance(Math.ceil(8 * 24 * 3600e3 / B.BLOC_MS)); await rattrape(Y);
  ok(Y.etat().lancements === 0, 'au-dela de 7 jours : oublie');
  process.env.BASE_LANCEMENTS = '0';
  ok((await mk().tour()) === null, 'BASE_LANCEMENTS=0 coupe');
  delete process.env.BASE_LANCEMENTS;
  ok(JSON.stringify(B.wilson(4, 5)) === '[37.6,96.4]', 'Wilson 4/5 : [37,6 ; 96,4]');

  fs.rmSync(dos, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
