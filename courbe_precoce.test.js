'use strict';
/* ==================================================================
 * L'OBSERVATEUR DE COURBE PRECOCE (23/10/2026) — OBSERVATION STRICTE
 * ==================================================================
 * Il pilote le VRAI chemin : la decouverte vient du carnet (fraiches), les
 * evenements arrivent par getLogs et sont bufferises, le jugement tranche le
 * buffer a chaque horizon. Pas d'injection directe du buffer : un vert qui ne
 * refleterait pas la prod serait la panne (lecon miroir_reel).
 *
 * Scenario : deux courbes fraiches, bloc0 connu du carnet.
 *   A : achat minute 1, achats poussant le prix +50 % a T+15, graduation a T+30.
 *   B : achat minute 1, ventes effondrant le prix vers le plancher a T+15.
 * On avance la pointe et l'horloge de la minute 1 a T+65 ; on juge la forme des
 * lignes d'audit, le net de 6 %, la mort comptee, la graduation precoce, le
 * refus de conclure, et surtout l'INERTIE : aucun achat possible.
 * ================================================================== */

const CP = require('./courbe_precoce');
const SP = require('./smart_pons');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) { rates++; console.log('  RATE ' + m); } else console.log('  ok   ' + m); };

/* ---- fabrique de logs bruts (decodes par SP.decodeCourbe) ---- */
const pad = (a) => '0x' + '0'.repeat(24) + String(a).slice(2).toLowerCase();
const w256 = (v) => BigInt(v).toString(16).padStart(64, '0');
const COURBE_A = '0x' + 'a'.repeat(40), COURBE_B = '0x' + 'b'.repeat(40);
const DEV = '0x' + 'd'.repeat(40), ACH = '0x' + '1'.repeat(40);
/* un achat : data = [cote(wei ETH), jetons(wei)] ; prix = cote/jetons */
const logAchat = (courbe, bloc, i, coteWei, jetonsWei) => ({
  address: courbe, blockNumber: '0x' + bloc.toString(16), logIndex: '0x' + i.toString(16),
  topics: [SP.TOPIC.ACHAT, pad(DEV), pad(ACH)], data: '0x' + w256(coteWei) + w256(jetonsWei) + w256(0) + w256(0) });
const logVente = (courbe, bloc, i, jetonsWei, coteWei) => ({
  address: courbe, blockNumber: '0x' + bloc.toString(16), logIndex: '0x' + i.toString(16),
  topics: [SP.TOPIC.VENTE, pad(ACH), pad(DEV)], data: '0x' + w256(jetonsWei) + w256(coteWei) + w256(0) + w256(0) });
const logGrad = (courbe, bloc, i) => ({
  address: courbe, blockNumber: '0x' + bloc.toString(16), logIndex: '0x' + i.toString(16),
  topics: [SP.TOPIC.GRADUATION_COURBE], data: '0x' });

/* prix plancher ~1,68e-9 ETH/jeton : 1 jeton (1e18 wei) coute ~1,68e-9 ETH
   (1,68e9 wei). On fixe le prix par le ratio cote/jetons. */
const ETH = (x) => BigInt(Math.round(x * 1e18));       // ETH -> wei
const JET = (x) => BigInt(Math.round(x * 1e18));       // jetons -> wei (18 dec)
/* un achat qui realise un prix p (ETH/jeton) pour q jetons : cote = p*q */
const achatPrix = (courbe, bloc, i, p, q) => logAchat(courbe, bloc, i, ETH(p * q), JET(q));
const ventePrix = (courbe, bloc, i, p, q) => logVente(courbe, bloc, i, JET(q), ETH(p * q));

const BPM = CP.BLOCS_PAR_MIN_DEFAUT;         // 593
const B0 = 1000000;                          // bloc0 des deux courbes
const T0 = 1700000000000;                    // instant de naissance (ms)
const P0 = CP.PLANCHER;                      // 1,68e-9

/* Le monde : les logs de chaque courbe, poses au bloc de leur minute. */
const LOGS = [];
/* A : entree minute 1 au plancher ; +50 % a T+15 ; graduation a T+30 */
LOGS.push({ bloc: B0 + 1 * BPM, l: achatPrix(COURBE_A, B0 + 1 * BPM, 0, P0, 10) });
LOGS.push({ bloc: B0 + 15 * BPM, l: achatPrix(COURBE_A, B0 + 15 * BPM, 0, P0 * 1.5, 20) });
LOGS.push({ bloc: B0 + 30 * BPM, l: logGrad(COURBE_A, B0 + 30 * BPM, 0) });
/* B : entree minute 1 un peu au-dessus du plancher ; effondrement a T+15 */
LOGS.push({ bloc: B0 + 1 * BPM, l: achatPrix(COURBE_B, B0 + 1 * BPM, 0, P0 * 1.2, 10) });
LOGS.push({ bloc: B0 + 15 * BPM, l: ventePrix(COURBE_B, B0 + 15 * BPM, 0, P0 * 0.5, 50) });

