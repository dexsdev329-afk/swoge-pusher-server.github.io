'use strict';
/* LE REPERE SANS RISQUE + LE BANC PRE-ENREGISTRE.
 *
 * Intention (a tenir si un changement contredit l'essai) : « ne rien faire »
 * rapporte le taux sans risque, et chaque mesure s'y compare ; un banc fige sa
 * regle AVANT de mesurer (changer la regle repart a zero), refuse de conclure
 * sous minObs, et ne declare un edge que s'il BAT le repere avec t≥2.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('./repere');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

console.log('-- 1. le repere sans risque --');
ok(Math.abs(R.sansRisque(365) - 0.04) < 1e-9, 'un an au taux sans risque = 4 %');
ok(Math.abs(R.sansRisque(2.55) - 0.04 * 2.55 / 365) < 1e-9, 'une tenue de 2,55 jours ~ 0,028 % : le repere d un week-end');
ok(R.sansRisque(365, 1000) === 40, 'sur 1 000 $, un an = 40 $');

console.log('\n-- 2. le banc : pre-enregistre, refuse de conclure sous minObs --');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repere-'));
let b = R.banc({ dossier: dir, nom: 't', enregistreLe: '2026-10-04', regle: 'R1', tenueJours: 2.55, minObs: 10 });
for (let i = 0; i < 5; i++) b.ajoute(0.5);
let v = b.vue();
ok(v.n === 5 && /too few: 5\/10/.test(v.conclut), 'sous minObs : « too few », il continue de collecter');
ok(v.repereSansRisquePct != null && v.repereSansRisquePct < 0.05, 'la vue porte la ligne de repere sans risque du week-end');
ok(/Pre-registered on 2026-10-04/.test(v.note) && /fixed in advance/.test(v.note), 'la note dit que la regle est figee d avance');

console.log('\n-- 3. changer la regle REPART a zero (pas de melange sous deux regles) --');
const b2 = R.banc({ dossier: dir, nom: 't', enregistreLe: '2026-10-04', regle: 'R2-differente', tenueJours: 2.55, minObs: 10 });
ok(b2.vue().n === 0, 'une regle differente : nouvelle pre-enregistration, observations repartent a zero');

console.log('\n-- 4. un edge n est declare que s il BAT le repere avec t>=2 --');
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'repere2-'));
let bg = R.banc({ dossier: dir2, nom: 'gagnant', enregistreLe: 'x', regle: 'r', tenueJours: 2.55, minObs: 10 });
for (let i = 0; i < 20; i++) bg.ajoute(0.5 + (i % 2 ? 0.02 : -0.02));   /* ~0,5 %, tres regulier → t enorme */
v = bg.vue();
ok(v.n === 20 && v.t > 2 && v.netPct > v.repereSansRisquePct && v.beatsRiskFree === true && /edge holds in paper/.test(v.conclut),
   'une serie nettement positive et reguliere : « edge holds in paper (beats risk-free, t≥2) »');

const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'repere3-'));
let bp = R.banc({ dossier: dir3, nom: 'ptt', enregistreLe: 'x', regle: 'r', tenueJours: 2.55, minObs: 10 });
for (let i = 0; i < 20; i++) bp.ajoute(0.01 + (i % 2 ? 0.005 : -0.005));  /* positif mais minuscule, sous le repere? ~0,01 % > repere 0,028%? non */
v = bp.vue();
ok(v.netPct > 0 && v.beatsRiskFree === false && /does NOT beat risk-free/.test(v.conclut),
   'une serie positive mais SOUS le repere : « positive but does NOT beat risk-free »');

const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'repere4-'));
let bn = R.banc({ dossier: dir4, nom: 'perd', enregistreLe: 'x', regle: 'r', tenueJours: 2.55, minObs: 10 });
for (let i = 0; i < 20; i++) bn.ajoute(-0.5 + (i % 2 ? 0.02 : -0.02));
v = bn.vue();
ok(v.t < -2 && /negative beyond chance/.test(v.conclut), 'une serie nettement negative : « negative beyond chance »');

console.log('\n-- 5. la persistance et les trois bancs pre-enregistres --');
const bx = R.banc({ dossier: dir, nom: 'persi', enregistreLe: 'x', regle: 'r', tenueJours: 1, minObs: 5 });
bx.ajoute(1); bx.ajoute(2);
const relu = R.banc({ dossier: dir, nom: 'persi', enregistreLe: 'x', regle: 'r', tenueJours: 1, minObs: 5 });
ok(relu.vue().n === 2, 'les observations survivent a un redemarrage (relecture du fichier)');

const trois = R.bancs(fs.mkdtempSync(path.join(os.tmpdir(), 'bancs-')));
ok(trois['rh-weekend'] && trois['hl-xyz-weekend'] && trois['merkl-lp'], 'les trois bancs de la chasse a l edge existent');
ok(R.BANCS.every((x) => x.regle && x.tenueJours && x.minObs) && R.ENREGISTRE_LE === '2026-10-04', 'chacun a sa regle figee, sa tenue et son minObs, pre-enregistres le 04/10');
ok(/Reference Fri 20:00 ET/.test(trois['rh-weekend'].vue().regle), 'la regle du week-end RH fige les heures (Fri 20:00 ET …) d avance');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
