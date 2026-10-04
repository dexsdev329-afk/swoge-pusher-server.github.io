'use strict';
/* ============================================================================
 * LA BANQUE PAPIER (banque_papier.js, 03/10/2026) — etape 2 de l'observatoire
 *
 * Ce qu'elle DOIT tenir :
 *   1. un achat seulement avec un devis d'achat ET un devis de revente ; sans route de
 *      revente, rien (les 4 jetons Ethereum sur 6 du 03/10) ; aller-retour trop cher, rien ;
 *      la banque vide, rien ;
 *   2. le temoin prend le premier jeton venu apres chaque quart d'heure, sans regarder ses
 *      traits ; un bras n'achete que les jetons de SA case, pas plus d'une fois en 20 min ;
 *   3. ventes chiffrees a 10, 30 et 60 min sur le meme achat ; la banque se regle a 30 min,
 *      nette des frais ; trois tours sans route de vente : zero, jamais un prix invente ;
 *      un 429 n'est pas « sans route » ;
 *   4. un bras perdant au-dela du hasard est retire ; « holds in paper » seulement au-dessus
 *      de la barre, n ≥ 100, deux moities positives ;
 *   5. tout survit au redemarrage ;
 *   6. les quoteurs lisent les VRAIES formes de reponse (Jupiter, KyberSwap, miroir) ;
 *   7. l'observatoire lui passe chaque premier prix et ses cases ; aucune signature nulle part.
 * ==========================================================================*/
const fs = require('fs'), path = require('path'), os = require('os');
const BP = require('./banque_papier');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const MIN = 60e3;
const r2t = (x) => Math.round(x * 100) / 100;

/* Un quoteur factice : par adresse, combien vaut la position en % de la mise (null = pas de route). */
function fauxQuoteur() {
  const Q = { valeur: {}, achatKo: new Set(), quota: false, appels: [], fraisUsd: 0.5 };
  Q.nom = 'faux';
  Q.achat = async (adr, usd) => { Q.appels.push(['achat', adr]); if (Q.quota) { const e = new Error('429'); e.quota = true; throw e; }
    return Q.achatKo.has(adr) ? { ok: false, raison: 'no route' } : { ok: true, recu: String(Math.round(usd * 1000)), fraisUsd: Q.fraisUsd }; };
  Q.vente = async (adr, montant) => { Q.appels.push(['vente', adr]); if (Q.quota) { const e = new Error('429'); e.quota = true; throw e; }
    const v = Q.valeur[adr]; if (v == null) return { ok: false, raison: 'no route' };
    return { ok: true, usd: Number(montant) / 1000 * v / 100, fraisUsd: Q.fraisUsd }; };
  return Q;
}

