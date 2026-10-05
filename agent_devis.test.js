'use strict';
/* LE VRAI DEVIS (lecture seule, 8c piece 1).
 *
 * Intention : un quoter injecte (le miroir cote serveur) donne la sortie ; on en
 * tire un IMPACT-PRIX honnete en comparant le prix a taille reelle au prix
 * marginal (taille minuscule) ; un gros ordre sur une piscine mince ressort avec
 * un gros impact ; un devis a zero (pas de liquidite) ou qui jette ne passe pas ;
 * aucune signature, aucune cle (lecture seule).
 */
const D = require('./agent_devis');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const POOL = '0x' + 'b'.repeat(40);

/* Un AMM produit-constant x*y=k pour l essai : WETH in -> token out. Plus l ordre
   est gros par rapport a la reserve, plus l impact monte. */
function amm(reserveIn, reserveOut) {
  return (entree) => { const dx = Number(entree); return (reserveOut * dx) / (reserveIn + dx); };
}

(async () => {
  console.log('-- 1. impact faible sur une piscine profonde --');
  let r = await D.devis({ pool: POOL, entree: 0.01 }, { quote: amm(1000, 1000000) });
  ok(r.ok && r.pool === POOL && r.sortie > 0, 'devis ok, le pool passe, une sortie positive');
  ok(r.impactPct >= 0 && r.impactPct < 0.01, 'piscine profonde, petit ordre : impact quasi nul (' + r.impactPct + '%)');

  console.log('\n-- 2. impact fort sur une piscine mince --');
  r = await D.devis({ pool: POOL, entree: 100 }, { quote: amm(1000, 1000000) });
  ok(r.ok && r.impactPct > 5, 'gros ordre (100 pour une reserve de 1000) : impact notable (' + r.impactPct + '%)');

  console.log('\n-- 3. l impact grandit avec la taille --');
  const q = amm(1000, 1000000);
  const petit = (await D.devis({ pool: POOL, entree: 1 }, { quote: q })).impactPct;
  const gros = (await D.devis({ pool: POOL, entree: 50 }, { quote: q })).impactPct;
  ok(gros > petit, 'un ordre plus gros a un impact plus fort (' + petit + '% -> ' + gros + '%)');

  console.log('\n-- 4. refus propres --');
  ok((await D.devis({ pool: POOL, entree: 0 }, { quote: q })).ok === false, 'entree <= 0 : refus');
  ok((await D.devis({ pool: POOL, entree: 1 }, {})).ok === false, 'sans quoter : refus');
  ok((await D.devis({ pool: POOL, entree: 1 }, { quote: () => 0 })).ok === false, 'quote a zero (pas de liquidite) : refus');
  ok((await D.devis({ pool: POOL, entree: 1 }, { quote: () => { throw new Error('rpc'); } })).ok === false, 'quote qui jette : refus');

  console.log('\n-- 5. lecture seule : aucune cle, aucun envoi dans le module --');
  const fs = require('fs'), path = require('path');
  ok(!/privateKey|signTransaction|sendTransaction|MIROIR_CLE/i.test(fs.readFileSync(path.join(__dirname, 'agent_devis.js'), 'utf8')), 'le code du devis ne touche aucune cle ni envoi');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
