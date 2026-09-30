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
  /* 30/09 : « classe du plus gagnant au plus perdant ». */
  const trie = (l) => l.every((x, i) => i === 0 || l[i - 1].pnl >= x.pnl);
  ok(v.ranking.length === P.AGENTS.length && trie(v.ranking) && v.ranking[0].pnl > 0 && v.ranking[0].id === 'coin',
     'le classement : les ' + v.ranking.length + ' strategies, du plus gagnant au plus perdant (en tete : ' + v.ranking[0].id + ', ' + v.ranking[0].pnl + ' $)');
  ok(trie(v.agents), 'les cartes aussi, dans le meme ordre');
  const RES = v.summary, regles = v.ranking.filter((c) => c.resolved > 0);
  ok(RES.total === P.AGENTS.length && RES.inProfit === regles.filter((c) => c.pnl > 0).length && RES.inLoss === regles.filter((c) => c.pnl < 0).length
     && RES.noSettledBet === P.AGENTS.length - regles.length && RES.judgeable === 0,
     'le resume compte gagnantes (' + RES.inProfit + '), perdantes (' + RES.inLoss + '), sans pari regle (' + RES.noSettledBet + '), et aucune jugeable sous 100');

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

  /* ---- 6. LES STRATEGIES PARAMETRIQUES PARIENT VRAIMENT ----
     La premiere version en chargeait 100 dont AUCUNE ne pariait (type non traite dans la
     decision), et qui etaient cent copies du meme comportement. */
  console.log('\n-- 6. les strategies parametriques --');
  {
    const PR = P.AGENTS.filter((a) => a.type === 'parametric');
    const cles = new Set(PR.map((a) => JSON.stringify(a.config)));
    const types = new Set(PR.map((a) => a.config.type));
    ok(PR.length === 100 && cles.size === 100, '100 strategies parametriques, 100 comportements distincts');
    ok(types.size === 6, 'les six types sont representes : ' + [...types].join(', '));
    ok(P.PARAM.combinaisons === 110700 && P.PARAM.distincts === 2460, 'sur 110 700 combinaisons, 2 460 comportements distincts une fois retires Kelly, prise de profit et stop-loss (non simules)');
    ok(PR.every((a) => !('kelly' in a.config) && !('profitTarget' in a.config) && !('stopLoss' in a.config)), 'aucune ne pretend un reglage que le moteur ne simule pas');
    const P2 = P.choisisParametriques(require('./poly_strategies').creeStrategies(), 100);
    ok(JSON.stringify(P2.choisis) === JSON.stringify(PR.map((a) => a.config)), 'le choix est deterministe : les identifiants survivent a un redemarrage');

    /* La decision, cas par cas. */
    const d = P.decide, A = (prix) => ({ prix, frais: 0, parts: 10 });
    ok(d({ type: 'crowd', seuil: 0.6 }, { mUp: 0.65 }) === 'Up' && d({ type: 'crowd', seuil: 0.6 }, { mUp: 0.3 }) === 'Down' && d({ type: 'crowd', seuil: 0.6 }, { mUp: 0.55 }) === null,
       'Crowd : le favori au-dessus du seuil, sinon rien (et elle ne revient pas)');
    ok(d({ type: 'fade', seuil: 0.8 }, { mUp: 0.85 }) === 'Down' && d({ type: 'fade', seuil: 0.8 }, { mUp: 0.7 }) === null, 'Fade : l outsider quand le favori depasse le seuil');
    ok(d({ type: 'meanrev', seuilBas: 0.3, seuilHaut: 0.65 }, { mUp: 0.7 }) === 'Down' && d({ type: 'meanrev', seuilBas: 0.3, seuilHaut: 0.65 }, { mUp: 0.25 }) === 'Up'
       && d({ type: 'meanrev', seuilBas: 0.3, seuilHaut: 0.65 }, { mUp: 0.5 }) === 'attend', 'MeanRev : contre les extremes, sinon elle revient au tic suivant');
    ok(d({ type: 'momentum', force: 0.02 }, { mUp: 0.6, mUpAvant: null }) === 'attend', 'Momentum sans prix d il y a une minute : elle attend, elle ne devine pas');
    ok(d({ type: 'momentum', force: 0.02 }, { mUp: 0.6, mUpAvant: 0.55 }) === 'Up' && d({ type: 'momentum', force: 0.02 }, { mUp: 0.5, mUpAvant: 0.55 }) === 'Down'
       && d({ type: 'momentum', force: 0.02 }, { mUp: 0.56, mUpAvant: 0.55 }) === 'attend', 'Momentum : le cote qui a monte d au moins la force en une minute');
    ok(d({ type: 'fair_value', marge: 0.03 }, { modele: 0.7, aUp: A(0.6), aDown: A(0.42) }) === 'Up' && d({ type: 'fair_value', marge: 0.03 }, { modele: 0.61, aUp: A(0.6), aDown: A(0.42) }) === 'attend',
       'Fair Value : quand le modele bat le prix demande de la marge, sinon elle revient');
    ok(d({ type: 'vol_weighted', volThreshold: 0.8 }, { modele: 0.9, aUp: A(0.6), sig: 0.001, sigRef: null }) === 'attend'
       && d({ type: 'vol_weighted', volThreshold: 0.8 }, { modele: 0.9, aUp: A(0.6), sig: 0.001, sigRef: 0.001 }) === 'attend'
       && d({ type: 'vol_weighted', volThreshold: 0.8 }, { modele: 0.9, aUp: A(0.6), sig: 0.0007, sigRef: 0.001 }) === 'Up', 'VolFV : seulement sous le multiple de la moyenne longue, et jamais sans elle');
    ok(d({ type: 'crowd', seuil: 0.6, volFilter: true }, { mUp: 0.65, sig: 0.002, sigRef: 0.001 }) === null && d({ type: 'crowd', seuil: 0.6, volFilter: true }, { mUp: 0.65, sig: 0.001, sigRef: 0.001 }) === 'Up',
       'filtre de volatilite : rien quand σ depasse sa moyenne longue');
    ok(d({ type: 'crowd', seuil: 0.6, priceFilter: true }, { mUp: 0.95, aUp: A(0.96) }) === null && d({ type: 'crowd', seuil: 0.6, priceFilter: true }, { mUp: 0.7, aUp: A(0.71) }) === 'Up',
       'filtre de prix : jamais au-dessus de 90 ¢');

    /* Une fenetre entiere, le prix du Up monte de 0,50 a 0,80 et BTC de 100 a 100,3. */
    const D6 = DEBUT + 2700;
    let pUp = 0.5, S6 = 100;
    const lire6 = async (u) => {
      if (u.includes('btc-updown-15m-' + D6)) return [{ markets: [Object.assign({}, marche, { closed: false })] }];
      if (/events\?slug=/.test(u)) return [];
      const m = u.match(/book\?token_id=(\w+)/);
      const p = m[1] === 'U' ? pUp : 1 - pUp;
      return { asks: [{ price: (p + 0.01).toFixed(3), size: '1000' }], bids: [{ price: (p - 0.01).toFixed(3), size: '1000' }] };
    };
    const hl6 = async (b) => (b.type === 'allMids' ? { BTC: String(S6), ETH: '1', SOL: '1', XRP: '1' } : hl(b));
    const c6 = P.cree({ lire: lire6, hl: hl6, maintenant: () => T * 1000, alea: () => 0.3 });
    for (let reste = 600; reste >= 20; reste -= 15) {
      const x = (600 - reste) / 580; pUp = 0.5 + 0.3 * x; S6 = 100 + 0.3 * x; T = D6 + 900 - reste;
      await c6.tic();
    }
    const ouv = c6._etat().ouverts.filter((p) => p.agent.startsWith('p_'));
    const parAgent = new Map(PR.map((a) => [a.id, a]));
    const typesParies = new Set(ouv.map((p) => parAgent.get(p.agent).config.type));
    ok(ouv.length >= 20, ouv.length + ' paris places par ' + new Set(ouv.map((p) => p.agent)).size + ' strategies parametriques sur une seule fenetre');
    ok(typesParies.size === 6, 'chacun des six types a parie au moins une fois : ' + [...typesParies].join(', '));
    ok(ouv.every((p) => { const b = parAgent.get(p.agent).bande; return p.resteS <= b[0] && p.resteS >= b[1]; }), 'chaque pari tombe dans la fenetre de sa strategie');
    ok(new Set(ouv.map((p) => p.agent)).size === ouv.length, 'une strategie, un pari par fenetre et par actif');
    ok(ouv.filter((p) => parAgent.get(p.agent).config.type === 'momentum').every((p) => p.resteS <= 540 && p.cote === 'Up'), 'Momentum : jamais avant une minute d historique, et du cote qui monte');
    ok(ouv.filter((p) => parAgent.get(p.agent).config.priceFilter).every((p) => p.prix >= 0.10 && p.prix <= 0.90), 'filtre de prix tenu sur les paris reels');
    const v6 = c6.etat();
    ok(v6.totalStrategies === 200 && v6.parametric.running === 100 && v6.parametric.distinct === 2460 && /not simulated/.test(v6.parametric.note),
       'la vue dit ce qui tourne : 200 strategies, dont 100 parametriques sur 2 460 distinctes, et ce qui n est pas simule');
  }

  fs.rmSync(dossier, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  ' + rates + ' RATE(S)' : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
