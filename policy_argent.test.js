'use strict';
/* LE POLICY ENGINE (gestes d'argent).
 *
 * Intention : deterministe ; action hors liste blanche, montant <= 0 ou au-dela
 * du plafond par action, impact-prix trop fort, tresor insuffisant → refus ;
 * cooldown entre gestes ; fenetres heure/jour glissantes respectees ; note()
 * fait voir le geste aux fenetres suivantes ; persistance.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const P = require('./policy_argent');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T = '0x' + '1'.repeat(40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
let horloge = Date.parse('2026-10-05T12:00:00Z');
const S = P.cree({ fichier: path.join(dir, 'p.json'), maintenant: () => horloge,
  limites: { maxParActionUsd: 10, maxParHeureUsd: 25, maxParJourUsd: 100, impactMaxPct: 2, cooldownSec: 300 } });
const ctx = { tresorUsd: 1000 };

console.log('-- 1. refus deterministes --');
ok(!S.evalue({ token: 'pas-0x', action: 'buyback', montantUsd: 1 }, ctx).autorise, 'adresse invalide : refus');
ok(!S.evalue({ token: T, action: 'rug', montantUsd: 1 }, ctx).autorise, 'action hors liste blanche : refus');
ok(!S.evalue({ token: T, action: 'buyback', montantUsd: 0 }, ctx).autorise, 'montant 0 : refus');
ok(/per-action/.test(S.evalue({ token: T, action: 'buyback', montantUsd: 11 }, ctx).raison || ''), 'au-dela du plafond absolu par action (10 $) : refus');
ok(/price impact/.test(S.evalue({ token: T, action: 'buyback', montantUsd: 5, impactPrixPct: 3 }, ctx).raison || ''), 'impact-prix > 2 % : refus');
ok(!S.evalue({ token: T, action: 'buyback', montantUsd: 5 }, { tresorUsd: 2 }).autorise, 'plus que la part d un petit tresor : refus');

console.log('\n-- 1b. les plafonds dependent de la TRESORERIE (part %) --');
const Spart = P.cree({ fichier: path.join(dir, 'part.json'), maintenant: () => horloge,
  limites: { partParActionPct: 5, partParHeurePct: 10, partParJourPct: 25, maxParActionUsd: 1e9, maxParHeureUsd: 1e9, maxParJourUsd: 1e9, impactMaxPct: 2, cooldownSec: 300 } });
ok(Spart.evalue({ token: T, action: 'buyback', montantUsd: 5 }, { tresorUsd: 100 }).autorise, 'tresor 100 $ : un geste de 5 $ (= 5 %) passe');
ok(!Spart.evalue({ token: T, action: 'buyback', montantUsd: 6 }, { tresorUsd: 100 }).autorise, 'tresor 100 $ : 6 $ (> 5 %) refuse');
ok(Spart.evalue({ token: T, action: 'buyback', montantUsd: 40 }, { tresorUsd: 1000 }).autorise, 'tresor 1000 $ : un geste de 40 $ (< 5 %) passe — un plus gros tresor permet de plus gros gestes');

console.log('\n-- 2. un geste permis, puis cooldown --');
let r = S.evalue({ token: T, action: 'buyback', montantUsd: 5, impactPrixPct: 1 }, ctx);
ok(r.autorise && r.reste.heure === 20 && r.reste.jour === 95, 'permis : reste 20 $/h et 95 $/j');
S.note({ token: T, action: 'buyback', montantUsd: 5 });
ok(/cooldown/.test(S.evalue({ token: T, action: 'buyback', montantUsd: 5 }, ctx).raison || ''), 'juste apres : cooldown');
horloge += 301 * 1000;
ok(S.evalue({ token: T, action: 'buyback', montantUsd: 5 }, ctx).autorise, 'apres 5 min : de nouveau permis');

console.log('\n-- 3. la fenetre horaire --');
S.note({ token: T, action: 'buyback', montantUsd: 5 });   /* total heure = 10 */
horloge += 301 * 1000; S.note({ token: T, action: 'buyback', montantUsd: 10 });  /* total heure = 20 */
horloge += 301 * 1000;
ok(/hourly cap/.test(S.evalue({ token: T, action: 'buyback', montantUsd: 10 }, ctx).raison || ''), 'un 10 $ de plus depasserait 25 $/h : refus');
ok(S.evalue({ token: T, action: 'buyback', montantUsd: 5 }, ctx).autorise, 'mais 5 $ tient dans l heure');

console.log('\n-- 4. la fenetre glisse : apres une heure, le compteur retombe --');
horloge += 3600 * 1000 + 1000;
ok(S.evalue({ token: T, action: 'buyback', montantUsd: 10 }, ctx).autorise, 'une heure plus tard : l heure est repartie a zero');

console.log('\n-- 5. persistance --');
const relu = P.cree({ fichier: path.join(dir, 'p.json'), maintenant: () => horloge });
ok(relu.vue(T).jourUsd > 0 && relu.vue(T).dernier, 'l historique du jour survit a un redemarrage');

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
process.exit(rates ? 1 : 0);
