'use strict';
/* preuves_x402.js : les paiements d'agents exterieurs, verifiables par leur transaction.
   La maison ecartee, les reseaux d'essai ecartes, le payeur tronque, les montants lisibles. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('./preuves_x402');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const EXT = '0x21c3de23d98caddc406e3d31b25e807addf33633', MAISON = '0xe81c67c086c83997b41673e1e41e481c14d756f6';
const L = [
  { t: Date.UTC(2026, 8, 27, 10), outil: 'scan_token', payer: '0x21C3De23d98caddc406e3d31b25e807addf33633', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', montant: '10000', transaction: '0xaa', network: 'eip155:8453' },
  { t: Date.UTC(2026, 8, 27, 11), outil: 'scan_token', payer: MAISON, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', montant: '10000', transaction: '0xbb', network: 'eip155:8453' },
  { t: Date.UTC(2026, 8, 27, 12), outil: 'can_i_sell', payer: 'Fq9x2WvSYm1aB7c3dE4fG5hJ6kL7mN8pQ9rS1tU2vW3x', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', montant: '8000', transaction: '5hSig', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
  { t: Date.UTC(2026, 8, 28, 9), outil: 'token_verdict', payer: EXT, asset: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', montant: '397410000000000000000', transaction: '0xcc', network: 'eip155:4663' },
  { t: Date.UTC(2026, 8, 28, 10), outil: 'scan_token', payer: EXT, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', montant: '10000', transaction: '0xdd', network: 'eip155:84532' },
  { t: Date.UTC(2026, 8, 28, 11), outil: 'esim', payer: '0x9999999999999999999999999999999999999999', asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', montant: '4230000', transaction: '0xee', network: 'eip155:4663' },
  { t: Date.UTC(2026, 8, 28, 12), outil: 'scan_token', payer: EXT, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', montant: '10000', network: 'eip155:8453' },
];

console.log('\n-- les preuves --');
const r = P.preuves(L, (a) => a === MAISON);
ok(r.recent.length === 4 && r.total.payments === 4, 'quatre paiements exterieurs : la maison, le reseau d essai (Base Sepolia) et une ligne sans transaction sont ecartes');
ok(r.recent[0].tx === '0xee' && r.recent[3].tx === '0xaa', 'les plus recents d abord');
const b = r.recent[3];
ok(b.network === 'Base' && b.asset === 'USDC' && b.amount === 0.01 && b.usd === 0.01 && b.txUrl === 'https://basescan.org/tx/0xaa' && b.at === '2026-09-27T10:00:00.000Z',
   'Base : 10 000 unites = 0,01 USDC, le lien basescan, la date ISO');
ok(b.payer === '0x21c3…e3a3'.replace('e3a3', '3633') && !JSON.stringify(r).includes(EXT) && !JSON.stringify(r).includes('_qui'),
   'le payeur est tronque, et son adresse entiere ne sort nulle part (elle est derriere le lien de la transaction)');
ok(r.recent[1].network === 'Robinhood Chain' && r.recent[1].asset === 'SWOGE' && r.recent[1].amount === 397.41 && r.recent[1].usd === null
   && r.recent[1].txUrl === 'https://robinhoodchain.blockscout.com/tx/0xcc', 'le $SWOGE en $SWOGE (18 decimales), jamais converti au cours du jour');
ok(r.recent[2].network === 'Solana' && r.recent[2].amount === 0.008 && r.recent[2].txUrl === 'https://solscan.io/tx/5hSig' && r.recent[2].payer === 'Fq9x2W…vW3x',
   'Solana : l actif en base58 garde sa casse, lien solscan');
ok(r.total.usd === 4.248 && r.total.inSwoge === 1 && r.total.payers === 3 && r.total.since === '2026-09-27T10:00:00.000Z',
   'le total en dollars (USDC + USDG), les paiements en $SWOGE a part, les payeurs distincts, la date du premier');
ok(JSON.stringify(r.skipped) === JSON.stringify({ noTransaction: 1, otherNetwork: 1, otherAsset: 0, ours: 1, badAmount: 0 }),
   'ce qui est ecarte est compte par raison (des nombres, aucune adresse) [' + JSON.stringify(r.skipped) + ']');
ok(P.preuves(L, (a) => a === MAISON, 2).recent.length === 2 && P.preuves([], null).total.since === null, 'n borne la liste ; un journal vide ne rend rien d invente');

console.log('\n-- l usage par outil, pour l Agent Store --');
const u = P.usageParOutil(L, (a) => a === MAISON, Date.UTC(2026, 8, 27, 11));
ok(JSON.stringify(u) === JSON.stringify({ can_i_sell: { n: 1, usd: 0.008 }, token_verdict: { n: 1, usd: 0 }, esim: { n: 1, usd: 4.23 } }),
   'par outil, exterieurs seulement, depuis le debut de la fenetre ; le $SWOGE compte en appels, pas en dollars [' + JSON.stringify(u) + ']');
const toutMaison = P.usageParOutil(L, () => true);
ok(Object.keys(toutMaison).length === 0, 'le cas mesure le 29/09 : toutes les lignes sont a nous → aucun usage exterieur, quoi que dise le compteur fige');

console.log('\n-- les unites et la lecture du fichier --');
ok(P.lisible('1', 18) === 1e-18 && P.lisible('0', 6) === 0 && P.lisible('abc', 6) === null && P.lisible('1000000', 6) === 1, 'unites brutes → nombre, sans flottant intermediaire');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'preuves-'));
fs.writeFileSync(path.join(d, 'x402.jsonl'), JSON.stringify(L[0]) + '\n{coupe\n' + JSON.stringify(L[2]) + '\n');
ok(P.lisJournal(path.join(d, 'x402.jsonl')).length === 2 && P.lisJournal(path.join(d, 'absent.jsonl')).length === 0, 'une ligne coupee est sautee, un fichier absent rend []');
fs.rmSync(d, { recursive: true, force: true });

console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  ' + rates + ' RATE(S)' : '  —  tout passe'));
process.exit(rates ? 1 : 0);
