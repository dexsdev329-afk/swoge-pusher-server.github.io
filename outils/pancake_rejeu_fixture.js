'use strict';
/* ==========================================================================
 * LE JEU D'ESSAI DE LA PORTE PANCAKE — ROUNDS REELS + MOTEUR REJOUE
 *
 *   node outils/pancake_rejeu_fixture.js <rounds.json> <k1m.json> > pancake_rejeu.json.gz
 *
 * Entrees (lecture seule, hors depot) :
 *   - rounds.json : `rounds(epoch)` du contrat 0x18B2…9cdA, un objet par round
 *     ({ep, lock, lp, cp, tot, bull, bear, oc}), comme l'ecrit le journal
 *     `pancake_rounds.jsonl` (predict_pancake_journal.js) ;
 *   - k1m.json : bougies Binance BNBUSDT 1 min [ouverture ms, o, h, l, c, v].
 *
 * Pour chaque round, le moteur de la page (predict_moteur.js, horizon 5 min)
 * est evalue a T−40 s sur des bougies 5 min rebaties des SEULES minutes closes
 * avant la decision (aucune fuite du futur) — la methode du releve du
 * 26 septembre 2026 (rejeu fidele a 39/40 decisions en direct).
 *
 * Sortie : JSON gzip, une ligne compacte par round
 *   [epoch, bull en 1e-6 BNB, bear en 1e-6 BNB, oracleCalled 0/1, egalite 0/1,
 *    prob du camp du moteur ×10, signee (+ BULL, − BEAR ; 0 = pas de moteur)]
 * C'est ce que `predict_pancake.test.js` rejoue pour exiger 0 pari sous la
 * porte actuelle.
 * ======================================================================== */
const fs = require('fs');
const zlib = require('zlib');
const E = require('../predict_moteur');

const R = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).sort((a, b) => a.ep - b.ep);
const K = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const LEAD = 40;
const k0 = K[0][0], idx1 = (ms) => Math.round((ms - k0) / 60000);
const b5 = new Map();
for (const c of K) {
  const b = Math.floor(c[0] / 300000) * 300000; let x = b5.get(b);
  if (!x) { x = { o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }; b5.set(b, x); }
  else { x.h = Math.max(x.h, c[2]); x.l = Math.min(x.l, c[3]); x.c = c[4]; x.v += c[5]; }
}
function bougies5(Tms) {
  const b = Math.floor(Tms / 300000) * 300000; const out = [];
  for (let t = b - 299 * 300000; t < b; t += 300000) { const x = b5.get(t); if (x) out.push(x); }
  let part = null;   /* la bougie en cours : les minutes CLOSES avant T seulement */
  for (let t = b; t + 60000 <= Tms; t += 60000) {
    const c = K[idx1(t)]; if (!c || c[0] !== t) continue;
    if (!part) part = { o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] };
    else { part.h = Math.max(part.h, c[2]); part.l = Math.min(part.l, c[3]); part.c = c[4]; part.v += c[5]; }
  }
  if (part) out.push(part);
  return out;
}
const moteur = new E.PredictionEngine();
const kPremier = K[0][0] / 1000 + 300 * 300 + 3600, kDernier = K[K.length - 1][0] / 1000;
const lignes = R.map((r) => {
  let p = 0;
  if (r.oc && r.lock >= kPremier && r.lock <= kDernier) {
    const c = bougies5((r.lock - LEAD) * 1000);
    if (c.length >= 30) { const e = moteur.evalue(c); if (e.assez) p = Math.round(e.prob * 10) * (e.sens === 'UP' ? 1 : -1); }
  }
  const egal = r.oc && String(r.lp) === String(r.cp) ? 1 : 0;
  return [r.ep, Math.round(r.bull * 1e6), Math.round(r.bear * 1e6), r.oc ? 1 : 0, egal, p];
});
process.stdout.write(zlib.gzipSync(JSON.stringify(lignes), { level: 9 }));
process.stderr.write(lignes.length + ' rounds, ' + lignes.filter((l) => l[5]).length + ' avec moteur\n');