function stubR() {
  return {
    pointeBloc: B0,
    nouvellePasse() {},
    async pointe() { return { pointe: this.pointeBloc + 5 }; },      // pas() fait pointe-5
    async appel(m, params) {
      const f = params[0], de = parseInt(f.fromBlock, 16), a = parseInt(f.toBlock, 16);
      const result = LOGS.filter((x) => x.bloc >= de && x.bloc <= a).map((x) => x.l);
      return { result };
    },
    jour() { return { http: this.called || 0, octets: 0 }; },
  };
}

async function scenario() {
  console.log('-- l observateur de courbe precoce : observation stricte --');
  let now = T0;
  const R = stubR();
  const carnet = { fraiches: (maxMin) => {
    /* le carnet connait les deux courbes des leur naissance (ici) : en prod il
       les connait au T+2 ; le buffer accumule quand meme la minute 1 car la
       fenetre de getLogs couvre les blocs anterieurs. */
    const lim = maxMin * 60e3;
    return [[COURBE_A, 'A'], [COURBE_B, 'B']]
      .filter(() => true)
      .map(([c]) => ({ jeton: '0xtok' + c.slice(2, 6), courbe: c, bloc: B0, dev: DEV, t: T0 }))
      .filter((f) => now - f.t < lim);
  } };
  const OBS = CP.cree({ R, carnet, horloge: () => now, dedie: true, reference: () => ({ n: 150, partMontes: 35 }) });

  /* on avance le temps et la pointe minute par minute jusqu'a T+65 */
  for (let min = 1; min <= 65; min++) {
    now = T0 + min * 60000;
    R.pointeBloc = B0 + Math.round(min * BPM);
    await OBS.pas();
  }
  const v = OBS.observe();
  const L = Object.fromEntries(v.lignes.map((x) => [x.cle, x]));
  console.log('   lignes : ' + v.lignes.map((x) => x.cle + ' n=' + x.n + ' moy=' + x.moyenne).join(' | '));

  /* 1. la fenetre precoce a 15 min : A (+50-6=+44 >= 20) et B (effondre) jugees */
  const ew15 = L['curve: early window @15m'];
  ok(ew15 && ew15.n === 2, 'early window @15m : les deux courbes jugees (n=' + (ew15 && ew15.n) + ')');
  ok(ew15 && ew15.montes === 1, 'une seule monte (A +44 %), l autre non (B effondre) (' + (ew15 && ew15.montes) + ')');
  ok(ew15 && ew15.effondres === 1, 'la mort de B est COMPTEE, pas ignoree (' + (ew15 && ew15.effondres) + ')');
  /* 2. le net de 6 % : a 5 min AUCUN prix n'a bouge (seule l'entree existe),
        donc le rendement doit etre exactement -6 % (le seul aller-retour). */
  const ew5 = L['curve: early window @5m'];
  ok(ew5 && Math.abs(ew5.moyenne - (-6)) < 0.6,
     'a 5 min sans mouvement : -6 % net, l aller-retour de courbe (moyenne ' + (ew5 && ew5.moyenne) + ')');
  /* et a 15 min, A a fait +50 % brut -> +44 % net, visible dans le detail. */
  ok(ew15 && ew15.montes === 1 && Math.abs(ew15.moyenne - (44 + (-0.7 / 1.2 * 100 - 6)) / 2) < 2,
     'a 15 min : A +44 % net et B effondre, moyenne nette coherente (' + (ew15 && ew15.moyenne) + ')');
  /* 3. la graduation precoce : A gradue a T+30 (<= 60 min) -> sa propre ligne */
  const ge30 = L['curve: graduated early @30m'];
  ok(ge30 && ge30.n >= 1, 'curve: graduated early @30m contient A (gradue a 30 min) (n=' + (ge30 && ge30.n) + ')');
  ok(!L['curve: graduated early @30m'] || ge30.n <= 1, 'B n est PAS dans la ligne graduation (elle n a pas gradue)');
  /* 4. refus de conclure sous 12 obs : « too few observations », jamais un verdict
        contre la reference (ici n=2). La borne des 100 est verifiee a part. */
  ok(ew15 && /too few observations to conclude \(2\/12\)/.test(ew15.verdict),
     'sous 12 obs : « too few observations », jamais « beats/below reference » (' + (ew15 && ew15.verdict) + ')');
  ok(ew15 && ew15.partMontes === null, 'et la part de montees reste nulle sous 12 obs (pas de chiffre trompeur)');
  /* 5. INERTIE : le module n a AUCUN chemin vers un achat. */
  ok(typeof OBS.pas === 'function' && OBS.observe && !OBS.achete && !OBS.acheter && !OBS.signal,
     'le module n expose NI achat NI signal : aucun chemin vers le tour');
  ok(v.mode === 'observe' && v.note.indexOf('no trade') >= 0 && v.note.indexOf('no buy gate') >= 0,
     'la vue le dit en clair : paper only, no trade, no buy gate');
  /* 6. sante : les deux courbes ont ete suivies et jugees */
  ok(v.sante.jugees >= 2, 'des courbes ont ete jugees (' + v.sante.jugees + ')');
}

(async () => {
  await scenario();
  console.log(rates ? '\nRATES : ' + rates + '/' + n : '\n' + n + ' verifications OK');
  process.exit(rates ? 1 : 0);
})();
