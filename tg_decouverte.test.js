'use strict';
/*
 * TROUVER SEUL DE NOUVEAUX CANAUX (tg_decouverte.js) — sur mesure, jamais sur
 * reputation (releve du 26 septembre 2026 : 72 canaux cites, 26 publics, 3 avec
 * du Robinhood ; des canaux « Robinhood » muets depuis 55 jours).
 *   1. ajoute : public, actif < 48 h, >= 2 jetons Robinhood CONFIRMES ;
 *   2. refuse, avec la raison : prive, muet, pas assez de Robinhood ;
 *   3. plafond de 10 ; jamais remesure avant 7 jours ;
 *   4. retire apres 7 jours sans Robinhood ; persistance ; les ajoutes sont SUIVIS.
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ' vs ' + JSON.stringify(b) + ']');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.TG_SURV_CANAUX = 'suiviCanal';
const T = require('./tg_canal');
const D = require('./tg_decouverte');

let t = Date.UTC(2026, 8, 26, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const adr = (k) => '0x' + String(k).padStart(40, '0');
const RH = new Set();                     /* adresses confirmees Robinhood */
const msg = (c, i, quand, texte) => '<div class="tgme_widget_message_wrap"><div data-post="' + c + '/' + i + '"><time datetime="' + iso(quand) + '"></time><div class="tgme_widget_message_text">' + texte + '</div></div></div>';
let pages = {};
const mesurees = [];
const page = async (c) => { mesurees.push(c); return pages[c] ? { statut: 200, html: pages[c] } : { statut: 302 }; };
const litJson = async (u) => u.split('/').pop().split(',').filter((a) => RH.has(a)).map((a) => ({ chainId: 'robinhood', baseToken: { address: a, symbol: 'S' + a.slice(-2) } }));
let cites = [];
const tg = { messages: T.messages, analyse: T.analyse, resousLien: async (id) => id, canaux: () => T.canaux(), cites: () => cites, poseAuto: (f) => T.poseAuto(f) };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdec-'));
  const fichier = path.join(dir, 'd.json');
  const mk = () => D.cree({ tg, page, litJson, fichier, maintenant: () => t });
  RH.add(adr(1)); RH.add(adr(2)); RH.add(adr(3));
  pages = {
    bonCanal: msg('bonCanal', 1, t - 3600e3, adr(1)) + msg('bonCanal', 2, t - 7200e3, adr(2)) + msg('bonCanal', 3, t - 7300e3, adr(99)),
    unSeulCanal: msg('unSeulCanal', 1, t - 3600e3, adr(3)) + msg('unSeulCanal', 2, t - 3700e3, adr(98)),
    muetCanal: msg('muetCanal', 1, t - 60 * 24 * 3600e3, adr(1)) + msg('muetCanal', 2, t - 61 * 24 * 3600e3, adr(2)),
  };
  cites = [{ canal: 'bonCanal', n: 3 }, { canal: 'unSeulCanal', n: 2 }, { canal: 'muetCanal', n: 2 }, { canal: 'priveCanal', n: 1 }, { canal: 'suiviCanal', n: 5 }];

  console.log('-- 1. et 2. mesurer, ajouter, refuser avec la raison --');
  let S = mk();
  let f = await S.tour();
  eq(f.ajoutes.map((x) => x.canal).join(','), 'bonCanal', 'ajoute : public, actif, 2 jetons Robinhood confirmes (le 3e, hors Robinhood, ne compte pas)');
  const v = S.vue();
  const verdict = (c) => v.mesures.find((m) => m.canal === c).verdict;
  ok(/1 Robinhood Chain token/.test(verdict('unSeulCanal')), 'un seul jeton Robinhood : refuse, la raison dite (' + verdict('unSeulCanal') + ')');
  ok(/not active/.test(verdict('muetCanal')), 'du Robinhood il y a deux mois : refuse, muet (' + verdict('muetCanal') + ')');
  ok(/no public preview/.test(verdict('priveCanal')), 'pas d apercu public : refuse');
  ok(!mesurees.includes('suiviCanal'), 'un canal deja suivi n est pas remesure comme candidat');
  ok(T.canaux().includes('bonCanal') && T.canaux()[0] === 'suiviCanal', 'le canal ajoute est SUIVI, apres la liste du proprietaire');
  ok(T.vue().canaux.find((c) => c.canal === 'bonCanal').auto === true && T.vue().canaux.find((c) => c.canal === 'suiviCanal').auto === false, 'la vue distingue ajoute et liste');

  console.log('\n-- 3. jamais remesure avant 7 jours ; plafond de 10 --');
  mesurees.length = 0;
  t += 24 * 3600e3;
  pages.bonCanal = msg('bonCanal', 4, t - 3600e3, adr(1));             /* toujours du Robinhood */
  f = await S.tour();
  ok(mesurees.filter((c) => c !== 'bonCanal').length === 0, 'le lendemain : aucun candidat remesure (seul le canal ajoute est reverifie)');
  const S2 = D.cree({ tg: Object.assign({}, tg, { cites: () => Array.from({ length: 14 }, (_, k) => ({ canal: 'canal' + k, n: 1 })) }), page: async (c) => ({ statut: 200, html: msg(c, 1, t - 3600e3, adr(1)) + msg(c, 2, t - 3600e3, adr(2)) }), litJson, fichier: path.join(dir, 'e.json'), maintenant: () => t });
  f = await S2.tour();
  ok(Object.keys(S2.etat().auto).length === 10 && S2.vue().mesures.some((m) => /already added/.test(m.verdict || '')), 'quatorze canaux qualifies : dix ajoutes, les autres notes « would qualify » (plafond)');

  console.log('\n-- 4. retrait, persistance --');
  t += 8 * 24 * 3600e3;
  pages.bonCanal = msg('bonCanal', 5, t - 3600e3, 'just talking, no contract');
  f = await S.tour();
  ok(f.retires.length === 1 && f.retires[0].canal === 'bonCanal' && /7 days/.test(f.retires[0].raison), 'huit jours sans Robinhood : retire, la raison dite');
  ok(!T.canaux().includes('bonCanal'), 'et il n est plus suivi');
  const S3 = mk();
  eq(Object.keys(S3.etat().auto).length, 0, 'relu sur disque apres redemarrage');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
