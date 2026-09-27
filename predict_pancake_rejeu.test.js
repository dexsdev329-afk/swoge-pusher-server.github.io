'use strict';
/* ============================================================================
 * PANCAKE — LA PORTE ACTUELLE, REJOUÉE SUR LES ROUNDS STOCKÉS : 0 PARI
 *
 * Rapport du 26 septembre 2026, §5.1 : « ne pas desserrer la porte Pancake ;
 * un essai rejoue les rounds stockés et exige 0 pari ». Cet essai en est le
 * gardien : si quelqu'un baisse la marge, retire le gaz compté, remplace la
 * prob bridée par autre chose ou repasse en mode direct, il tombe.
 *
 * Le rejeu seul ne le garantissait PAS pour le code (vérifié le 27/09 par
 * mutation) : le meilleur prob × cote du jeu est 1,046, donc retirer le gaz
 * (`ev = p·m − 1`) OU la marge (`ev > 0`) laissait chacun 0 pari, et toutes
 * les suites Pancake restaient vertes. D'où le §4 : `decide` appelé tout
 * droit à la frontière de chaque terme, chacun isolé par la mise (le gaz
 * compte GAZ/mise), et le §5 : le rejeu à CHAQUE palier de la martingale —
 * l'étage réel appelle `decide` avec la mise de l'échelle, et aux paliers
 * 1 à 4 (0,004 à 0,032) la meilleure EV est de +0,018 à +0,029 : au-dessus
 * de 0, sous la marge. Là, c'est la marge seule qui tient 0 pari.
 *
 * Les rounds : `pancake_rejeu.json.gz`, 30 004 rounds réels du contrat
 * 0x18B2…9cdA (epochs 489 160 → 519 163, 12/06 → 26/09/2026, lus par
 * `rounds(epoch)`), avec la note du moteur de la page rejouée à T−40 s sur les
 * bougies Binance closes avant la décision (`outils/pancake_rejeu_fixture.js`,
 * rejeu fidèle à 39/40 décisions en direct). Le code rejoué est celui du
 * module — `decide`, `noteFinale`, `inverse` —, aux réglages de production
 * relevés sur /predict/pancake le 26/09 à 21:52 UTC : mise 0,002, gaz 0,0001,
 * marge 0,05, mode inverse. La cote visible de l'époque est perdue : le rejeu
 * la prend la plus favorable, ce qui ne peut qu'AJOUTER des paris.
 *
 * `PANCAKE_JOURNAL_DIR=<dossier>` rejoue aussi le journal de production
 * (pancake_rounds.jsonl + pancake_decisions.jsonl), avec la note du moteur
 * écrite à la décision.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), readline = require('readline');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-rejeu-'));
/* Les réglages de production : aucun surchargé, sauf le mode inverse, posé
   sur l'hôte (`inverse: true` dans /predict/pancake le 26/09). */
for (const k of ['PREDICT_PANCAKE_STAKE', 'PREDICT_PANCAKE_GAZ', 'PREDICT_PANCAKE_MARGE']) delete process.env[k];
process.env.PREDICT_PANCAKE_INVERSE = '1';
const P = require('./predict_pancake');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

function depuisFixture() {
  const L = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'pancake_rejeu.json.gz'))));
  return L.map((l) => ({ ep: l[0], bull: l[1] / 1e6, bear: l[2] / 1e6, oc: !!l[3], egal: !!l[4],
                         pred: l[5] ? { sens: l[5] > 0 ? 'UP' : 'DOWN', prob: Math.abs(l[5]) / 10 } : null }));
}
async function depuisJournal(dir) {
  const lit = async (f, fn) => { if (!fs.existsSync(f)) return; const rl = readline.createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity }); for await (const s of rl) { try { fn(JSON.parse(s)); } catch (e) {} } };
  const dec = new Map(), out = [];
  await lit(path.join(dir, 'pancake_decisions.jsonl'), (d) => { if (d.moteur) dec.set(Number(d.ep), d.moteur); });
  await lit(path.join(dir, 'pancake_rounds.jsonl'), (l) => out.push({ ep: l.ep, bull: l.bull, bear: l.bear, tot: l.tot, oc: l.oc, pred: dec.get(l.ep) || null }));
  return out;
}

