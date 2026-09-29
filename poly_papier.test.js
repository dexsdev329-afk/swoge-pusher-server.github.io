'use strict';
/* poly_papier.js : la colonie papier des marches Polymarket de 15 min. Achats simules au prix
   DEMANDE en remontant le carnet, frais officiels (parts × taux × p × (1 − p), taux LU sur le
   marche), resolution par TWAP 60 s, un pari par agent et par fenetre, le temoin « Coin », la
   calibration au score de Brier, aucun verdict sous 100 paris resolus, rien d'autre que du papier. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./poly_papier');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };
const pres = (a, b, e) => Math.abs(a - b) < (e || 1e-9);

console.log('-- 1. les calculs --');
{
  const r = P.remplit([{ price: '0.5', size: '100' }], 50, 0.07);
  ok(pres(r.parts, 100) && pres(r.frais, 1.75), 'l exemple de la doc Polymarket : 100 parts a 0,50 → 1,75 $ de frais');
  const w = P.remplit([{ price: '0.6', size: '100' }, { price: '0.5', size: '10' }], 10, 0.07);
  ok(pres(w.parts, 10 + 5 / 0.6) && pres(w.depense, 10) && w.meilleur === 0.5 && w.prix > 0.5 && w.prix < 0.6, 'on remonte le carnet du moins cher au plus cher : 10 parts a 0,50 puis le reste a 0,60');
  ok(P.remplit([], 10, 0.07) === null && P.remplit([{ price: '1', size: '5' }, { price: '0', size: '5' }], 10, 0.07) === null, 'carnet vide ou prix hors ]0,1[ : rien');
  ok(pres(P.probaUp(100, 100, 0.001, 300, 60), 0.5, 1e-6) && P.probaUp(101, 100, 0.001, 300, 60) > 0.99 && P.probaUp(99, 100, 0.001, 300, 60) < 0.01, 'le modele : 0,5 sans mouvement, et il suit le mouvement');
  ok(pres(P.varianceRestante(0.001, 300, 60), 0.001 * 0.001 / 60 * (240 + 20)) && pres(P.varianceRestante(0.001, 30, 60), 0.001 * 0.001 / 60 * 27000 / 10800),
     'la variance d une moyenne de 60 s : σ²(τ − L + L/3), puis σ²τ³/(3L²) dans la derniere minute');
  ok(P.varianceRestante(0.001, 300, 60) < P.varianceRestante(0.001, 300, 0), 'une fin en moyenne varie MOINS qu un prix de fin');
  ok(P.sigma(Array.from({ length: 10 }, () => ({ c: 1 }))) === null, 'moins de 20 rendements : pas de volatilite, donc pas de modele');
  ok(pres(P.phi(0), 0.5, 1e-7) && pres(P.phi(1.96), 0.975, 1e-3), 'la loi normale');
}

/* ---- un faux monde : une fenetre BTC (les autres actifs n'existent pas), une horloge ---- */
const DEBUT = 1790690400;           /* multiple de 900 */
let T = DEBUT + 900 - 450;
let marche = { outcomes: '["Up", "Down"]', clobTokenIds: '["U", "D"]', feesEnabled: true, feeSchedule: { rate: 0.07 }, orderMinSize: 5,
  cryptoMarketConfig: { twapEnabled: true, twapLookbackSeconds: 60 }, question: 'Bitcoin Up or Down - test', closed: false, outcomePrices: '["0.55", "0.45"]' };
