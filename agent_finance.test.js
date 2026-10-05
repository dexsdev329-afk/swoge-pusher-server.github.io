'use strict';
/* L'AUTO-FINANCEMENT DU CARBURANT DEPUIS LES FRAIS (agent_finance.js, vague 1 #6).
 *
 * Intention : un passage periodique prend NOTRE part de frais d un jeton (lue on-chain,
 * injectee), en affecte pctFuel % via la cascade de la caisse, et avance un curseur pour
 * ne JAMAIS compter deux fois les memes frais. Par defaut c est un ESSAI (mesurer d abord) :
 * il journalise ce qu il crediterait, sans rien crediter. Pur : aucun reseau. */

const F = require('./agent_finance');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T1 = '0x' + '1'.repeat(40), T2 = '0x' + '2'.repeat(40);

(async () => {
  console.log('-- mode ESSAI (defaut) : journalise, ne credite rien, n avance pas le curseur --');
  {
    let credits = 0, curseurs = 0;
    const r = await F.alimente({
      tokens: [T1], pctFuel: 15, applique: false,
      feesDepuis: async () => ({ feeShareUsd: 10, curseur: 100 }),
      credite: async () => { credits++; return {}; },
      poseCurseur: async () => { curseurs++; },
    });
    ok(credits === 0 && curseurs === 0, 'en essai : aucun credit, aucun curseur avance');
    ok(r.applique === false && r.faits[0].essai && r.faits[0].auraitCredite === 1.5, 'il journalise ce qu il crediterait : 15 % de 10 $ = 1,50 $');
  }

  console.log('\n-- mode REEL (applique) : credite pctFuel %, puis avance le curseur --');
  {
    const credite = [], poses = [];
    const r = await F.alimente({
      tokens: [T1], pctFuel: 15, applique: true,
      feesDepuis: async () => ({ feeShareUsd: 20, curseur: 250 }),
      credite: async (t, usd, src) => { credite.push({ t, usd, src }); return { fuel: usd, tresor: 0, rachat: 0 }; },
      poseCurseur: async (t, c) => { poses.push({ t, c }); },
    });
    ok(credite.length === 1 && credite[0].usd === 3 && credite[0].src === 'fees', 'credite 15 % de 20 $ = 3,00 $, source « fees »');
    ok(poses.length === 1 && poses[0].c === 250, 'le curseur avance a 250 APRES le credit');
    ok(r.faits[0].credite === 3 && r.faits[0].repartition.fuel === 3, 'le fait rend le montant credite et la repartition');
  }

  console.log('\n-- idempotence : le curseur avance → le passage suivant ne revoit plus ces frais --');
  {
    let appels = 0, credits = 0, bloc = 0;
    const feesDepuis = async () => (bloc >= 250 ? { feeShareUsd: 0, curseur: 250 } : { feeShareUsd: 20, curseur: 250 });
    const deps = { tokens: [T1], pctFuel: 15, applique: true, feesDepuis,
      credite: async () => { credits++; return {}; }, poseCurseur: async (t, c) => { bloc = c; } };
    await F.alimente(deps); appels++;
    await F.alimente(deps); appels++;
    ok(appels === 2 && credits === 1, 'deux passages, mais les memes frais ne sont credites QU UNE fois (curseur)');
  }

  console.log('\n-- fail-closed : une lecture de frais muette ou en echec ne credite jamais --');
  {
    let credits = 0;
    await F.alimente({ tokens: [T1, T2], pctFuel: 15, applique: true,
      feesDepuis: async (t) => (t === T1 ? null : { feeShareUsd: 0, curseur: 1 }),
      credite: async () => { credits++; return {}; }, poseCurseur: async () => {} });
    ok(credits === 0, 'frais null ou 0 : rien credite (aucune fausse recharge)');
    let credits2 = 0;
    await F.alimente({ tokens: [T1], pctFuel: 15, applique: true,
      feesDepuis: async () => { throw new Error('rpc down'); },
      credite: async () => { credits2++; return {}; }, poseCurseur: async () => {} });
    ok(credits2 === 0, 'feesDepuis qui jette : saute le jeton, rien credite, pas d exception');
  }

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