(async () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'banque-'));
  let T = Date.UTC(2026, 9, 3, 12, 0, 0);
  const Q = fauxQuoteur();
  const B = BP.cree({ dossier: DIR, quoteurs: { solana: Q }, maintenant: () => T, mises: { solana: 25 } });
  const jeton = (a, cases) => ({ addr: a, pool: 'pool-' + a, dexId: 'pumpswap', cases });
  const CAS = 'Pool size = pool $20-100k';

  console.log('-- 1. un achat seulement sur devis d achat ET de revente --');
  Q.valeur.A = 97;                         /* 3 % d aller-retour : achetable */
  B.propose('solana', jeton('A'), ['Venue = pumpswap']);
  await B.tour('solana', []);
  let v = B.vue('solana');
  ok(v.open === 1 && v.counts.control === 1 && v.counts.bought === 1, 'le premier jeton venu est pris par le temoin (sans regarder ses traits)');
  const pA = B._etat('solana').ouvertes[0];
  ok(pA.depense === 25.5 && pA.rt0 === 6.9, 'la depense compte les frais de l achat (25 + 0,5 $) ; aller-retour a l entree 6,9 % : (24,25 - 0,5) / 25,5 [' + pA.depense + ', ' + pA.rt0 + ' %]');
  ok(v.cashUsd === 974.5, 'la banque a paye : 1 000 - 25,5 = 974,5 $');

  T += 16 * MIN;                           /* le temoin peut reprendre */
  B.propose('solana', jeton('NOSELL'), []);           /* pas de route de revente */
  await B.tour('solana', []);
  v = B.vue('solana');
  ok(v.open === 1 && v.counts.refused['cannot sell'] === 1, 'sans route de revente : aucun achat, « cannot sell » compte');
  T += 16 * MIN;
  Q.valeur.CHER = 80;                      /* 20 % d aller-retour */
  B.propose('solana', jeton('CHER'), []);
  await B.tour('solana', []);
  ok(B.vue('solana').counts.refused['round trip too costly'] === 1 && B.vue('solana').entryCost.refusedMedianPct === 23.5, 'aller-retour au-dela de 15 % : refuse, et son cout garde (23,5 % : (20 - 0,5) / 25,5)');
  T += 16 * MIN;
  Q.achatKo.add('NOBUY');
  B.propose('solana', jeton('NOBUY'), []);
  await B.tour('solana', []);
  ok(B.vue('solana').counts.refused['no buy route'] === 1, 'sans route d achat : refuse');

  console.log('\n-- 2. les bras : leur case seulement, une fois par 20 min --');
  T += 5 * MIN;                            /* le temoin a deja tente il y a 5 min : il attend */
  Q.valeur.B1 = 98; Q.valeur.B2 = 98; Q.valeur.HORS = 98;
  B.propose('solana', jeton('HORS'), ['Venue = pumpswap']);
  B.propose('solana', jeton('B1'), [CAS, 'Venue = pumpswap']);
  B.propose('solana', jeton('B2'), [CAS]);
  await B.tour('solana', [CAS]);
  const S = B._etat('solana');
  ok(S.ouvertes.some((p) => p.addr === 'B1' && p.bras === CAS) && !S.ouvertes.some((p) => p.addr === 'HORS'), 'le bras achete un jeton de SA case ; un jeton hors case n est pas achete');
  ok(!S.ouvertes.some((p) => p.addr === 'B2'), 'pas deux achats du meme bras en moins de 20 min');
  ok(B.vue('solana').arms.length === 1 && B.vue('solana').arms[0].state === 'testing', 'le bras est ouvert, « testing »');

  console.log('\n-- 3. ventes a 10, 30 et 60 min ; reglement a 30 ; invendable = 0 --');
  /* Une banque neuve, une horloge propre : un achat du temoin a T3, puis ses trois horizons. */
  let T3 = Date.UTC(2026, 9, 4, 12, 0, 0);
  const Q3 = fauxQuoteur();
  const B3 = BP.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'banque3-')), quoteurs: { solana: Q3 }, maintenant: () => T3 });
  Q3.valeur.A = 97;
  B3.propose('solana', jeton('A'), []); await B3.tour('solana', []);
  const p3 = B3._etat('solana').ouvertes[0];
  Q3.valeur.A = 110;
  T3 = p3.t0 + 10 * MIN; await B3.tour('solana', []);
  ok(p3.valeurs[10] && p3.valeurs[10].usd === 27 && p3.r30 === null, 'a 10 min : vente chiffree (27,5 - 0,5 = 27 $), la banque ne se regle pas encore');
  const cashAvant = B3._etat('solana').cash;
  Q3.valeur.A = 120;
  T3 = p3.t0 + 30 * MIN; await B3.tour('solana', []);
  ok(p3.valeurs[30].usd === 29.5 && p3.r30 === 15.69 && Math.abs(B3._etat('solana').cash - cashAvant - 29.5) < 1e-9, 'a 30 min : 30 - 0,5 = 29,5 $ rentrent, +15,69 % net sur 25,5 $ depenses');
  Q3.valeur.A = null;                       /* le pool a disparu */
  T3 = p3.t0 + 60 * MIN; await B3.tour('solana', []);
  T3 += 3 * MIN; await B3.tour('solana', []);
  ok(p3.valeurs[60] === undefined, 'deux tours sans route a 60 min : on attend encore, rien d invente');
  T3 += 3 * MIN; await B3.tour('solana', []);
  const f3 = B3._etat('solana').fermees.find((p) => p.addr === 'A');
  ok(f3 && f3.valeurs[60].usd === 0 && f3.valeurs[60].invendable, 'au troisieme : zero, marque invendable ; la position sort du livre');
  /* Un 429 n est pas « sans route » : un second achat, sa vente a 10 min sous quota, puis lue. */
  T3 += 16 * MIN; Q3.valeur.Bq = 100;
  B3.propose('solana', jeton('Bq'), []); await B3.tour('solana', []);
  const pq = B3._etat('solana').ouvertes.find((p) => p.addr === 'Bq');
  T3 = pq.t0 + 10 * MIN; Q3.quota = true; await B3.tour('solana', []);
  ok(pq && !pq.essais[10] && pq.valeurs[10] === undefined && B3.vue('solana').counts.rateLimited === 1, 'un 429 : ni essai compte ni valeur, seulement « rateLimited »');
  Q3.quota = false; T3 += 3 * MIN; await B3.tour('solana', []);
  ok(pq.valeurs[10] && pq.valeurs[10].min === 13, 'relu au tour suivant, a 13 min (la minute reelle est gardee)');

  console.log('\n-- 4. le juge : retrait au-dela du hasard ; « holds in paper » sous conditions --');
  const C2 = 'Venue = meteora';
  const S2 = B._etat('solana');
  S2.bras[C2] = { etat: 'actif', depuis: T, dernier: 0 };
  for (let i = 0; i < 60; i++) S2.fermees.push({ addr: 'L' + i, cases: [C2], temoin: false, t0: T - (100 - i) * MIN, depense: 25, r30: -8 + (i % 5), valeurs: { 10: { usd: 1 }, 30: { usd: 1 }, 60: { usd: 1 } } });
  await B.tour('solana', [CAS]);
  const bm = B.vue('solana').arms.find((x) => x.case === C2);
  ok(bm.state === 'retired' && /losing beyond chance/.test(bm.retiredBecause) && bm.n === 60 && bm.t < -2, 'un bras a -6 % sur 60 achats (t ' + bm.t + ') : retire, la raison dite');
  const C3 = 'Market cap = cap $10-50k';
  S2.bras[C3] = { etat: 'actif', depuis: T, dernier: 0 };
  for (let i = 0; i < 100; i++) S2.fermees.push({ addr: 'G' + i, cases: [C3], temoin: false, t0: T - (300 - i) * MIN, depense: 25, r30: 6 + (i % 7) - 3, valeurs: { 10: { usd: 1 }, 30: { usd: 1 }, 60: { usd: 1 } } });
  let bg = B.vue('solana').arms.find((x) => x.case === C3);
  ok(bg.state === 'holds in paper' && bg.n === 100 && bg.t >= B.vue('solana').bar, '+6 % sur 100, deux moities positives, t ' + bg.t + ' au-dessus de la barre ' + B.vue('solana').bar + ' : « holds in paper »');
  S2.fermees = S2.fermees.filter((p) => !(p.addr.startsWith('G') && Number(p.addr.slice(1)) < 50)).concat(Array.from({ length: 50 }, (_, i) => ({ addr: 'H' + i, cases: [C3], temoin: false, t0: T - (500 - i) * MIN, depense: 25, r30: -1 + (i % 3) * 0.1, valeurs: { 10: { usd: 1 }, 30: { usd: 1 }, 60: { usd: 1 } } })));
  bg = B.vue('solana').arms.find((x) => x.case === C3);
  ok(bg.state === 'testing' && bg.moitie1 < 0, 'meme bras, premiere moitie negative (' + bg.moitie1 + ' %) : plus « holds », seulement « testing »');

  console.log('\n-- 5. le banc apparie et le redemarrage --');
  await B.tour('solana', [CAS]);           /* ce tour sauve l etat (les lignes posees a la main plus haut comprises) */
  v = B.vue('solana');
  ok(v.bench.n >= 1 && v.bench.at30.n === v.bench.n && v.bench.min60vs30.n === v.bench.n, 'le banc compare les MEMES achats a 10/30/60 min (n=' + v.bench.n + ')');
  const B2 = BP.cree({ dossier: DIR, quoteurs: { solana: Q }, maintenant: () => T });
  const v2 = B2.vue('solana');
  ok(v2.cashUsd === v.cashUsd && v2.open === v.open && v2.closed === v.closed && v2.arms.length === v.arms.length, 'relue apres redemarrage : caisse, positions, bras identiques');
  ok(B2._etat('solana').file.length === 0, 'la file d attente ne survit pas (ses premiers prix seraient perimes)');
  const Bv = BP.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'banque-vide-')), quoteurs: { solana: fauxQuoteur() }, maintenant: () => T });
  Bv._etat('solana').cash = 10;
  const Qv = fauxQuoteur(); Qv.valeur.Z = 99;
  const Bv2 = BP.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'banque-vide2-')), quoteurs: { solana: Qv }, maintenant: () => T });
  Bv2._etat('solana').cash = 10;
  Bv2.propose('solana', jeton('Z'), []); await Bv2.tour('solana', []);
  /* Intention (reecrite le 04/10) : une caisse a sec ne doit ni acheter a credit en cachette, ni
     arreter la mesure. Elle est rechargee de 1 000 $, la recharge est comptee, et la perte reste. */
  const vv = Bv2.vue('solana');
  ok(!vv.counts.refused['bank empty'] && vv.open === 1, 'banque a 10 $ pour une mise de 25 $ : rechargee, l achat a lieu (la mesure continue)');
  ok(vv.refills === 1 && vv.investedUsd === 2000 && vv.lastRefill === new Date(T).toISOString(), 'la recharge est comptee et datee : 2 000 $ apportes');
  ok(vv.cashUsd === 10 + 1000 - 25.5 && vv.pnlUsd === r2t(vv.valueUsd - 2000), 'le resultat se mesure contre TOUT l argent apporte, recharges comprises');
  ok(B.vue('eth') === null, 'une chaine sans quoteur : pas de banque, pas de vue');

  console.log('\n-- 6. les quoteurs lisent les vraies formes de reponse --');
  const rep = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j });
  const jup = BP.quoteurSolana({ fetch: async (u) => {
    const q = new URL(u).searchParams;
    if (q.get('outputMint') === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return rep(200, { outAmount: '120000000', routePlan: [] });
    if (q.get('outputMint') === 'MORT' || q.get('inputMint') === 'MORT') return rep(400, { error: 'The token MORT is not tradable', errorCode: 'TOKEN_NOT_TRADABLE' });
    if (q.get('outputMint') === 'TROP') return rep(429, {});
    if (q.get('inputMint') === 'So11111111111111111111111111111111111111112') return rep(200, { outAmount: String(Number(q.get('amount')) * 1000), routePlan: [{ swapInfo: { label: 'Pump.fun' } }] });
    return rep(200, { outAmount: String(Math.round(Number(q.get('amount')) / 1000 * 0.97)), routePlan: [{ swapInfo: { label: 'Pump.fun' } }] });
  } });
  const ja = await jup.achat('MEME', 24);
  ok(ja.ok && ja.recu === String(200000000 * 1000) && ja.via === 'Pump.fun' && Math.abs(ja.fraisUsd - 0.06) < 1e-9, 'Jupiter : 24 $ a 120 $/SOL = 0,2 SOL ; frais reseau 0,0005 SOL = 0,06 $');
  const jv = await jup.vente('MEME', ja.recu);
  ok(jv.ok && Math.abs(jv.usd - 23.28) < 1e-6, 'Jupiter : la revente rend 97 % (23,28 $)');
  ok(!(await jup.achat('MORT', 24)).ok && /TOKEN_NOT_TRADABLE/.test((await jup.vente('MORT', '1')).raison), 'Jupiter : 400 TOKEN_NOT_TRADABLE = pas de route (pas une panne)');
  let leve = null; try { await jup.achat('TROP', 24); } catch (e) { leve = e; }
  ok(leve && leve.quota, 'Jupiter : un 429 sur les deux adresses leve « quota »');
  const kyb = BP.quoteurEth({ fetch: async (u, o) => {
    const q = new URL(u).searchParams;
    if (!(o && o.headers && o.headers['x-client-id'])) return rep(403, {});
    if (q.get('tokenOut') === '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48') return rep(200, { code: 0, data: { routeSummary: { amountOut: '26860000', gasUsd: '0.2', amountInUsd: '26.86' } } });
    if (q.get('tokenIn') === '0xpiege') return rep(400, { code: 4008, message: 'route not found' });
    if (q.get('tokenOut') === '0xsature') return rep(200, { code: 4000, message: 'service temporarily overloaded' });
    if (/^0xEeee/i.test(q.get('tokenIn'))) return rep(200, { code: 0, data: { routeSummary: { amountOut: '5000000000000000000000', gasUsd: '0.30', route: [[{ exchange: 'uniswap-v4-fee' }]] } } });
    return rep(200, { code: 0, data: { routeSummary: { amountOut: String(Math.round(0.0186 * 0.9 * 1e9) + '000000000'), gasUsd: '0.25' } } });
  } });
  const ka = await kyb.achat('0xmeme', 50);
  ok(ka.ok && ka.recu === '5000000000000000000000' && ka.fraisUsd === 0.3, 'KyberSwap : achat, x-client-id envoye, gaz de la route en dollars compte');
  const kv = await kyb.vente('0xmeme', ka.recu);
  ok(kv.ok && Math.abs(kv.usd - 0.0186 * 0.9 * 2686) < 0.01 && kv.fraisUsd === 0.25, 'KyberSwap : la revente en ETH, au cours lu sur USDC (2 686 $)');
  ok(ka.via === 'uniswap-v4-fee', 'KyberSwap : la place de l achat est gardee (« uniswap-v4-fee »)');
  let sat = null; try { await kyb.achat('0xsature', 50); } catch (e) { sat = e; }
  ok(sat && /overloaded/.test(sat.message), 'KyberSwap : « service temporarily overloaded » LEVE (panne passagere) — jamais lu comme « pas de route »');
  const kp = await kyb.vente('0xpiege', '1');
  ok(!kp.ok && /route not found/.test(kp.raison), 'KyberSwap : 400 code 4008 « route not found » = pas de route — un pot de miel ne s achete pas');
  const { BigNumber } = require('ethers');
  const faux = { coursEth: () => 2500, _meilleurePlace: async (j, pool, mise) => ({ choix: { sortie: mise.mul(1000), retour: mise.mul(95).div(100), gaz: BigNumber.from('100000000000000'), pool: 'p-v3' } }),
    _routeDe: async (j, pool) => ({ pool }), _devisRoute: async (r, sens, j, m) => { if (j === '0xmort') throw new Error('no venue answers for this token'); return m.div(1000).mul(110).div(100); } };
  const rh = BP.quoteurRobinhood({ miroir: faux });
  const ra = await rh.achat('0xrh', 25, { pool: 'p-colonie' });
  ok(ra.ok && ra.pool === 'p-v3' && Math.abs(ra.venteUsd - 23.75) < 1e-6 && Math.abs(ra.fraisUsd - 0.25) < 1e-6, 'Robinhood : la meilleure place du miroir, son aller-retour (95 % = 23,75 $) et son gaz (0,0001 ETH = 0,25 $) en un seul devis');
  const rv = await rh.vente('0xrh', ra.recu, { pool: 'p-v3' });
  ok(rv.ok && Math.abs(rv.usd - 27.5) < 1e-6, 'Robinhood : la vente sur la route de la position (+10 % = 27,5 $)');
  ok(!(await rh.vente('0xmort', '1000', { pool: 'p' })).ok, 'Robinhood : « no venue answers » = pas de route');
  /* Robinhood : le devis d achat donne deja la revente — un seul appel au quoteur. */
  const Qr = { nom: 'rh', appels: 0, achat: async () => { Qr.appels++; return { ok: true, recu: '1000', fraisUsd: 0.2, venteUsd: 24, pool: 'p' }; }, vente: async () => { Qr.appels++; return { ok: true, usd: 25 }; } };
  const Br = BP.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'banque-rh-')), quoteurs: { robinhood: Qr }, maintenant: () => T });
  Br.propose('robinhood', jeton('0xr'), []); await Br.tour('robinhood', []);
  ok(Br.vue('robinhood').open === 1 && Qr.appels === 1, 'Robinhood : achete sur un seul devis (l aller-retour du miroir), pas de second appel');

  let Tp = Date.UTC(2026, 9, 5, 12, 0, 0);
  const Qp = fauxQuoteur(); Qp.valeur.OK2 = 99; Qp.valeur.OK3 = 99;
  const achatOrig = Qp.achat;
  Qp.achat = async (adr, usd) => { if (adr === 'PANNE') throw new Error('KyberSwap 200 service temporarily overloaded'); const r = await achatOrig(adr, usd); return Object.assign(r, { via: 'uniswap-v4-fee' }); };
  const Bp = BP.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'banque-p-')), quoteurs: { eth: Qp }, maintenant: () => Tp });
  const PISCINE = 'Pool size = pool $5-20k';
  Bp.propose('eth', jeton('PANNE'), [PISCINE]); Bp.propose('eth', jeton('NOSELL2'), [PISCINE]); Bp.propose('eth', jeton('OK2'), [PISCINE]);
  await Bp.tour('eth', [PISCINE]);
  const vp = Bp.vue('eth');
  ok(vp.counts.errors === 1 && /overloaded/.test(vp.counts.lastError) && !vp.counts.refused['no buy route'], 'une panne passagere sur un jeton : comptee en erreur, pas en refus');
  ok(vp.counts.refused['cannot sell'] === 1 && vp.refusedByVenue['cannot sell · uniswap-v4-fee'] === 1 && vp.recentRefusals[0].via === 'uniswap-v4-fee', 'le tour continue : le jeton suivant est juge, et son refus garde sa place (« cannot sell · uniswap-v4-fee »)');
  ok(vp.open === 1 && Bp._etat('eth').ouvertes[0].addr === 'OK2', 'et le troisieme est achete par le bras, dans le meme tour');

  console.log('\n-- 6b. les bras imposes par la colonie : file a part, jamais le temoin, un jeton compte une fois --');
  let Tc = Date.UTC(2026, 9, 6, 12, 0, 0);
  const Qc = fauxQuoteur(); ['C1', 'C2', 'C3', 'K1'].forEach((a) => { Qc.valeur[a] = 97; });
  const Bc = BP.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'banque-c-')), quoteurs: { robinhood: Qc }, maintenant: () => Tc });
  const JEUNE = 'colony · young, no public link', ACHETE = 'colony · bought';
  Bc.propose('robinhood', jeton('C1'), [], { bras: JEUNE });
  Bc.propose('robinhood', jeton('C2'), [], { bras: JEUNE });
  Bc.propose('robinhood', jeton('K1'), [], { bras: ACHETE, controle: true });
  await Bc.tour('robinhood', []);
  let Sc = Bc._etat('robinhood');
  ok(Sc.ouvertes.length === 2 && Sc.ouvertes.every((p) => !p.temoin) && Bc.vue('robinhood').counts.control === 0,
     'le temoin etait du, mais une proposition de la colonie ne le devient jamais : C1 et K1 achetes sous leur bras, le temoin a 0');
  ok(Sc.ouvertes.find((p) => p.addr === 'C1').bras === JEUNE && !Sc.ouvertes.some((p) => p.addr === 'C2'), 'un bras impose garde ses 20 min entre deux achats : C2 attend son tour (et est perdu, pas rejoue)');
  Tc += 5 * MIN; Bc.propose('robinhood', jeton('C3'), [], { bras: ACHETE, controle: true });
  await Bc.tour('robinhood', []);
  ok(Bc._etat('robinhood').ouvertes.some((p) => p.addr === 'C3'), 'le bras temoin de la colonie (ses propres achats) n a pas d espacement : chaque achat de la colonie est suivi');
  const vc = Bc.vue('robinhood');
  const ba = vc.arms.find((x) => x.case === ACHETE), bj = vc.arms.find((x) => x.case === JEUNE);
  ok(ba && ba.source === 'colony' && ba.state === 'control' && bj && bj.source === 'colony' && bj.state === 'testing', 'la vue dit d ou vient chaque bras (« colony ») et marque le temoin de la colonie « control »');
  /* Hors plafond : 6 bras de l observatoire s arment quand meme. */
  await Bc.tour('robinhood', ['a = 1', 'b = 2', 'c = 3', 'd = 4', 'e = 5', 'f = 6', 'g = 7']);
  ok(Object.values(Bc._etat('robinhood').bras).filter((b) => !b.impose && b.etat === 'actif').length === 6, 'les bras de la colonie ne prennent pas de place sous BRAS_MAX : 6 bras de l observatoire encore');
  /* Le temoin de la colonie n est jamais retire, meme perdant au-dela du hasard ; un bras impose ordinaire l est. */
  Sc = Bc._etat('robinhood');
  for (let i = 0; i < 70; i++) {
    Sc.fermees.push({ addr: 'P' + i, cases: [], bras: ACHETE, temoin: false, t0: Tc - (200 - i) * MIN, depense: 25, r30: -9 + (i % 3), valeurs: { 10: { usd: 1 }, 30: { usd: 1 }, 60: { usd: 1 } } });
    Sc.fermees.push({ addr: 'Q' + i, cases: [], bras: JEUNE, temoin: false, t0: Tc - (200 - i) * MIN, depense: 25, r30: -9 + (i % 3), valeurs: { 10: { usd: 1 }, 30: { usd: 1 }, 60: { usd: 1 } } });
  }
  await Bc.tour('robinhood', []);
  const v6 = Bc.vue('robinhood');
  ok(v6.arms.find((x) => x.case === ACHETE).state === 'control' && v6.arms.find((x) => x.case === JEUNE).state === 'retired', 'perdant au-dela du hasard : le bras « jeune » est retire, le temoin de la colonie reste (c est la reference)');
  /* Un jeton rachete compte une fois. */
  const Sr = { fermees: [{ addr: 'R', t0: 1, r30: 30 }, { addr: 'R', t0: 2, r30: 30 }, { addr: 'R', t0: 3, r30: 30 }, { addr: 'U', t0: 4, r30: -10 }] };
  const sr = BP.serieParJeton(Sr.fermees);
  ok(sr.n === 2 && sr.buys === 4 && sr.net === 10, 'trois achats du meme jeton a +30 % et un autre a -10 % : n = 2 jetons, 4 achats, moyenne +10 % (pas +20 %)');

  console.log('\n-- 7. l observatoire passe chaque premier prix ; rien n est signe --');
  const O = require('./observatoire');
  const recus = [], tours = [];
  const fausseBanque = { propose: (c, o, cases) => recus.push({ c, addr: o.addr, cases }), tour: async (c, s) => tours.push({ c, s }), vue: (c) => ({ chaine: c }) };
  let T2 = Date.UTC(2026, 9, 3, 12, 0, 0);
  const prixDe = { MEME1: 0.001 };
  const fetchObs = async (u) => {
    const url = new URL(u);
    if (url.host === 'api.geckoterminal.com') return rep(200, { data: [{ attributes: { address: 'pool1', pool_created_at: new Date(T2 - 2 * MIN).toISOString() }, relationships: { base_token: { data: { id: 'solana_MEME1' } }, dex: { data: { id: 'pump-fun' } } } }] });
    if (url.host === 'api.dexscreener.com') return rep(200, [{ dexId: 'pumpswap', pairAddress: 'pool1', baseToken: { address: 'MEME1' }, quoteToken: { symbol: 'SOL' }, priceUsd: String(prixDe.MEME1), liquidity: { usd: 30000 }, marketCap: 40000, pairCreatedAt: T2 - 2 * MIN, info: { socials: [{}] } }]);
    return rep(200, { result: { value: null } });
  };
  const obs = O.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'obs-banque-')), fetch: fetchObs, chaines: ['solana'], maintenant: () => T2, banque: fausseBanque });
  await obs.cycle();
  ok(recus.length === 1 && recus[0].c === 'solana' && recus[0].addr === 'MEME1' && recus[0].cases.includes('Pool size = pool $20-100k') && recus[0].cases.includes('Venue = pumpswap'),
     'au premier prix, la banque recoit le jeton et ses cases (« Pool size = pool $20-100k », « Venue = pumpswap »)');
  ok(tours.length === 1 && Array.isArray(tours[0].s), 'un tour de banque par cycle, avec la liste des cases qui sortent du lot');
  const vo = obs.vue();
  ok(vo.chaines.solana.bank && vo.chaines.solana.bank.chaine === 'solana' && Array.isArray(vo.chaines.solana.standouts) && /Paper only/.test(vo.bankNote), 'la vue de l observatoire porte la banque, les cases sortantes et la note');
  const casse = { propose: () => {}, tour: async () => { throw new Error('panne banque'); }, vue: () => null };
  const obs2 = O.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'obs-banque2-')), fetch: fetchObs, chaines: ['solana'], maintenant: () => T2, banque: casse });
  await obs2.cycle();
  ok(obs2._etat('solana').cycles === 1 && obs2._etat('solana').compte.erreurs.banque === 1, 'une banque en panne ne fait pas tomber l observatoire : l erreur est comptee');
  const src = fs.readFileSync(path.join(__dirname, 'banque_papier.js'), 'utf8');
  ok(!/sendTransaction|signTransaction|new ethers\.Wallet|Wallet\(|privateKey|MIROIR_CLE|signataire|acheteRoute|vendsMaintenant/.test(src), 'banque_papier.js : aucune signature, aucune cle, aucun ordre du miroir');
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  ok(/quoteurRobinhood\(\{ miroir \}\)/.test(srv) && /BANQUE_PAPIER === '0'/.test(srv) && /banque: banquePapier/.test(srv), 'server.js : la banque branchee sur l observatoire, eteignable (BANQUE_PAPIER=0)');

  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('\nVERIFICATIONS : ' + n + (rates ? ' — ' + rates + ' RATE(S)' : ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('  RATE ' + (e.stack || e)); process.exit(1); });
