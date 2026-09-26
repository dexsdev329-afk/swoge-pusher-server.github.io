'use strict';
/*
 * LES APPELS TELEGRAM (tg_appels.js) — idee du proprietaire, 26 septembre 2026 :
 * suivre des canaux, et dire ce que chaque appel a DONNE.
 *   1. un appel = (canal, jeton) Robinhood, au prix LU a la detection ; hors
 *      Robinhood : ecarte et signale au module des canaux (pas redemande) ;
 *   2. jamais compte deux fois ; le meme jeton dans deux canaux = deux appels ;
 *   3. seuls les appels FRAIS (detectes < 15 min apres le message) comptent
 *      dans le score, et aucun score sous 10 appels frais mesures ;
 *   4. le suivi retient le plus haut ; une requete DexScreener pour 30 adresses ;
 *   5. la notification ne part que pour un appel frais ; persistance.
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ' vs ' + JSON.stringify(b) + ']');
const fs = require('fs'), os = require('os'), path = require('path');
const A = require('./tg_appels');

const adr = (k) => '0x' + String(k).padStart(40, '0');
let t = Date.UTC(2026, 8, 26, 12, 0, 0);
const prix = {};            /* addr -> prix courant sur Robinhood (absent = pas sur Robinhood) */
let lectures = [];
const lit = async (url) => {
  const l = url.split('/').pop().split(',');
  lectures.push(l.length);
  return l.filter((a) => prix[a]).map((a) => ({ chainId: 'robinhood', baseToken: { address: a, symbol: 'T' + a.slice(-3), name: 'Tok' }, priceUsd: String(prix[a]),
    liquidity: { usd: 20000 }, marketCap: 50000, pairCreatedAt: t - 3600e3, url: 'https://dexscreener.com/robinhood/' + a }));
};
let proposees = [];
const notes = [];
const tg = { adressesRecentes: async () => ({ adresses: proposees }), note: (a, x, st) => notes.push({ a, st }), canaux: () => ['canalA', 'canalB'] };
const iso = (ms) => new Date(ms).toISOString();

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgappels-'));
  const fichier = path.join(dir, 'tg_appels.json');
  const notifies = [];
  const mk = () => A.cree({ tg, lit, fichier, maintenant: () => t, notifie: (a) => notifies.push(a) });
  let S = mk();

  console.log('-- 1. un appel, au prix lu a la detection ; hors Robinhood ecarte --');
  prix[adr(1)] = 0.001; prix[adr(2)] = 0.5;
  proposees = [{ addr: adr(1), canal: 'canalA', post: 'canalA/10', t: iso(t - 60e3) },
               { addr: adr(2), canal: 'canalB', post: 'canalB/5', t: iso(t - 3 * 3600e3) },     /* vieux message : pas frais */
               { addr: adr(3), canal: 'canalA', post: 'canalA/11', t: iso(t - 30e3) }];         /* pas sur Robinhood */
  await S.tour();
  const l = S.liste({});
  eq(l.calls.length, 2, 'deux appels Robinhood');
  ok(notes.some((x) => x.a === adr(3) && x.st === 'hors robinhood'), 'l adresse hors Robinhood est signalee au module des canaux (plus redemandee six heures)');
  const a1 = l.calls.find((c) => c.token === adr(1));
  ok(a1.priceAtDetection === 0.001 && a1.fresh === true && a1.post === 'https://t.me/canalA/10' && /robinhood/.test(a1.chart), 'prix a la detection, frais, lien du message, graphique Robinhood');
  eq(l.calls.find((c) => c.token === adr(2)).fresh, false, 'un message de trois heures detecte maintenant : PAS frais (son prix n est pas celui de l appel)');
  eq(lectures[0], 3, 'la decouverte : UNE requete DexScreener pour les trois adresses (puis le suivi des plus hauts, une requete pour les deux appels)');
  eq(notifies.length, 1, 'une notification, pour le seul appel frais');

  console.log('\n-- 2. jamais deux fois ; deux canaux = deux appels --');
  proposees.push({ addr: adr(1), canal: 'canalB', post: 'canalB/6', t: iso(t - 10e3) });
  await S.tour();
  eq(S.appels().length, 3, 'le meme jeton appele dans un second canal : un appel de plus, les autres pas recomptes');

  console.log('\n-- 3. le score : appels frais, effectif, refus de conclure --');
  t += 11 * 60e3; prix[adr(1)] = 0.003;          /* x3 */
  await S.tour();
  const sc = S.liste({}).calls.find((c) => c.token === adr(1) && c.channel === 'canalA');
  ok(sc.changeSinceDetectionPct === 200 && sc.bestSinceDetectionPct === 200, 'suivi : +200 % depuis la detection, plus haut retenu');
  prix[adr(1)] = 0.0015; t += 11 * 60e3; await S.tour();
  const sc2 = S.liste({}).calls.find((c) => c.token === adr(1) && c.channel === 'canalA');
  ok(sc2.changeSinceDetectionPct === 50 && sc2.bestSinceDetectionPct === 200, 'retombe a +50 % : le plus haut reste +200 %');
  const s1 = S.scores().find((x) => x.channel === 'canalA');
  ok(s1.medianChangePct === null && /not enough fresh calls/.test(s1.verdict), 'un seul appel frais : AUCUN score, et la raison (' + s1.verdict + ')');
  /* dix appels frais sur canalB, la moitie en hausse */
  for (let k = 10; k < 20; k++) { prix[adr(k)] = 1; proposees.push({ addr: adr(k), canal: 'canalB', post: 'canalB/' + k, t: iso(t - 60e3) }); }
  await S.tour();
  for (let k = 10; k < 20; k++) prix[adr(k)] = k < 15 ? 2 : 0.5;
  t += 11 * 60e3; await S.tour();
  const s2 = S.scores().find((x) => x.channel === 'canalB');
  ok(s2.freshMeasured >= 10 && s2.upSharePct !== null && s2.medianChangePct !== null && s2.verdict === null, 'dix appels frais : un score (mediane ' + s2.medianChangePct + ' %, ' + s2.upSharePct + ' % en hausse, n=' + s2.freshMeasured + ')');
  ok(S.scores()[0].channel === 'canalB', 'les canaux notes d abord');

  console.log('\n-- 4. filtres de l outil --');
  eq(S.liste({ canal: '@canalA' }).calls.every((c) => c.channel === 'canalA'), true, 'filtre par canal (« @canal » accepte)');
  eq(S.liste({ limite: 3 }).calls.length, 3, 'limite');
  ok(/not advice/.test(S.liste({}).method) && /fresh/.test(S.liste({}).method), 'la methode est dite avec les donnees');

  console.log('\n-- 5. persistance --');
  const S2 = mk();
  eq(S2.appels().length, S.appels().length, 'relus sur disque apres redemarrage (' + S2.appels().length + ')');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