const livres = { U: { asks: [{ price: '0.55', size: '1000' }], bids: [{ price: '0.53', size: '1000' }] }, D: { asks: [{ price: '0.47', size: '1000' }], bids: [{ price: '0.45', size: '1000' }] } };
let S = 100.0;   /* aucun mouvement a 7 min 30 : Fair Value n'a rien a acheter */
const vu = { bougies: [], evenements: 0 };
const lire = async (u) => {
  if (/events\?slug=btc-updown-15m-/.test(u)) { vu.evenements++; return u.endsWith(String(DEBUT)) ? [{ markets: [marche] }] : []; }
  if (/events\?slug=/.test(u)) return [];
  const m = u.match(/book\?token_id=(\w+)/); if (m) return livres[m[1]];
  throw new Error('inattendu ' + u);
};
const hl = async (b) => {
  if (b.type === 'allMids') return { BTC: String(S), ETH: '1', SOL: '1', XRP: '1' };
  if (b.type === 'candleSnapshot') {
    vu.bougies.push(b.req);
    if (b.req.endTime - b.req.startTime === 60000) return [{ t: b.req.startTime, o: '99.9', h: '100.2', l: '99.8', c: '100.1' }];
    return Array.from({ length: 90 }, (_, i) => ({ t: b.req.startTime + i * 60000, c: String(100 * (1 + (i % 2 ? 0.001 : -0.001))) }));
  }
  throw new Error('hl inattendu');
};
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-'));
const mk = () => P.cree({ dossier, lire, hl, maintenant: () => T * 1000, alea: () => 0.3 });

