'use strict';
/*
 * LES MESURES DU 21/10/2026 : disjoncteur du miroir, ecart papier → reel par
 * tranche d'aller-retour, paliers juges a l'echeance.
 *
 *   1. Le disjoncteur (miroir.disjoncteur) : perte NETTE des fermetures des 24 h
 *      contre MIROIR_PERTE_JOUR du capital du debut de fenetre, nombre d'achats
 *      contre MIROIR_ACHATS_JOUR ; un gain compense une perte ; une fermeture hors
 *      du miroir (sortie inconnue), une recuperation de transit et une ouverture a
 *      la main ne comptent pas ; il se rearme quand la fenetre glisse ; sans solde
 *      lu, il ne coupe que sur le nombre.
 *   2. Il est branche AVANT toute depense dans achetePosition, sauf pour une
 *      ouverture a la main, et sa raison entre dans le suivi.
 *   3. ecartParAllerRetour : papier moins reel par tranche, sur les seules lignes
 *      qui ont les deux ; « assez » a 30.
 *   4. Les paliers : chaque tranche vendue par l'echelle laisse une suite, jugee a
 *      l'echeance au prix VENDABLE ; une suite jamais recotee est comptee
 *      « oubliee », pas perdue ; rien ne change dans le tresor ni la position.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mesures-'));
process.env.STUDIO_DEX = '0';
delete process.env.MIROIR_PERTE_JOUR; delete process.env.MIROIR_ACHATS_JOUR;
const ethers = require('ethers');
const M = require('./miroir');
const C = require('./ai_colonie');

const H = 3600e3, NOW = Date.parse('2026-10-21T12:00:00Z');
const WEI = (x) => ethers.utils.parseUnits(String(x), 18);
const ferme = (entree, sortie, ilYaH, o) => Object.assign({ entree: String(entree), sortie: sortie === null ? null : String(sortie), t0: NOW - (ilYaH + 0.5) * H, t: NOW - ilYaH * H }, o || {});

console.log('-- 1. le disjoncteur');
eq(M.PERTE_JOUR_PART, 0.1, 'defaut : 10 % du capital');
eq(M.ACHATS_JOUR_MAX, 8, 'defaut : 8 achats par 24 h');
let c = { fermees: [ferme(0.01, 0.009, 2), ferme(0.01, 0.0095, 3)], ouvertes: {} };
let d = M.disjoncteur(c, WEI(0.1), NOW);
ok(Math.abs(d.net + 0.0015) < 1e-9 && d.coupe === null, 'perte de 0,0015 ETH sur ~0,1 : il laisse passer');
eq(d.achats, 2, 'deux achats comptes');
c = { fermees: [ferme(0.02, 0.008, 1), ferme(0.02, 0.009, 2)], ouvertes: {} };
d = M.disjoncteur(c, WEI(0.18), NOW);
ok(d.coupe === 'perte' && Math.abs(d.capital - 0.203) < 1e-9, 'perte nette 0,023 sur un capital de debut 0,203 (> 10 %) : coupe « perte »');
c.fermees.push(ferme(0.02, 0.04, 0.5));
d = M.disjoncteur(c, WEI(0.2), NOW);
eq(d.coupe, null, 'un gain de 0,02 compense : perte nette 0,003, il rearme');
c = { fermees: [ferme(0.02, 0.008, 25), ferme(0.02, 0.009, 26)], ouvertes: {} };
eq(M.disjoncteur(c, WEI(0.18), NOW).coupe, null, 'les pertes de plus de 24 h ne comptent plus : rearme par la fenetre');
c = { fermees: [ferme(0.05, null, 1, { horsMiroir: true }), ferme(0, 0.03, 1, { transit: true })], ouvertes: {} };
d = M.disjoncteur(c, WEI(0.1), NOW);
ok(d.net === 0 && d.fermees === 0, 'fermee hors du miroir (sortie inconnue) et recuperation de transit : hors du compte');
const ouv = {};
for (let i = 0; i < 5; i++) ouv['0x' + String(i).repeat(40)] = { entree: '0.005', t: NOW - i * H };
c = { fermees: [1, 2, 3].map((i) => ferme(0.005, 0.0051, i)), ouvertes: ouv };
d = M.disjoncteur(c, WEI(0.1), NOW);
ok(d.achats === 8 && d.coupe === 'achats', '3 fermes + 5 ouverts dans les 24 h = 8 achats : coupe « achats »');
c.ouvertes['0x' + '9'.repeat(40)] = { entree: '0.005', t: NOW, manuel: true };
c.fermees.push(ferme(0.005, 0.005, 1, { manuel: true }));
eq(M.disjoncteur(c, WEI(0.1), NOW).achats, 8, 'une ouverture a la main (ouverte ou fermee) ne compte pas');
c = { fermees: [ferme(0.02, 0.001, 1)], ouvertes: {} };
d = M.disjoncteur(c, null, NOW);
ok(d.capital === null && d.coupe === null, 'sans solde lu : pas de capital, il ne coupe pas sur la perte (il ne devine pas)');

console.log('-- 2. branche avant toute depense');
const src = fs.readFileSync(path.join(__dirname, 'miroir.js'), 'utf8');
const a = src.indexOf('async function achetePosition');
const bloc = src.slice(a, src.indexOf('\n}\n', a));
const iDisj = bloc.indexOf('disjoncteur(c, solde)'), iGaz = bloc.indexOf('getGasPrice'), iPlace = bloc.indexOf('meilleurePlace('), iAchat = bloc.indexOf('acheteRoute(');
ok(iDisj > 0 && iDisj < iGaz && iDisj < iPlace && iDisj < iAchat, 'achetePosition : le disjoncteur passe avant le gaz, le devis et l achat');
ok(/if \(!t\.manuel\) \{\s*const dj = disjoncteur/.test(bloc) && /return pourquoi\('disjoncteur'\)/.test(bloc), 'sauf une ouverture a la main ; sa raison part au suivi');
ok(M.SUIVI_RAISONS.includes('disjoncteur'), 'la raison « disjoncteur » est une raison du suivi');
ok(/disjoncteur: 'the daily breaker/.test(fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8')), 'et l alerte de la colonie la nomme en anglais');

console.log('-- 3. ecart papier → reel par tranche d aller-retour');
const lignes = [
  { r: -10, papier: 5, allerRetour: 5 }, { r: -20, papier: 0, allerRetour: 6 },
  { r: 1, papier: 4, allerRetour: 3 }, { r: 3, papier: null, allerRetour: 3 }, { r: -5, papier: 2, allerRetour: null },
];
const e = C.ecartParAllerRetour(lignes);
const t47 = e.find((x) => x.de === 4), t24 = e.find((x) => x.de === 2);
ok(t47 && t47.n === 2 && t47.papier === 2.5 && t47.reel === -15 && t47.ecart === 17.5, '4-7 % : papier 2,5, reel -15, ecart 17,5 sur 2 lignes');
ok(t24 && t24.n === 1 && t24.ecart === 3, '2-4 % : la ligne sans papier est ecartee (n=1)');
ok(e.every((x) => x.assez === false) && C.REEL_ASSEZ_TRANCHE === 30, 'sous 30 par tranche : « assez » faux');

console.log('-- 4. les paliers juges a l echeance');
const etat0 = C._etat();
const E = JSON.parse(JSON.stringify(etat0 || {}));
E.positions = []; E.flux = []; E.courbe = []; E.tresor = 1000; E.suitesPaliers = []; E.verdictsPaliers = {};
C._pose(E);
const adr = '0x' + 'ab'.repeat(20);
const p = { adr, sym: 'TST', prix0: 1, mise: 100, t0: Date.now() - 5 * 60000, tenueMin: 20, reste: 1 };
const tresor0 = C._etat().tresor;
C.joueEchelle(p, 50, Date.now());   /* +50 % : franchit +15 et +40 */
const S = C._etat().suitesPaliers;
ok(S.length === 2 && S[0].a === 15 && S[1].a === 40, 'deux paliers franchis a +50 % : deux suites (+15, +40)');
ok(Math.abs(S[0].part - 0.35) < 1e-9 && S[0].rVente === 50 && S[0].echeance === p.t0 + 20 * 60000, 'chacune : sa part, son rendement, l echeance de la position');
ok(Math.abs(C._etat().tresor - tresor0 - 35) < 1e-6, 'l echelle elle-meme est inchangee (70 % vendus a +50 % : +35 $)');
eq(C.regleLesPaliers({ [adr]: { prix: 3, liq: null } }), 0, 'avant l echeance : rien de juge');
S.forEach((s) => { s.echeance = Date.now() - 1000; });
const juges = C.regleLesPaliers({ [adr]: { prix: 3, liq: null } });
eq(juges, 2, 'a l echeance, prix x3 : deux tranches jugees');
const V = C.verdictsDesPaliers();
const v15 = V.find((x) => x.palier === 15);
ok(v15 && v15.n === 1 && v15.deltaTranche > 100 && v15.partMieuxTenir === 100, '+15 % : garder aurait rendu plus (rendement vendable a x3 contre +50 %)');
ok(Math.abs(v15.deltaPosition - Math.round(v15.deltaTranche * 0.35 * 10) / 10) <= 0.1, 'et en points de la position : la tranche ponderee par sa part (35 %)');
ok(v15.assez === false, 'une seule tranche : « assez » faux');
C.joueEchelle(Object.assign({}, p, { adr: '0x' + 'cd'.repeat(20), paliers: {}, reste: 1 }), 20, Date.now() - 5 * 3600e3);
C.regleLesPaliers({});
ok(C.verdictsDesPaliers().find((x) => x.palier === 15).oubliees === 1, 'une suite jamais recotee en 4 h : comptee « oubliee »');
C._pose(etat0);

console.log(rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK');
process.exit(rates ? 1 : 0);
