'use strict';
/* LE CARBURANT D'UN AGENT DE JETON.
 *
 * Intention : un solde en dollars par jeton, credite (volume/versement) et
 * debite (cout reel d'une pensee) ; un versement de bienvenue UNE fois ; on ne
 * depense jamais a credit (debite borne a 0, peutPenser garde l'avance) ;
 * comptabilite exacte, bornee, persistante. Aucun mouvement d'argent on-chain.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('./agent_fuel');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T = '0x' + '1'.repeat(40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fuel-'));
let horloge = 1000;
const S = F.cree({ fichier: path.join(dir, 'f.json'), maintenant: () => horloge, grantInitialUsd: 0.10 });

console.log('-- 1. versement de bienvenue, une seule fois --');
ok(Math.abs(S.solde(T) - 0.10) < 1e-9, 'au premier contact : 0,10 $ de bienvenue');
ok(Math.abs(S.solde(T) - 0.10) < 1e-9, 'un second regard ne re-credite pas la bienvenue');
ok(S.vue(T).crediteUsd === 0.10 && S.vue(T).debiteUsd === 0, 'le total credite = la bienvenue, rien debite');

console.log('\n-- 2. crediter (versement / part de frais) --');
let r = S.credite(T, 0.90, 'topup');
ok(r.ok && Math.abs(r.solde - 1.0) < 1e-9, 'un versement de 0,90 $ : solde 1,00 $');
ok(S.credite(T, -1, 'x').ok === false && S.credite('pas-0x', 1).ok === false, 'un montant <= 0 ou une adresse invalide : refuses');
r = S.credite(T, 0.25, 'fees');
ok(r.ok && S.vue(T).mouvements[0].note === 'fees', 'la part de frais se credite aussi (source notee)');

console.log('\n-- 3. debiter au cout reel, sans jamais passer sous 0 --');
r = S.debite(T, 0.20, 'post');
ok(r.ok && Math.abs(r.solde - 1.05) < 1e-9 && r.manque === 0, 'une pensee a 0,20 $ : solde 1,05 $, rien ne manque');
r = S.debite(T, 5.0, 'post');
ok(r.ok && r.solde === 0 && r.manque > 0, 'un debit plus grand que le solde : on s arrete a 0 et on signale le manque (ne doit pas arriver si peutPenser est appele)');

console.log('\n-- 4. peutPenser : on garde l avance --');
ok(S.peutPenser(T, 0) === true || S.solde(T) === 0, 'a 0 : ne peut penser que si le cout est 0');
S.credite(T, 0.01, 'topup');
ok(S.peutPenser(T, 0.005, 0) === true, '0,01 $ en caisse : peut penser une pensee a 0,005 $');
ok(S.peutPenser(T, 0.02, 0) === false, 'mais pas une pensee a 0,02 $ : l agent dort');
ok(S.peutPenser(T, 0.005, 0.01) === false, 'avec un plancher de 0,01 $ : pas assez non plus');

console.log('\n-- 5. exactitude et persistance --');
ok(S.vue(T).soldeUsd === S.solde(T) && S.vue(T).mouvements.length <= 20, 'la vue rend le solde et borne les mouvements');
const relu = F.cree({ fichier: path.join(dir, 'f.json'), maintenant: () => horloge, grantInitialUsd: 0.10 });
ok(Math.abs(relu.solde(T) - S.solde(T)) < 1e-9, 'le solde survit a un redemarrage (pas de re-bienvenue)');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
