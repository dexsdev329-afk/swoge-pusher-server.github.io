'use strict';
/* ============================================================================
 * L'ALERTE TELEGRAM D'UN APPEL PAYE (alerte_usage.js)
 *
 * Ce qu'elle DOIT tenir :
 *   1. seul un appel PAYE d'un outil suivi alerte (un devis, un 402, un refus
 *      ne sont pas un usage) ; scan_token par defaut ;
 *   2. le message dit l'outil, le montant, le moyen, le payeur abrege, notre
 *      propre portefeuille quand c'en est un, le lien de la transaction — et
 *      JAMAIS les arguments de l'appel ; tout est echappe ;
 *   3. au plus MAX_HEURE messages par heure, le reste resume dans le suivant ;
 *   4. TG_ALERTE_OUTILS : « * » pour tous, « 0 » eteint ;
 *   5. un Telegram en panne ne casse jamais un paiement.
 * ==========================================================================*/
const A = require('./alerte_usage');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const PAYEUR = '0x1111111111111111111111111111111111111111';
const NOUS = '0xE81C67c086c83997b41673e1e41e481c14D756F6';
const TX = '0x' + 'ab'.repeat(32);
const monte = () => {
  const msgs = [];
  let t = 1e12;
  const a = A.cree({ notify: (x) => msgs.push(x), maison: () => new Set([NOUS.toLowerCase()]), maintenant: () => t });
  return { a, msgs, avance: (ms) => { t += ms; } };
};

delete process.env.TG_ALERTE_OUTILS;

console.log('-- 1. seul un appel paye d un outil suivi alerte --');
{
  const { a, msgs } = monte();
  a.note('devis', { outil: 'scan_token' });
  a.note('refus_x402', { outil: 'scan_token' });
  a.note('paye_x402', { outil: 'price', qui: PAYEUR, usd: 0.01, sorte: 'USDC_BASE' });
  ok(msgs.length === 0, 'devis, refus, et un autre outil : aucun message');
  ok(a.note('paye_x402', { outil: 'scan_token', qui: PAYEUR, usd: 0.02, sorte: 'USDC_BASE', tx: TX, reseau: 'eip155:8453', arguments: { address: '0xsecret' } }), 'scan_token paye en x402 : alerte');
  ok(a.note('paye_cle', { outil: 'scan_token', qui: PAYEUR, usd: 0.02 }), 'scan_token paye par cle d API : alerte');
  ok(msgs.length === 2, 'deux messages');

  console.log('\n-- 2. ce que dit le message --');
  const m = msgs[0];
  ok(/scan_token/.test(m) && /\$0\.02/.test(m) && /USDC on Base/.test(m), 'l outil, le montant, le moyen [' + m.split('\n')[0] + ']');
  ok(m.includes('0x1111…1111') && !m.includes(PAYEUR), 'le payeur, abrege');
  ok(m.includes('https://basescan.org/tx/' + TX), 'le lien BaseScan de la transaction');
  ok(!m.includes('0xsecret') && !/address/.test(m), 'jamais les arguments de l appel');
  ok(!/own wallet/.test(m), 'un client n est pas marque « notre portefeuille »');
  ok(/API key/.test(msgs[1]), 'par cle : le moyen le dit');
  a.note('paye_x402', { outil: 'scan_token', qui: 'x402:' + NOUS, usd: 0.02, sorte: 'USDC_BASE' });
  ok(/our own wallet — not a customer/.test(msgs[2]), 'notre propre portefeuille est dit tel quel (majuscules, prefixe x402: compris)');
  a.note('paye_x402', { outil: 'scan_token', qui: PAYEUR, sorte: '<b>x</b>', tx: 'pas-un-hash', reseau: 'eip155:1' });
  ok(!msgs[3].includes('<b>x</b>') && msgs[3].includes('&lt;b&gt;') && !/href/.test(msgs[3]), 'une sorte inconnue est echappee, un faux hash ne fait pas de lien');
  a.note('paye_x402', { outil: 'scan_token', qui: PAYEUR, usd: 0.03, sorte: 'USDG', tx: TX, reseau: 'eip155:4663' });
  ok(msgs[4].includes('robinhoodchain.blockscout.com/tx/' + TX), 'Robinhood Chain : lien Blockscout');
}

console.log('\n-- 3. au plus ' + A.MAX_HEURE + ' messages par heure --');
{
  const { a, msgs, avance } = monte();
  for (let i = 0; i < A.MAX_HEURE + 5; i++) a.note('paye_x402', { outil: 'scan_token', qui: PAYEUR, usd: 0.02, sorte: 'USDC_BASE' });
  ok(msgs.length === A.MAX_HEURE, A.MAX_HEURE + ' messages, pas plus [' + msgs.length + ']');
  ok(a.MESURE.tues === 5, 'les 5 de trop sont comptes');
  avance(3600e3 + 1);
  a.note('paye_x402', { outil: 'scan_token', qui: PAYEUR, usd: 0.02, sorte: 'USDC_BASE' });
  ok(msgs.length === A.MAX_HEURE + 1 && /\+5 more paid calls/.test(msgs[msgs.length - 1]), 'une heure apres : le suivant les resume');
  a.note('paye_x402', { outil: 'scan_token', qui: PAYEUR, usd: 0.02, sorte: 'USDC_BASE' });
  ok(!/more paid/.test(msgs[msgs.length - 1]), 'et le resume n est dit qu une fois');
}

console.log('\n-- 4. le reglage --');
{
  process.env.TG_ALERTE_OUTILS = '*';
  const t = monte();
  t.a.note('paye_x402', { outil: 'price', qui: PAYEUR, sorte: 'USDC_BASE' });
  ok(t.msgs.length === 1, '« * » : tous les outils');
  process.env.TG_ALERTE_OUTILS = 'price, scan_token';
  t.a.note('paye_x402', { outil: 'price', qui: PAYEUR, sorte: 'USDC_BASE' });
  t.a.note('paye_x402', { outil: 'swap_quote', qui: PAYEUR, sorte: 'USDC_BASE' });
  ok(t.msgs.length === 2, 'une liste : ceux de la liste seulement');
  process.env.TG_ALERTE_OUTILS = '0';
  t.a.note('paye_x402', { outil: 'scan_token', qui: PAYEUR, sorte: 'USDC_BASE' });
  ok(t.msgs.length === 2, '« 0 » : eteint');
  delete process.env.TG_ALERTE_OUTILS;
}

console.log('\n-- 5. Telegram en panne --');
{
  const a = A.cree({ notify: () => { throw new Error('telegram down'); }, maison: () => new Set() });
  let casse = null;
  try { a.note('paye_x402', { outil: 'scan_token', qui: PAYEUR, sorte: 'USDC_BASE' }); } catch (e) { casse = e; }
  ok(!casse, 'une alerte qui echoue ne leve jamais (le paiement continue)');
}

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
