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
  /* Les agents ecrits a la main (les 5 d origine et leurs variations) ; les parametriques du
     tournoi sont tires au hasard et testes a part (section 6). */
  const fixes = (l) => l.filter((p) => !p.agent.startsWith('p_'));
  ok(fixes(E.ouverts).length === 1 && E.ouverts.find((p) => p.agent === 'coin').cote === 'Up', 'a 7 min 30, prix immobile : seul le temoin Coin parie (au hasard : 0,3 → Up) ; Fair Value ne voit aucun ecart');
  ok(vu.bougies.some((r) => r.startTime === (DEBUT - 60) * 1000 && r.endTime - r.startTime === 60000), 'TWAP 60 s : le prix de reference est la minute AVANT l ouverture');
  const p0 = E.ouverts.find((p) => p.agent === 'coin'), nAvant = E.ouverts.length;
  ok(pres(p0.parts, 10 / 0.55) && pres(p0.frais, 10 / 0.55 * 0.07 * 0.55 * 0.45) && pres(p0.prix, 0.55), 'achat de 10 $ au prix demande (0,55), frais officiels : ' + p0.frais.toFixed(4) + ' $');
  await c.tic();
  ok(c._etat().ouverts.length === nAvant, 'un seul pari par agent et par fenetre, meme si le tic se repete dans la bande');

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
  ok(v.recent.length === Math.min(avant, 60) && /^https:\/\/polymarket\.com\/event\/btc-updown-15m-\d+$/.test(v.recent[0].url) && !JSON.stringify(v).includes('NaN'), 'la vue : les paris regles, le lien du marche, aucun NaN');
  /* 30/09 : « classe du plus gagnant au plus perdant ». */
  const trie = (l) => l.every((x, i) => i === 0 || l[i - 1].pnl >= x.pnl);
  /* Le tournoi : 5 temoins + SLOTS_STRATEGIES places (variations a la main + parametriques). */
  const ATTENDU = P.AGENTS.filter((a) => a.type === 'baseline').length + P.SLOTS_STRATEGIES;
  ok(v.ranking.length === ATTENDU && trie(v.ranking) && v.ranking[0].pnl > 0,
     'le classement : les ' + v.ranking.length + ' strategies en course, du plus gagnant au plus perdant (en tete : ' + v.ranking[0].id + ', ' + v.ranking[0].pnl + ' $)');
  ok(trie(v.agents), 'les cartes aussi, dans le meme ordre');
  const RES = v.summary, regles = v.ranking.filter((c) => c.resolved > 0);
  ok(RES.total === ATTENDU && RES.inProfit === regles.filter((c) => c.pnl > 0).length && RES.inLoss === regles.filter((c) => c.pnl < 0).length
     && RES.noSettledBet === ATTENDU - regles.length && RES.judgeable === 0,
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
    const parAgent = new Map(c6._etat().params.map(P.agentParam).map((a) => [a.id, a]));
    const typesParies = new Set(ouv.map((p) => parAgent.get(p.agent).config.type));
    ok(ouv.length >= 20, ouv.length + ' paris places par ' + new Set(ouv.map((p) => p.agent)).size + ' strategies parametriques sur une seule fenetre');
    ok(typesParies.size === 6, 'chacun des six types a parie au moins une fois : ' + [...typesParies].join(', '));
    ok(ouv.every((p) => { const b = parAgent.get(p.agent).bande; return p.resteS <= b[0] && p.resteS >= b[1]; }), 'chaque pari tombe dans la fenetre de sa strategie');
    ok(new Set(ouv.map((p) => p.agent)).size === ouv.length, 'une strategie, un pari par fenetre et par actif');
    ok(ouv.filter((p) => parAgent.get(p.agent).config.type === 'momentum').every((p) => p.resteS <= 540 && p.cote === 'Up'), 'Momentum : jamais avant une minute d historique, et du cote qui monte');
    ok(ouv.filter((p) => parAgent.get(p.agent).config.priceFilter).every((p) => p.prix >= 0.10 && p.prix <= 0.90), 'filtre de prix tenu sur les paris reels');
    const v6 = c6.etat();
    ok(v6.totalStrategies === 405 && v6.parametric.running === 305 && v6.parametric.distinct === 2460 && /not simulated/.test(v6.parametric.note),
       'la vue dit ce qui tourne : 405 strategies (5 temoins, 95 a la main, 305 parametriques sur 2 460 distinctes), et ce qui n est pas simule');
  }

  /* ---- 7. LE TOURNOI (30/09/2026) ----
     « Au bout de 500 bets, s il est toujours en negatif, l agent se supprime et un nouveau avec
     des parametres jamais essayes apparait ; retenir tous les agents et parametres essayes. » */
  console.log('\n-- 7. le tournoi : retire en perte a 500, remplace par du jamais essaye --');
  {
    const d7 = fs.mkdtempSync(path.join(os.tmpdir(), 'poly7-'));
    let graine = 7; const lcg = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
    const c7 = P.cree({ dossier: d7, lire, hl, maintenant: () => T * 1000, alea: lcg });
    let v7 = c7.etat(); const E7 = c7._etat();
    const nonTemoins = () => c7.etat().ranking.filter((r) => r.type !== 'baseline').length;
    ok(nonTemoins() === P.SLOTS_STRATEGIES && v7.tournament.controls === 5 && v7.tournament.threshold === 500,
       'au depart : ' + P.SLOTS_STRATEGIES + ' places hors temoins, les 5 d origine en temoins, jugement a 500 paris regles');
    const tousVus = new Set(E7.params.map((c) => P.agentParam(c).id));
    ok(tousVus.size === E7.params.length, 'aucun comportement en double parmi les ' + E7.params.length + ' parametriques en course');

    const [X, Y, Z] = E7.params.slice(0, 3).map(P.agentParam);
    const H = P.AGENTS.find((a) => a.type !== 'baseline' && a.type !== 'parametric');
    const pose = (id, resolus, pnl) => Object.assign(E7.agents[id], { resolus, paris: resolus, pnl });
    pose(X.id, 500, -3.5); pose(Y.id, 500, 2); pose(Z.id, 499, -50); pose(H.id, 520, -1); pose('coin', 5000, -100);
    E7.ouverts.push({ id: X.id + ':btc:1', agent: X.id, actif: 'btc', debut: DEBUT, cote: 'Up', parts: 1, prix: 0.5, depense: 0.5, frais: 0 });
    c7._tournoi();
    const enCourse = (id) => c7.etat().ranking.some((r) => r.id === id);
    ok(!enCourse(X.id) && E7.essayes[X.id] && E7.essayes[X.id].pnl === -3.5 && E7.essayes[X.id].resolved === 500 && /red after 500/.test(E7.essayes[X.id].reason),
       'en perte a 500 paris regles : retire, et inscrit au registre avec son bilan (−3,50 $)');
    ok(enCourse(Y.id) && E7.agents[Y.id].palier === 1000, 'en gain a 500 : il reste, et sera rejuge a 1 000');
    ok(enCourse(Z.id), 'a 499 paris, meme a −50 $ : pas encore juge (le hasard domine sous 500)');
    ok(!enCourse(H.id) && E7.horsJeu.includes(H.id) && E7.essayes[H.id], 'une variation ecrite a la main suit la meme regle : retiree, gardee au registre');
    ok(enCourse('coin'), 'le temoin Coin n est jamais retire, meme a −100 $ sur 5 000 paris');
    ok(nonTemoins() === P.SLOTS_STRATEGIES, 'les deux places liberees sont reprises : toujours ' + P.SLOTS_STRATEGIES + ' hors temoins');
    const neufs = E7.params.map((c) => P.agentParam(c).id).filter((id) => !tousVus.has(id));
    ok(neufs.length === 2 && neufs.every((id) => !E7.essayes[id] && E7.agents[id] && E7.agents[id].paris === 0), 'les remplacants sont deux comportements jamais essayes, partis de zero');

    ok(E7.agents[X.id] && E7.essayes[X.id].final === false, 'un pari encore ouvert : le retire garde son compte jusqu au reglement');
    E7.ouverts = E7.ouverts.filter((p) => p.agent !== X.id); E7.agents[X.id].resolus = 501; E7.agents[X.id].pnl = -4;
    c7._tournoi();
    ok(!E7.agents[X.id] && E7.essayes[X.id].final === true && E7.essayes[X.id].resolved === 501 && E7.essayes[X.id].pnl === -4, 'regle : bilan definitif au registre (501 paris, −4 $), compte libere');

    pose(Y.id, 999, -1); c7._tournoi();
    ok(enCourse(Y.id), 'a 999 paris, passe en perte : pas encore rejuge');
    pose(Y.id, 1000, -1); c7._tournoi();
    ok(!enCourse(Y.id) && E7.essayes[Y.id].resolved === 1000, 'a 1 000, en perte : retire a son tour');

    v7 = c7.etat();
    ok(v7.tournament.retired === 3 && v7.tournament.recentlyRetired.some((r) => r.id === X.id && r.pnl === -4) && /never tried/.test(v7.tournament.rule),
       'la vue : 3 retires, le registre recent avec leur bilan, la regle en clair');
    ok(v7.ranking.filter((r) => r.type !== 'baseline').every((r) => r.nextJudgedAt >= 500) && v7.ranking.find((r) => r.id === 'coin').nextJudgedAt === null,
       'chaque strategie dit a quel palier elle sera jugee ; un temoin, jamais');

    c7.arrete();
    const c8 = P.cree({ dossier: d7, lire, hl, maintenant: () => T * 1000, alea: lcg }); c8.charge();
    const E8 = c8._etat();
    ok(Object.keys(E8.essayes).length === 3 && E8.params.length === E7.params.length && E8.horsJeu.includes(H.id) && c8.etat().ranking.length === v7.ranking.length,
       'un redemarrage relit le registre, les parametriques en course et les retires');

    /* Tout epuiser : jamais deux fois le meme comportement, et plus de place que de neufs ne casse rien. */
    const deja = new Set(Object.keys(E8.essayes).concat(E8.params.map((c) => P.agentParam(c).id)));
    let doublon = false, tours = 0;
    while (E8.params.length && tours++ < 20) {
      for (const c of E8.params) { const id = P.agentParam(c).id; pose8(id); }
      for (const a of P.AGENTS) if (a.type !== 'baseline' && a.type !== 'parametric' && E8.agents[a.id]) pose8(a.id);
      c8._tournoi();
      for (const c of E8.params) { const id = P.agentParam(c).id; if (deja.has(id)) doublon = true; deja.add(id); }
    }
    function pose8(id) { Object.assign(E8.agents[id], { resolus: 500, paris: 500, pnl: -1 }); }
    const vp = c8.etat().tournament;
    ok(!doublon && vp.parametricTried === 2460 && vp.parametricUntried === 0 && E8.params.length === 0,
       'en ' + tours + ' tours, les 2 460 comportements distincts ont tous ete essayes, aucun deux fois ; les places restent vides ensuite');
    ok(Object.keys(E8.essayes).filter((id) => id.startsWith('p_')).length === 2460, 'le registre les retient tous (2 460)');
    fs.rmSync(d7, { recursive: true, force: true });
  }

  /* ---- 8. LE SCORE PAR FENETRE (30/09/2026) ----
     « P·FV 0.5pt · 10:00–8:00 » affichait « Evidence of an edge » (3,15 sur 100 paris) : les quatre
     actifs finissent dans le meme sens 72 % du temps, ces paris ne sont pas independants, et elle
     etait la meilleure de centaines. Le verdict se lit par fenetre, contre une barre qui monte
     avec le nombre de strategies essayees. */
  console.log('\n-- 8. le score par fenetre, la barre des strategies essayees --');
  {
    ok(pres(P.barre(1), 1.645, 0.01) && pres(P.barre(405), 3.66, 0.02) && P.barre(2560) > P.barre(405),
       'la barre : 1,64 pour une seule strategie, ' + P.barre(405).toFixed(2) + ' pour 405, ' + P.barre(2560).toFixed(2) + ' pour 2 560 — plus on cherche, plus elle monte');
    const base = { resolus: 100, pnl: 307, sy: 51, sp: 37.8, v: 17.5 };
    ok(/Too few independent windows to judge \(30\/50/.test(P.verdictAgent(Object.assign({}, base, { nf: 30, fs: 5, fs2: 2.5 }), 405)),
       '100 paris mais 30 fenetres : pas de verdict, et on dit pourquoi (les actifs bougent ensemble)');
    const z315 = { nf: 60, fs: 3.15, fs2: 1 };
    const v315 = P.verdictAgent(Object.assign({}, base, z315), 405);
    ok(/^Promising, not proven: skill 3\.1 per window over 60 windows, below the 3\.7 bar that testing 405 strategies requires/.test(v315),
       'le cas du 30/09 (3,15, en gain) sur 405 essayees : « prometteur », pas « un edge » [' + v315.slice(0, 60) + ']');
    const fort = Object.assign({}, base, { nf: 80, fs: 4, fs2: 1 });
    ok(/^Edge on paper: skill 4\.0.*Not confirmed yet: 0\/100 bets checked against real Polymarket trades/.test(P.verdictAgent(fort, 405)), 'au-dessus de la barre sur le papier : « edge de papier », pas encore confirme par les vrais echanges');
    ok(/^Edge on paper only: .*makes −\$12\.00 over 120 checked bets\. Not tradable as is\.$/.test(P.verdictAgent(Object.assign({}, fort, { ve: 120, veReel: -12 }), 405)), 'au premier prix reellement echange il perd : « pas jouable tel quel »');
    ok(/^Evidence of an edge after fees: skill 4\.0.*holds at the prices really traded next \(\$55\.00 over 120/.test(P.verdictAgent(Object.assign({}, fort, { ve: 120, veReel: 55 }), 405)), 'et seulement s il tient aux vrais prix : la phrase qui dit « edge »');
    const perd = (z) => P.verdictAgent(Object.assign({}, base, { pnl: -5, nf: 80, fs: z, fs2: 1 }), 405);
    ok(!/edge after fees/.test(perd(4)) && /^No edge: loses after the spread and fees \(skill 0\.5/.test(perd(0.5)),
       'bat les prix mais perd apres frais : jamais « edge »');

    /* Le reglement regroupe par fenetre, tous actifs confondus. */
    const W1 = DEBUT + 9000, W2 = W1 + 900, W3 = W2 + 900;
    const fermes = new Set(['btc-' + W1, 'eth-' + W1, 'sol-' + W1, 'btc-' + W2, 'btc-' + W3]);
    const lire9 = async (u) => { const m = u.match(/events\?slug=(\w+)-updown-15m-(\d+)/); if (!m) return lire(u);
      return [{ markets: [Object.assign({}, marche, { closed: fermes.has(m[1] + '-' + m[2]), outcomePrices: fermes.has(m[1] + '-' + m[2]) ? '["1", "0"]' : '["0.5", "0.5"]' })] }]; };
    const d9 = fs.mkdtempSync(path.join(os.tmpdir(), 'poly9-'));
    const c9 = P.cree({ dossier: d9, lire: lire9, hl, maintenant: () => T * 1000, alea: () => 0.3 });
    c9.etat();
    const E9 = c9._etat(), cand = E9.params[0], idc = P.agentParam(cand).id;
    const pari = (agent, actif, debut, cote, prix) => ({ id: agent + ':' + actif + ':' + debut, agent, actif, debut, titre: 't', cote, parts: 10 / prix, prix, depense: 10, frais: 0.1, t: debut, resteS: 500 });
    E9.ouverts.push(pari('crowd', 'btc', W1, 'Up', 0.6), pari('crowd', 'eth', W1, 'Up', 0.7), pari('crowd', 'sol', W1, 'Down', 0.4), pari('crowd', 'btc', W2, 'Up', 0.5),
      pari('crowd', 'btc', W3, 'Up', 0.5), pari('crowd', 'eth', W3, 'Up', 0.5));
    Object.assign(E9.agents[idc], { resolus: 150, paris: 150, pnl: 40 });
    E9.ouverts.push(pari(idc, 'btc', W1, 'Up', 0.5));
    T = W3 + 900 + 60;
    await c9.resous();
    const cr = E9.agents.crowd;
    ok(cr.nf === 2 && pres(cr.fs, (0.4 + 0.3 - 0.4) + 0.5) && pres(cr.fs2, 0.3 * 0.3 + 0.5 * 0.5),
       'trois paris dans une fenetre = une observation : 2 fenetres closes, Σs = 0,8, Σs² = 0,34 (et non 4 paris independants)');
    ok(cr.gr && Math.abs(cr.gr[W3] - 0.5) < 1e-9 && E9.ouverts.some((p) => p.agent === 'crowd' && p.actif === 'eth' && p.debut === W3),
       'une fenetre dont un actif n est pas encore regle reste ouverte : rien de compte a moitie');
    fermes.add('eth-' + W3);
    await c9.resous();
    ok(cr.nf === 3 && pres(cr.fs, 0.8 + 1.0) && !(W3 in cr.gr), 'l autre actif regle : la fenetre se ferme (Σs + 1,0)');
    const jl = fs.readFileSync(path.join(d9, 'poly_papier.jsonl'), 'utf8');
    ok(jl.includes('"agent":"' + idc + '"'), 'une parametrique a 100+ paris regles en gain : ses paris sont de nouveau au journal, pour la verifier');

    Object.assign(E9.agents[idc], { nf: 60, fs: 3.15, fs2: 1 });
    const ev = c9.etat().evidence;
    ok(ev.minWindows === 50 && ev.tested === 405 && pres(ev.bar, 3.66, 0.02) && ev.measured === 1 && ev.proven === 0 && ev.promising === 1
       && ev.leaders[0].id === idc && ev.leaders[0].skillPerWindow === 3.15 && /72%/.test(ev.rule),
       'la vue : 1 strategie mesuree, 0 prouvee, 1 prometteuse, la barre (3,66 pour 405), la regle en clair');
    ok(ev.closest.length === 5 && ev.closest[0].id === 'crowd' && ev.closest[0].windows === 3, 'et celles qui approchent des 50 fenetres, pour voir venir les suivantes');
    const carte = c9.etat().agents.find((a) => a.id === idc);
    ok(carte && carte.windows === 60 && carte.skillPerWindow === 3.15 && /^Promising, not proven/.test(carte.verdict), 'la carte : score par fenetre, nombre de fenetres, verdict prudent');
    fs.rmSync(d9, { recursive: true, force: true });
  }

  /* ---- 9. LE CONTROLE CONTRE LES VRAIS ECHANGES (30/09/2026) ----
     « Comment verifier que les marches existent reellement et qu on pourra reellement miser ? » */
  console.log('\n-- 9. chaque pari regle, compare aux vrais echanges de Polymarket --');
  {
    const W = DEBUT + 18000, t0 = W + 900 - 120;
    const echanges = [
      { outcome: 'Up', timestamp: t0 + 4, price: 0.60, size: 100 },    /* Up : echange a notre prix 4 s apres */
      { outcome: 'Up', timestamp: t0 + 20, price: 0.70, size: 50 },
      { outcome: 'Down', timestamp: t0 + 40, price: 0.30, size: 10 },  /* Down : rien dans les 30 s */
      { outcome: 'Up', timestamp: t0 - 5, price: 0.50, size: 20 } ];  /* avant la decision : ne compte pas */
    const vus9 = [];
    const lire9 = async (u) => {
      if (u.includes('data-api.polymarket.com/trades')) { vus9.push(u); return /offset=0$/.test(u) ? echanges : []; }
      const m = u.match(/events\?slug=(\w+)-updown-15m-(\d+)/);
      if (m && Number(m[2]) === W) return [{ markets: [Object.assign({}, marche, { conditionId: '0xC' + m[1], closed: true, outcomePrices: '["1", "0"]' })] }];
      return lire(u);
    };
    const c9 = P.cree({ lire: lire9, hl, maintenant: () => T * 1000, alea: () => 0.3 });
    c9.etat();
    const E9 = c9._etat();
    const pari = (agent, cote, prix) => ({ id: agent + ':btc:' + W, agent, actif: 'btc', debut: W, titre: 't', cote, parts: 10 / prix, prix, depense: 10, frais: (10 / prix) * 0.07 * prix * (1 - prix), t: t0, resteS: 120 });
    E9.ouverts.push(pari('crowd', 'Up', 0.60), pari('fair', 'Up', 0.55), pari('fade', 'Down', 0.40));
    T = W + 900 + 60;
    await c9.resous();
    const A = E9.agents;
    ok(vus9.length === 1 && /market=0xCbtc&limit=1000&offset=0$/.test(vus9[0]), 'les echanges reels sont lus une fois par marche regle (data-api, par conditionId)');
    ok(A.crowd.ve === 1 && A.crowd.veOk === 1, 'Crowd a 0,60 : un vrai echange de son cote a son prix 4 s apres — obtenable');
    ok(A.fair.ve === 1 && !A.fair.veOk, 'Fair Value a 0,55 : le premier vrai prix apres lui est 0,60 — pas obtenu a son prix');
    const gainReel = (10 / 0.60) - 10 - (10 / 0.60) * 0.07 * 0.60 * 0.40;
    ok(pres(A.fair.veReel, gainReel, 1e-6) && A.fair.vePapier > A.fair.veReel, 'son gain au premier prix reellement echange (0,60) : ' + A.fair.veReel.toFixed(2) + ' $ contre ' + A.fair.vePapier.toFixed(2) + ' $ sur le papier');
    ok(A.fade.ve === 1 && A.fade.veSans === 1 && A.fade.veReel == null, 'Longshot : aucun echange de son cote dans les 30 s — compte a part, pas de prix invente');
    const R = c9.etat().reality;
    ok(R.marketsChecked === 1 && R.betsChecked === 3 && R.fillableAtOurPrice === 1 && R.noTradeWithin === 1 && R.pricedBets === 2 && R.medianMarketVolumeUsd === 60 + 35 + 3 + 10
       && pres(R.avgGapToNextRealPrice, ((0.60 - 0.60) + (0.60 - 0.55)) / 2, 1e-3) && /first price really traded/.test(R.rule),
       'la vue : 1 marche, 3 paris controles, 1 obtenable, 1 sans echange, ecart moyen au prix reel suivant, volume du marche');
    ok(c9.etat().ranking.find((c) => c.id === 'fair').real.checked === 1, 'chaque ligne du classement porte son controle');
    const c10 = P.cree({ lire: async (u) => { if (u.includes('data-api')) throw new Error('503'); return lire9(u); }, hl, maintenant: () => T * 1000, alea: () => 0.3 });
    c10.etat(); c10._etat().ouverts.push(pari('crowd', 'Up', 0.60));
    await c10.resous();
    ok(c10._etat().agents.crowd.resolus === 1 && !c10._etat().agents.crowd.ve, 'data-api en panne : le pari se regle quand meme, simplement non controle');
  }

  fs.rmSync(dossier, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  ' + rates + ' RATE(S)' : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