(async () => {
  console.log('\n-- 2. une fenetre, cinq agents --');
  const c = mk();
  await c.tic();
  let E = c._etat();
  ok(E.ouverts.length === 1 && E.ouverts[0].agent === 'coin' && E.ouverts[0].cote === 'Up', 'a 7 min 30, prix immobile : seul le temoin Coin parie (au hasard : 0,3 → Up) ; Fair Value ne voit aucun ecart');
  ok(vu.bougies.some((r) => r.startTime === (DEBUT - 60) * 1000 && r.endTime - r.startTime === 60000), 'TWAP 60 s : le prix de reference est la minute AVANT l ouverture');
  const p0 = E.ouverts[0];
  ok(pres(p0.parts, 10 / 0.55) && pres(p0.frais, 10 / 0.55 * 0.07 * 0.55 * 0.45) && pres(p0.prix, 0.55), 'achat de 10 $ au prix demande (0,55), frais officiels : ' + p0.frais.toFixed(4) + ' $');
  await c.tic();
  ok(c._etat().ouverts.length === 1, 'un seul pari par agent et par fenetre, meme si le tic se repete dans la bande');

  T = DEBUT + 900 - 280; S = 100.3;
  await c.tic(); E = c._etat();
  const ag = (id) => E.ouverts.filter((p) => p.agent === id);
  ok(ag('crowd').length === 1 && ag('crowd')[0].cote === 'Up', 'a 4 min 40 : Crowd achete le favori (Up, milieu 0,54)');
  ok(ag('fair').length === 1 && ag('fair')[0].cote === 'Up' && ag('fair')[0].modele > 0.65, 'Fair Value achete quand son modele bat le prix demande apres frais (' + ag('fair')[0].modele + ' contre 0,55)');
  ok(E.calib.attente.length === 1 && pres(E.calib.attente[0].marche, 0.54) && E.calib.attente[0].modele > 0.65, 'a 5 min de la fin : la calibration note le modele ET le marche, sans parier');

  T = DEBUT + 900 - 150;
  await c.tic(); E = c._etat();
  ok(ag('fade').length === 0, 'a 2 min 30 : Longshot ne parie pas, aucun favori au-dessus de 85 ¢');
  T = DEBUT + 900 - 60;
  await c.tic(); E = c._etat();
  ok(ag('late').length === 1, 'Last Minute a parie dans les 90 dernieres secondes');
  const avant = E.ouverts.length;

  console.log('\n-- 3. la resolution --');
  T = DEBUT + 900 + 10;
  await c.tic();
  ok(c._etat().ouverts.length === avant, 'avant la resolution publiee : rien ne se regle');
  marche = Object.assign({}, marche, { closed: true, outcomePrices: '["1", "0"]' });
  T = DEBUT + 900 + 120;
  await c.tic(); E = c._etat();
  const v = c.etat();
  const coin = v.agents.find((a) => a.id === 'coin');
  ok(E.ouverts.length === 0 && coin.resolved === 1 && coin.won === 1, 'Up gagne : les paris sont regles');
  ok(pres(coin.pnl, Math.round((10 / 0.55 - 10 - p0.frais) * 100) / 100, 0.011) && pres(coin.fees, Math.round(p0.frais * 100) / 100, 0.011), 'gain = parts − mise − frais : ' + coin.pnl + ' $, frais ' + coin.fees + ' $');
  ok(coin.bank > 1000 && /Too few resolved bets to judge \(1\/100\)/.test(coin.verdict), 'la banque bouge, mais aucun verdict sur 1 pari');
  ok(v.calibration.n === 1 && v.calibration.brierMarket === Math.round((0.54 - 1) ** 2 * 10000) / 10000 && v.calibration.enough === false,
     'la calibration : score de Brier du marche (0,2116) et du modele, et « pas assez » sous 100');
  ok(v.recent.length === avant && /^https:\/\/polymarket\.com\/event\/btc-updown-15m-\d+$/.test(v.recent[0].url) && !JSON.stringify(v).includes('NaN'), 'la vue : les paris regles, le lien du marche, aucun NaN');

  console.log('\n-- 4. persistance, abandon, frais lus sur le marche --');
  c.arrete();
  const c2 = mk(); c2.charge();
  ok(c2.etat().agents.find((a) => a.id === 'coin').resolved === 1 && c2.etat().calibration.n === 1, 'un redemarrage relit tout sur le disque');
  /* Une fenetre suivante jamais resolue : annulee apres 6 h, mise et frais rendus. */
  const D2 = DEBUT + 900;
  marche = Object.assign({}, marche, { closed: false, feeSchedule: { rate: 0.02 } });
  const lire2 = async (u) => (u.includes('btc-updown-15m-' + D2) ? [{ markets: [marche] }] : lire(u));
  T = D2 + 900 - 450;
  const c3 = P.cree({ dossier, lire: lire2, hl, maintenant: () => T * 1000, alea: () => 0.9 });
  c3.charge();
  await c3.tic();
  const p3 = c3._etat().ouverts.find((p) => p.debut === D2);
  ok(p3 && p3.cote === 'Down' && pres(p3.frais, 10 / 0.47 * 0.02 * 0.47 * 0.53), 'le taux de frais est LU sur le marche (0,02 ici, pas 0,07)');
  const banqueAvant = c3.etat().agents.find((a) => a.id === 'coin').bank;
  T = D2 + 900 + 6 * 3600 + 60;
  await c3.tic();
  const coin3 = c3.etat().agents.find((a) => a.id === 'coin');
  ok(coin3.voided === 1 && coin3.resolved === 1 && pres(coin3.bank, Math.round((banqueAvant + p3.depense + p3.frais) * 100) / 100, 0.011), 'non resolue apres 6 h : annulee, mise et frais rendus, rien de compte');
  c3.arrete();

  console.log('\n-- 5. carnet trop mince --');
  {
    const livresMinces = { U: { asks: [{ price: '0.55', size: '2' }], bids: [{ price: '0.53', size: '2' }] }, D: { asks: [{ price: '0.47', size: '2' }], bids: [{ price: '0.45', size: '2' }] } };
    const D4 = DEBUT + 1800; T = D4 + 900 - 450;
    const lire4 = async (u) => { if (u.includes('btc-updown-15m-' + D4)) return [{ markets: [Object.assign({}, marche, { closed: false })] }]; const m = u.match(/book\?token_id=(\w+)/); if (m) return livresMinces[m[1]]; return lire(u); };
    const c4 = P.cree({ lire: lire4, hl, maintenant: () => T * 1000, alea: () => 0.3 });
    await c4.tic();
    ok(c4._etat().ouverts.length === 0 && c4.etat().agents.find((a) => a.id === 'coin').bets === 0, 'moins de 5 parts disponibles (le minimum du marche) : pas de pari, rien de compte');
  }

  fs.rmSync(dossier, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  ' + rates + ' RATE(S)' : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
