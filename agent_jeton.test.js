'use strict';
/* LE REGISTRE JETON → AGENT.
 *
 * Intention (à tenir si un changement contredit l'essai) : un agent par jeton,
 * attaché à l'adresse du jeton ; SEUL son créateur l'attache ou le modifie ;
 * les pouvoirs d'argent (buyback/trade/airdrop) se DÉCLARENT mais restent
 * inertes (pouvoirsActifs ne rend que le social) ; un geste n'est « dû » que si
 * la cadence s'est écoulée ; tout survit à un redémarrage.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('./agent_jeton');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T1 = '0x' + '1'.repeat(40);           /* un jeton */
const T2 = '0x' + '2'.repeat(40);           /* un autre */
const C1 = '0x' + 'a'.repeat(40);           /* un créateur */
const C2 = '0x' + 'b'.repeat(40);           /* un autre créateur */
const POOL = '0x' + 'c'.repeat(40);

console.log('-- 1. valide : nettoie, borne, refuse l inconnu --');
ok(R.valide({ token: 'pas-0x', createur: C1, persona: 'stoic' }).erreur, 'un token sans 0x : refusé');
ok(R.valide({ token: T1, createur: 'x', persona: 'stoic' }).erreur, 'un créateur sans 0x : refusé');
ok(/persona/.test(R.valide({ token: T1, createur: C1, persona: 'inventée' }).erreur || ''), 'une persona inconnue : refusée, et on liste les choix');
ok(/model/.test(R.valide({ token: T1, createur: C1, persona: 'stoic', modele: 'gemini' }).erreur || ''), 'un modèle hors allow-list : refusé');
let v = R.valide({ token: T1.toUpperCase().replace('0X', '0x'), createur: C1, persona: 'ANALYST', modele: 'GPT', cadenceMin: 99999, objectif: 'x'.repeat(500), pouvoirs: ['trade', 'inconnu', 'post', 'post'] });
ok(v.config && v.config.cadenceMin === R.CADENCE_MAX, 'une cadence démesurée est ramenée au plafond');
ok(v.config.objectif.length === R.OBJECTIF_MAX, 'un objectif trop long est coupé à OBJECTIF_MAX');
ok(JSON.stringify(v.config.pouvoirs) === JSON.stringify(['post', 'trade']), 'les pouvoirs : ordre figé, pas de doublon, pas d inconnu, post toujours présent');
ok(v.config.persona === 'analyst' && v.config.modele === 'gpt', 'persona et modèle normalisés en minuscules');
v = R.valide({ token: T1, createur: C1, persona: 'hype' });
ok(v.config.pouvoirs.length === 1 && v.config.pouvoirs[0] === 'post', 'sans pouvoirs demandés : post seul');

console.log('\n-- 2. pouvoirsActifs : l argent est inerte --');
ok(JSON.stringify(R.pouvoirsActifs(['post', 'image', 'buyback', 'trade', 'airdrop', 'reply'])) === JSON.stringify(['post', 'image', 'reply']),
   'déclarer buyback/trade/airdrop ne les active pas : seul le social est exécutable aujourd hui');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-jeton-'));
let horloge = Date.parse('2026-10-05T12:00:00Z');
const S = R.cree({ fichier: path.join(dir, 'a.json'), maintenant: () => horloge });

console.log('\n-- 3. attache : un agent par jeton, propriété du créateur --');
let r = S.attache({ token: T1, createur: C1, pool: POOL, persona: 'builder', modele: 'claude', objectif: 'ship in public', cadenceMin: 30 });
ok(r.ok && r.agent.token === T1.toLowerCase() && r.agent.personaLabel === 'Builder', 'le créateur attache l agent de son jeton');
ok(r.agent.actif === true && r.agent.pool === POOL.toLowerCase(), 'né actif, avec le pool');
r = S.attache({ token: T1, createur: C2, persona: 'hype' });
ok(!r.ok && r.code === 403, 'un AUTRE que le créateur ne peut pas réattacher le jeton : 403');
r = S.attache({ token: T1, createur: C1, persona: 'stoic', objectif: 'hold the line' });
ok(r.ok && r.agent.persona === 'stoic' && r.agent.objectif === 'hold the line', 'le créateur met à jour sa persona et son objectif');
ok(S.parJeton(T1).cree <= S.parJeton(T1).maj, 'la date de création est conservée, maj avance');

console.log('\n-- 4. le plafond par créateur --');
const S2 = R.cree({ fichier: path.join(dir, 'b.json'), maintenant: () => horloge });
let pose = 0;
for (let i = 0; i < R.MAX_PAR_CREATEUR; i++) {
  const tok = '0x' + String(i + 10).padStart(40, '0');
  if (S2.attache({ token: tok, createur: C1, persona: 'analyst' }).ok) pose++;
}
ok(pose === R.MAX_PAR_CREATEUR, 'on atteint MAX_PAR_CREATEUR agents');
r = S2.attache({ token: T2, createur: C1, persona: 'analyst' });
ok(!r.ok && r.code === 409, 'au-delà du plafond : 409');
ok(S2.attache({ token: T2, createur: C2, persona: 'analyst' }).ok, 'un autre créateur n est pas bloqué par le plafond du premier');

console.log('\n-- 5. pause, reprise, et seul le créateur --');
r = S.bascule(T1, C2, false);
ok(!r.ok && r.code === 403, 'un autre ne peut pas mettre l agent en pause');
r = S.bascule(T1, C1, false);
ok(r.ok && r.agent.actif === false, 'le créateur met son agent en pause');
ok(S.dus(horloge).every((a) => a.token !== T1.toLowerCase()), 'un agent en pause n est jamais « dû »');
S.bascule(T1, C1, true);

console.log('\n-- 6. « dû » selon la cadence --');
ok(S.dus(horloge).some((a) => a.token === T1.toLowerCase()), 'jamais agi : dû tout de suite');
S.noteGeste(T1, 'post', horloge);
ok(S.dus(horloge).every((a) => a.token !== T1.toLowerCase()), 'juste après un geste : plus dû');
horloge += 29 * 60000;
ok(S.dus(horloge).every((a) => a.token !== T1.toLowerCase()), 'avant la cadence (29 < 30 min) : toujours pas dû');
horloge += 2 * 60000;
ok(S.dus(horloge).some((a) => a.token === T1.toLowerCase()), 'une fois la cadence écoulée (31 min) : dû à nouveau');

console.log('\n-- 7. persistance (relecture du fichier) --');
const relu = R.cree({ fichier: path.join(dir, 'a.json'), maintenant: () => horloge });
ok(relu.parJeton(T1) && relu.parJeton(T1).persona === 'stoic', 'l agent survit à un redémarrage');
ok(relu.parCreateur(C1).length === 1 && relu.compte() === 1, 'parCreateur et compte relisent le disque');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