(async () => {
  console.log('-- 1. les réglages rejoués sont ceux de la production --');
  ok(P.STAKE === 0.002 && P.GAZ === 0.0001 && P.MARGE === 0.05, 'mise 0,002 · gaz 0,0001 · marge 0,05 (défauts du module = /predict/pancake du 26/09)');
  ok(P.INVERSE === true, 'mode inverse, comme sur l hôte');

  console.log('\n-- 2. rejouée sur 30 004 rounds stockés, la porte actuelle mise 0 fois --');
  const L = depuisFixture();
  ok(L.length === 30004 && L.filter((l) => l.pred).length === 29472, 'le jeu : 30 004 rounds, 29 472 avec la note du moteur');
  ok(L.filter((l) => !l.oc).length === 45, 'dont 45 annulés (oracle non appelé), comme le relevé');
  const inv = P.rejouePorte(L);
  console.log('       (mode inverse : ' + inv.jugees + ' rounds jugés, ' + inv.paris + ' pari(s), meilleure EV ' + (100 * inv.maxEv).toFixed(1) + ' %, prob max ' + inv.maxProb + ' %, meilleur prob × cote ' + inv.maxProduit + ')');
  ok(inv.jugees > 29000, 'la porte a bien jugé chaque round (' + inv.jugees + ')');
  ok(inv.paris === 0, 'ZÉRO pari sous la porte actuelle [' + inv.paris + ']');
  ok(inv.maxProb <= 50, 'la prob du camp inverse ne dépasse jamais 50 % (moteur bridé 50–68 %) [' + inv.maxProb + ']');
  ok(inv.maxProduit < 1 + P.GAZ / P.STAKE + P.MARGE, 'prob × cote attendue reste sous le seuil de ' + (1 + P.GAZ / P.STAKE + P.MARGE).toFixed(2) + ' [' + inv.maxProduit + ']');

  console.log('\n-- 3. le rejeu n est pas vide : c est la porte qui ferme, pas les données --');
  const dir = P.rejouePorte(L, { inverse: false });
  console.log('       (mode direct : ' + dir.paris + ' paris sur ' + dir.jugees + ')');
  ok(dir.paris > 15000, 'en mode direct (prob du moteur 50–68 %), la même porte ouvrirait sur ' + dir.paris + ' rounds — à −4 % par pari (relevé du 26/09)');

  console.log('\n-- 4. decide() à la frontière du gaz et de la marge --');
  {
    /* Des cotes finales synthétiques : 12 rounds (FINALES_MIN) à la cote c,
       pool 1e6 BNB (notre mise n y dilue rien), camp visible vide (la cote
       vue est énorme : c est l estimée qui compte). prob 50 : p·m = c/2. */
    const fin = (c) => { const T = 1e6, L = []; for (let i = 0; i < P.FINALES_MIN; i++) L.push({ c, t: T }); return { BULL: L.slice(), BEAR: L.slice(), dernierEp: 0 }; };
    const vis = { bull: 0, bear: 1e6, total: 1e6 };
    const pred = { sens: 'UP', prob: 50, assez: true };
    const d = (produit, mise) => P.decide(pred, vis, 0.03, mise, fin(2 * produit));
    /* (a) mise 0,002 : gaz 0,05 de la mise. p·m 1,08 → EV 0,08 avant gaz, 0,03
       après : sous la marge 0,05. Sans le gaz (0,08) OU sans la marge (> 0),
       ce round parierait. */
    const a = d(1.08, 0.002);
    ok(a.wouldBet === false && Math.abs(a.ev - 0.03) < 1e-3, 'p·m 1,08 à 0,002 : EV +0,03 après gaz, sous la marge → pas de pari [' + a.ev + ']');
    /* (b) le GAZ seul : mise 0,001, gaz 0,10 de la mise. p·m 1,08 → −0,02
       après gaz. Retirer la marge ne change rien (−0,02 < 0) ; retirer le gaz
       donne 0,08 > 0,05 : pari. */
    const b = d(1.08, 0.001);
    ok(b.wouldBet === false && Math.abs(b.ev + 0.02) < 1e-3, 'le gaz seul : p·m 1,08 à 0,001 → EV −0,02, pas de pari (sans gaz : +0,08, il parierait) [' + b.ev + ']');
    /* (c) la MARGE seule : mise 0,02, gaz 0,005 de la mise. p·m 1,04 → +0,035
       après gaz. Retirer le gaz donne 0,04 < 0,05 : rien ne change ; retirer
       la marge donne 0,035 > 0 : pari. */
    const c = d(1.04, 0.02);
    ok(c.wouldBet === false && Math.abs(c.ev - 0.035) < 1e-3, 'la marge seule : p·m 1,04 à 0,02 → EV +0,035, sous 0,05, pas de pari (sans marge, il parierait) [' + c.ev + ']');
    /* (d) Et la porte n est pas murée : p·m 1,12 à 0,002 → +0,07 > 0,05. */
    const e = d(1.12, 0.002);
    ok(e.wouldBet === true && Math.abs(e.ev - 0.07) < 1e-3, 'p·m 1,12 à 0,002 → EV +0,07 : la porte s ouvre bien au-delà du seuil [' + e.ev + ']');
  }

  console.log('\n-- 5. le rejeu à chaque palier de la martingale : 0 pari --');
  {
    /* L étage réel décide avec la mise de l échelle (base × facteur^k). */
    for (let k = 0; k <= P.MART_PALIERS; k++) {
      const mise = Math.round(P.STAKE * Math.pow(P.MART_FACTEUR, k) * 1e6) / 1e6;
      const r = P.rejouePorte(L, { stake: mise });
      ok(r.jugees > 29000 && r.paris === 0, 'palier ' + k + ' (mise ' + mise + ') : 0 pari sur ' + r.jugees + ' [meilleure EV ' + (100 * r.maxEv).toFixed(1) + ' %]');
    }
  }

  if (process.env.PANCAKE_JOURNAL_DIR) {
    console.log('\n-- 4. le journal de production --');
    const JL = await depuisJournal(process.env.PANCAKE_JOURNAL_DIR);
    const r = P.rejouePorte(JL);
    console.log('       (' + JL.length + ' rounds, ' + r.jugees + ' jugés avec la note écrite à la décision)');
    ok(r.paris === 0, 'le journal rejoué : 0 pari [' + r.paris + ']');
  }

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
