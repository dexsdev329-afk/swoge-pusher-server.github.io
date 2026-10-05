'use strict';
/* LE SIGNER ISOLE (EN PAPIER).
 *
 * Intention : pour un geste approuve, il RESIMULE et ne signe QUE ce qui
 * correspond — meme pool du jeton (jamais une adresse d'ailleurs), impact live
 * sous le plafond approuve ; un devis qui echoue ou vise un autre pool est
 * REFUSE ; ce qui est signe est une transaction PAPIER (aucune crypto bougee),
 * journalisee ; aucune cle n'entre jamais dans ce module.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const SG = require('./signer_papier');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const T = '0x' + '1'.repeat(40), POOL = '0x' + 'b'.repeat(40), AUTRE = '0x' + 'e'.repeat(40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-'));
let horloge = 1000;
const S = SG.cree({ fichier: path.join(dir, 's.json'), maintenant: () => horloge });
const approuve = { token: T, action: 'buyback', montantUsd: 5, pool: POOL, impactMaxPct: 2 };

(async () => {
  console.log('-- 1. resimule et signe (papier) ce qui correspond --');
  let r = await S.signe(approuve, { devis: async () => ({ ok: true, pool: POOL, impactPct: 1.2, sortie: 123 }) });
  ok(r.signe && r.papier && r.recu.mode === 'paper' && r.recu.montantUsd === 5 && r.recu.impactPct === 1.2, 'devis concordant : signe en PAPIER, le recu porte le mode paper');
  ok(/^paper_/.test(r.recu.id), 'l identifiant dit clairement « paper »');

  console.log('\n-- 2. ne signe JAMAIS un autre pool que celui du jeton --');
  r = await S.signe(approuve, { devis: async () => ({ ok: true, pool: AUTRE, impactPct: 1, sortie: 1 }) });
  ok(!r.signe && /pool mismatch/.test(r.raison), 'le devis vise un autre pool : refus (jamais une adresse d ailleurs)');

  console.log('\n-- 3. resimule l impact : au-dela de l approuve, refus --');
  r = await S.signe(approuve, { devis: async () => ({ ok: true, pool: POOL, impactPct: 3, sortie: 1 }) });
  ok(!r.signe && /impact exceeds/.test(r.raison), 'impact live 3 % > plafond approuve 2 % : refus');

  console.log('\n-- 4. un devis qui echoue, ou pas de devis, ne signe rien --');
  r = await S.signe(approuve, { devis: async () => ({ ok: false }) });
  ok(!r.signe && /did not succeed/.test(r.raison), 'devis en echec : pas de signature');
  r = await S.signe(approuve, { devis: async () => { throw new Error('rpc down'); } });
  ok(!r.signe && /simulation failed/.test(r.raison), 'devis qui jette : pas de signature');
  r = await S.signe(approuve, {});
  ok(!r.signe && /no quoter/.test(r.raison), 'sans devis : pas de signature');
  r = await S.signe({ token: T, action: 'buyback', montantUsd: 5 }, { devis: async () => ({ ok: true, pool: POOL, impactPct: 1 }) });
  ok(!r.signe && /no valid pool/.test(r.raison), 'intention sans pool : refus');

  console.log('\n-- 5. le journal papier --');
  ok(S.journal(T).length === 1 && S.journal(T)[0].mode === 'paper', 'seule la transaction concordante est au journal, en papier');
  const relu = SG.cree({ fichier: path.join(dir, 's.json'), maintenant: () => horloge });
  ok(relu.journal(T).length === 1 && relu.tout(10).length === 1, 'le journal papier survit a un redemarrage');

  console.log('\n-- 6. aucune cle dans le module --');
  ok(!/privateKey|signTransaction|sendTransaction|\bwallet\b/i.test(fs.readFileSync(path.join(__dirname, 'signer_papier.js'), 'utf8')), 'le code du signer ne touche aucune cle ni envoi reel');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
