'use strict';
/*
 * L'ENTREE PAPIER AU PRIX DEVISE SUR LA CHAINE (21/10/2026, point 1 du proprietaire).
 * Mesure qui l'a decidee : un miroir qui achetait vraiment payait 3,4 % de plus que
 * l'entree du papier, plus cher 82 fois sur 100 (n=67).
 *   1. le rapport devis (ETH par jeton, jambe d'achat du Cobaye) / indexeur
 *      (base_token_price_native_currency) s'applique au prix en dollars ;
 *   2. il est compte (n, moyenne, part au-dessus, pire) ;
 *   3. sans devis, sans prix natif, ou hors [0,3 ; 3] : rien n'est applique, c'est compte ;
 *   4. COLONIE_ENTREE_DEVIS=observe mesure sans appliquer ;
 *   5. le miroir rend la jambe d'achat de son devis, et la colonie la garde ;
 *      la relecture GeckoTerminal rend le prix natif ; la position et le carnet
 *      gardent le rapport.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'entree-devis-'));
process.env.STUDIO_DEX = '0';
delete process.env.COLONIE_ENTREE_DEVIS;
const C = require('./ai_colonie');
const etat0 = C._etat();
const E = JSON.parse(JSON.stringify(etat0 || {}));
delete E.entreeDevis; E.compteurs = {};
C._pose(E);
const jeton = (ethParJeton, prix) => ({ prix: prix || 2, epreuve: { retour: { pct: 97, achat: ethParJeton == null ? null : { ethParJeton } } } });

console.log('-- 1. le rapport s applique au prix en dollars');
let t = jeton(0.00105);
let r = C.entreeDevisee(t, { prix: 2, natif: 0.001 });
ok(Math.abs(r - 1.05) < 1e-9 && Math.abs(t.prixAchat - 2.1) < 1e-9, 'devis 5 % au-dessus de l indexeur : entree 2,10 $ au lieu de 2,00 $');
ok(t.prixDevis && t.prixDevis.applique && t.prixDevis.prixIndexeur === 2 && t.prixDevis.ratio === 1.05, 'le rapport et le prix de l indexeur sont gardes');
t = jeton(0.00099); t.prixAchat = 1.9;
C.entreeDevisee(t, { prix: 1.9, natif: 0.001 });
ok(Math.abs(t.prixAchat - 1.881) < 1e-9, 'il part du prix RELU (prixAchat), pas du prix du flux');

console.log('-- 2. compte');
const v = C.ecartEntreeDevis();
ok(v.mode === 'applique' && v.n === 2 && v.moyenne === 2 && v.hausse === 50 && v.pire === 5, 'n=2, moyenne +2 %, la moitie au-dessus, pire +5 % : ' + JSON.stringify(v));

console.log('-- 3. rien d invente');
t = jeton(null); eq(C.entreeDevisee(t, { prix: 2, natif: 0.001 }), null, 'sans jambe d achat : rien');
ok(t.prixAchat === undefined, 'et le prix n est pas touche');
t = jeton(0.001); eq(C.entreeDevisee(t, { prix: 2, natif: null }), null, 'sans prix natif : rien');
t = jeton(0.01); eq(C.entreeDevisee(t, { prix: 2, natif: 0.001 }), null, 'rapport x10 : lecture abimee, ignoree');
const cpt = C._etat().compteurs;
ok(cpt.entreeDevisAbsent === 1 && cpt.entreeDevisSansNatif === 1 && cpt.entreeDevisAberrante === 1 && cpt.entreeDevis === 2, 'chaque cas compte a part');

console.log('-- 4. observe');
process.env.COLONIE_ENTREE_DEVIS = 'observe';
t = jeton(0.0011);
C.entreeDevisee(t, { prix: 2, natif: 0.001 });
ok(t.prixAchat === undefined && t.prixDevis && t.prixDevis.applique === false && C.ecartEntreeDevis().n === 3, 'observe : mesure (n=3), n applique rien');
delete process.env.COLONIE_ENTREE_DEVIS;

console.log('-- 5. le branchement');
const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
ok(/t\.prixAchat = frais\.prix;[\s\S]{0,700}entreeDevisee\(t, frais\);/.test(src), 'apres la relecture GeckoTerminal, juste avant le garde de rachat et l ouverture');
ok(/natif: nn\(a\.base_token_price_native_currency\)/.test(src), 'la relecture rend le prix natif');
ok(/achat: a \};/.test(src) && /r\.achat\.ethParJeton/.test(src), 'allerRetourMiroir garde la jambe d achat du miroir');
ok(/prixDevis: t\.prixDevis \|\| null,/.test(src) && /entreeDevis: p\.prixDevis \? \{ ratio: p\.prixDevis\.ratio/.test(src), 'la position et le carnet gardent le rapport');
ok(/entreeDevis: ecartEntreeDevis\(\),/.test(src), '/ai/colonie sert l ecart (champ entreeDevis)');
const mi = fs.readFileSync(path.join(__dirname, 'miroir.js'), 'utf8');
ok(/ethParJeton: Number\(SONDE_ETH\) \/ Number\(ethers\.utils\.formatUnits\(choix\.sortie, dec\)\)/.test(mi) && /dec === null \|\| !choix\.sortie/.test(mi), 'miroir.allerRetour : ETH par jeton = sonde / jetons recus ; sans decimales, rien');
C._pose(etat0);
console.log(rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK');
process.exit(rates ? 1 : 0);
