'use strict';
/*
 * Tests des deux jeux contre la banque.
 *
 * Le bloc decisif est le dernier : on simule des centaines de milliers de mains
 * et on mesure le taux de retour reel. Un bareme mal calcule ne se voit pas sur
 * une main, il se voit sur la courbe — et il coute de l'argent reel a la
 * maison, tous les jours, sans jamais lever d'exception.
 */

const C = require('./casino');
const P = require('./poker');

let pass = 0, fail = 0;
const c = (s) => s.split(' ').map(P.parseCard);
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log(`  ECHEC ${label}: obtenu ${a}, attendu ${b}`); }
}
function ok(label, cond) { eq(label, !!cond, true); }
function bat(label, x, y) {
  if (C.eval3(c(x)) > C.eval3(c(y))) pass++;
  else { fail++; console.log(`  ECHEC ${label}: "${x}" devrait battre "${y}"`); }
}
function classe(label, main, attendu) {
  const n = C.name3(C.eval3(c(main)));
  if (n === attendu) pass++;
  else { fail++; console.log(`  ECHEC ${label}: "${main}" -> ${n}, attendu ${attendu}`); }
}

console.log('--- main de trois cartes ---');
classe('quinte flush', 'Qh Jh Th', 'Straight flush');
classe('quinte flush basse', '3h 2h Ah', 'Straight flush');
classe('brelan', '9h 9d 9c', 'Three of a kind');
classe('quinte', '9h 8d 7c', 'Straight');
classe('quinte a l as bas', 'Ah 2d 3c', 'Straight');
classe('couleur', 'Ah Jh 5h', 'Flush');
classe('paire', 'Qh Qd 9c', 'Pair');
classe('hauteur', 'Ah Jd 9c', 'High card');

console.log('--- l ordre a trois cartes n est PAS celui du poker ---');
// 720 quintes contre 1096 couleurs : la quinte est plus rare, donc elle prime.
bat('la quinte bat la couleur', '9h 8d 7c', 'Ah Jh 5h');
bat('le brelan bat la quinte', '5h 5d 5c', 'Ah Kd Qc');   // A-K-Q = quinte
bat('la quinte flush bat le brelan', '5h 4h 3h', 'Ah Ad Ac');
bat('la paire bat la hauteur', '2h 2d 3c', 'Ah Kd 9c');
classe('A-K-Q est une quinte, pas une hauteur', 'Ah Kd Qc', 'Straight');
bat('couleur : departage par la carte haute', 'Ah 9h 5h', 'Kh 9h 5h');
bat('quinte au 9 bat la roue', '9h 8d 7c', 'Ah 2d 3c');
bat('brelan d as bat brelan de rois', 'Ah Ad Ac', 'Kh Kd Kc');
eq('meme main, couleurs differentes', C.eval3(c('Ah Kd 9c')), C.eval3(c('As Kh 9d')));

console.log('--- qualification ---');
ok('Dame-haut qualifie le croupier', C.eval3(c('Qh 7d 4c')) >= C.T3_QUALIF);
ok('la plus faible Dame qualifie', C.eval3(c('Qh 3d 2c')) >= C.T3_QUALIF);
ok('Valet-haut ne qualifie pas', C.eval3(c('Jh 9d 7c')) < C.T3_QUALIF);
ok('le meilleur Valet ne qualifie pas', C.eval3(c('Jh Td 8c')) < C.T3_QUALIF);
ok('une paire qualifie', C.eval3(c('2h 2d 5c')) >= C.T3_QUALIF);
ok('paire de 4 qualifie au Hold em', C.holdemQualifie(P.evaluate(c('4h 4d 9c Ks 2h'))));
ok('paire de 3 ne qualifie pas', !C.holdemQualifie(P.evaluate(c('3h 3d 9c Ks 2h'))));
ok('hauteur d as ne qualifie pas', !C.holdemQualifie(P.evaluate(c('Ah Kd 9c 5s 2h'))));
ok('deux paires qualifient', C.holdemQualifie(P.evaluate(c('3h 3d 9c 9s 2h'))));

console.log('--- melange ---');
{
  const a = C.shoe('s', 'c', 1), b = C.shoe('s', 'c', 1), d = C.shoe('s', 'c', 2);
  eq('deterministe', a.join(), b.join());
  eq('52 cartes', a.length, 52);
  eq('aucun doublon', new Set(a).size, 52);
  ok('main suivante differente', a.join() !== d.join());
  const pos = new Array(52).fill(0);
  for (let i = 0; i < 20000; i++) pos[C.shoe('s', 'c', i)[0]]++;
  const mn = Math.min(...pos), mx = Math.max(...pos);
  ok(`uniformite (min ${mn}, max ${mx}, attendu ~385)`, mn > 280 && mx < 490);
}

console.log('--- Three Card : les cas qui paient ---');
{
  // se coucher perd l'Ante, mais le Pair Plus reste paye sur la seule main
  let n = 0, avecPP = 0, sansPP = 0;
  for (let i = 0; i < 4000; i++) {
    const r = C.threeCard({ serverSeed: 's', clientSeed: 'c', nonce: i, ante: 10, pairPlus: 10, play: false });
    if (r.payout > 0) { avecPP++; n += r.payout; }
    const r2 = C.threeCard({ serverSeed: 's', clientSeed: 'c', nonce: i, ante: 10, pairPlus: 0, play: false });
    if (r2.payout > 0) sansPP++;
  }
  ok(`le Pair Plus paie meme couche (${avecPP} fois sur 4000)`, avecPP > 800);
  eq('sans Pair Plus, se coucher ne rapporte rien', sansPP, 0);
}
{
  // croupier non qualifie : Ante paye 1:1, la mise Play est rendue
  let vus = 0;
  for (let i = 0; i < 20000 && vus < 1; i++) {
    const r = C.threeCard({ serverSeed: 'q', clientSeed: 'c', nonce: i, ante: 10, play: true });
    if (r.outcome === 'dealer_not_qualified') {
      const bonus = r.detail.filter((d) => d.bet === 'anteBonus').reduce((s, d) => s + 10 * d.x, 0);
      eq('non qualifie : 10 gagnes + 10 rendus (+ bonus)', r.payout, 30 + bonus);
      vus++;
    }
  }
  eq('un cas de non-qualification rencontre', vus, 1);
}

console.log('--- Casino Hold em : les cas qui paient ---');
{
  const d = C.holdemDeal({ serverSeed: 'h', clientSeed: 'c', nonce: 1 });
  eq('2 cartes au joueur', d.player.length, 2);
  eq('2 au croupier', d.dealer.length, 2);
  eq('flop de 3', d.board.length, 3);
  eq('9 cartes distinctes tirees', new Set(d.player.concat(d.dealer, d.board, d.rest)).size, 9);
  const f = C.holdemResolve({ deal: d, ante: 10, call: false });
  eq('se coucher ne rapporte rien', f.payout, 0);
  eq('se coucher ne montre pas le croupier', f.dealer, null);
  const s = C.holdemResolve({ deal: d, ante: 10, call: true });
  eq('suivre revele les 5 cartes', s.board.length, 5);
  eq('suivre revele le croupier', s.dealer.length, 2);
}
{
  // le bonus AA se resout meme quand le joueur se couche ensuite
  let paye = 0;
  for (let i = 0; i < 6000; i++) {
    const d = C.holdemDeal({ serverSeed: 'aa', clientSeed: 'c', nonce: i });
    const r = C.holdemResolve({ deal: d, ante: 10, aa: 10, call: false });
    if (r.payout > 0) paye++;
  }
  ok(`le bonus AA paie meme couche (${paye} fois sur 6000)`, paye > 100);
}

console.log('--- taux de retour : 300 000 mains de chaque jeu ---');
{
  // Strategie du joueur, volontairement la strategie OPTIMALE connue : c'est
  // elle qui donne l'avantage minimum de la maison. Si les chiffres tiennent
  // face a un joueur parfait, ils tiennent face a tout le monde.
  const ANTE = 100, N = 300000;

  // Three Card : on suit avec Dame-6-4 ou mieux, on se couche en dessous.
  const SEUIL3 = C.eval3([10, 4 + 13, 2 + 26]);   // Q-6-4
  let mise3 = 0, rendu3 = 0, misePP = 0, renduPP = 0;
  for (let i = 0; i < N; i++) {
    const dry = C.threeCard({ serverSeed: 'rtp3', clientSeed: 'c', nonce: i, ante: ANTE, play: false });
    const suit = dry.playerScore >= SEUIL3;
    const r = C.threeCard({ serverSeed: 'rtp3', clientSeed: 'c', nonce: i, ante: ANTE,
                            pairPlus: ANTE, play: suit });
    mise3 += ANTE + (suit ? ANTE : 0);
    misePP += ANTE;
    // on separe ce que rapporte le Pair Plus du reste
    const pp = C.threeCard({ serverSeed: 'rtp3', clientSeed: 'c', nonce: i, ante: ANTE,
                             pairPlus: ANTE, play: false }).payout
             - C.threeCard({ serverSeed: 'rtp3', clientSeed: 'c', nonce: i, ante: ANTE,
                             pairPlus: 0, play: false }).payout;
    renduPP += pp;
    rendu3 += r.payout - pp;
  }
  const rtp3 = rendu3 / mise3 * 100, rtpPP = renduPP / misePP * 100;
  console.log(`    Three Card ante+play : retour ${rtp3.toFixed(2)} % (avantage maison ${(100 - rtp3).toFixed(2)} %)`);
  console.log(`    Three Card pair plus : retour ${rtpPP.toFixed(2)} % (avantage maison ${(100 - rtpPP).toFixed(2)} %)`);
  ok(`ante+play entre 94 et 99 % SANS commission (${rtp3.toFixed(2)})`, rtp3 > 94 && rtp3 < 99);
  ok(`pair plus entre 92 et 99 % SANS commission (${rtpPP.toFixed(2)})`, rtpPP > 92 && rtpPP < 99);

  // Casino Hold'em : la strategie optimale se couche tres rarement (~18 %).
  // Approximation solide : on se couche seulement avec une hauteur faible qui
  // ne touche pas le flop et sans tirage evident.
  let miseH = 0, renduH = 0, couches = 0;
  for (let i = 0; i < N; i++) {
    const d = C.holdemDeal({ serverSeed: 'rtph', clientSeed: 'c', nonce: i });
    const sc = P.evaluate(d.player.concat(d.board));
    const cat = C.catP(sc);
    let suit = cat >= P.CAT.PAIR;
    if (!suit) {
      // Hauteur seule. La strategie optimale ne se couche que sur environ 18 %
      // des mains : on suit encore avec une grosse carte, deux cartes assorties
      // (tirage couleur) ou deux cartes proches (tirage quinte).
      const r = d.player.map((x) => x % 13).sort((a, b) => b - a);
      const assorties = ((d.player[0] / 13) | 0) === ((d.player[1] / 13) | 0);
      const proches = r[0] - r[1] <= 3;
      const couleurs = d.player.concat(d.board).map((x) => (x / 13) | 0);
      const tirageCouleur = [0, 1, 2, 3].some((s2) => couleurs.filter((x) => x === s2).length >= 4);
      suit = r[0] >= 9 || assorties || proches || tirageCouleur;
    }
    const r = C.holdemResolve({ deal: d, ante: ANTE, call: suit });
    miseH += ANTE + (suit ? ANTE * 2 : 0);
    renduH += r.payout;
    if (!suit) couches++;
  }
  const rtpH = renduH / miseH * 100;
  console.log(`    Casino Hold'em       : retour ${rtpH.toFixed(2)} % (avantage maison ${(100 - rtpH).toFixed(2)} %), ${(couches / N * 100).toFixed(1)} % de mains couchees`);
  ok(`Hold'em entre 96 et 99,5 % (${rtpH.toFixed(2)})`, rtpH > 96 && rtpH < 99.5);

  // Le bonus AA separement.
  let miseAA = 0, renduAA = 0;
  for (let i = 0; i < N; i++) {
    const d = C.holdemDeal({ serverSeed: 'rtpaa', clientSeed: 'c', nonce: i });
    const avec = C.holdemResolve({ deal: d, ante: ANTE, aa: ANTE, call: false }).payout;
    miseAA += ANTE; renduAA += avec;
  }
  const rtpAA = renduAA / miseAA * 100;
  console.log(`    bonus AA             : retour ${rtpAA.toFixed(2)} % (avantage maison ${(100 - rtpAA).toFixed(2)} %)`);
  ok(`bonus AA entre 88 et 98 % (${rtpAA.toFixed(2)})`, rtpAA > 88 && rtpAA < 98);
}

console.log('--- retour reel avec la commission de la maison ---');
{
  // La commission est le seul levier qui descend le retour a 80 % sans rendre
  // les paiements incomprehensibles. On verifie qu'elle tape bien la cible, et
  // surtout qu'elle ne touche JAMAIS une mise rendue.
  const cfg = require('./config');
  const FEE = cfg.CASINO_WIN_FEE_BPS;
  const ANTE = 100, N = 120000;
  const SEUIL3 = C.eval3([10, 4 + 13, 2 + 26]);
  let mise = 0, rendu = 0, commissions = 0;

  for (let i = 0; i < N; i++) {
    const dry = C.threeCard({ serverSeed: 'fee3', clientSeed: 'c', nonce: i, ante: ANTE, play: false });
    const suit = dry.playerScore >= SEUIL3;
    const r = C.threeCard({ serverSeed: 'fee3', clientSeed: 'c', nonce: i, ante: ANTE,
                            pairPlus: ANTE, play: suit, feeBps: FEE });
    mise += ANTE + (suit ? ANTE : 0) + ANTE;
    rendu += r.payout; commissions += r.fee || 0;
  }
  for (let i = 0; i < N; i++) {
    const d = C.holdemDeal({ serverSeed: 'feeh', clientSeed: 'c', nonce: i });
    const sc = P.evaluate(d.player.concat(d.board)), cat = C.catP(sc);
    let suit = cat >= P.CAT.PAIR;
    if (!suit) {
      const rr = d.player.map((x) => x % 13).sort((a, b) => b - a);
      const ass = ((d.player[0] / 13) | 0) === ((d.player[1] / 13) | 0);
      suit = rr[0] >= 9 || ass || rr[0] - rr[1] <= 3;
    }
    const r = C.holdemResolve({ deal: d, ante: ANTE, aa: ANTE, call: suit, feeBps: FEE });
    mise += ANTE + (suit ? ANTE * 2 : 0) + ANTE;
    rendu += r.payout; commissions += r.fee || 0;
  }
  const rtp = rendu / mise * 100;
  console.log(`    commission ${(FEE / 100).toFixed(1)} % du gain net -> retour ${rtp.toFixed(2)} %`);
  console.log(`    (avantage maison ${(100 - rtp).toFixed(2)} %, ${commissions} preleves sur ${mise} mises)`);
  ok(`le retour vise est atteint a 1,5 point pres (${rtp.toFixed(2)})`, Math.abs(rtp - 92) < 1.5);

  // Une egalite rend exactement la mise : la commission ne doit pas mordre.
  eq('commission nulle sur une mise rendue', C.commission(300, 300, FEE), { payout: 300, fee: 0 });
  eq('commission nulle sur une perte', C.commission(300, 0, FEE), { payout: 0, fee: 0 });
  eq('commission sur 100 de gain net', C.commission(300, 400, 1350), { payout: 387, fee: 13 });
}

console.log('--- frequences des mains a trois cartes ---');
{
  // Verification contre les probabilites exactes de la combinatoire :
  // sur les 22 100 mains possibles, 48 quintes flush, 52 brelans, 720 quintes,
  // 1096 couleurs, 3744 paires.
  const attendu = { 'Straight flush': 48, 'Three of a kind': 52, 'Straight': 720,
                    'Flush': 1096, 'Pair': 3744, 'High card': 16440 };
  const compte = {};
  for (let a = 0; a < 52; a++)
    for (let b = a + 1; b < 52; b++)
      for (let d = b + 1; d < 52; d++) {
        const n = C.name3(C.eval3([a, b, d]));
        compte[n] = (compte[n] || 0) + 1;
      }
  let total = 0;
  for (const k of Object.keys(attendu)) {
    eq(`${k} : ${attendu[k]} mains`, compte[k] || 0, attendu[k]);
    total += compte[k] || 0;
  }
  eq('22 100 mains au total', total, 22100);
}

console.log(`\n${pass} tests reussis, ${fail} echecs`);
process.exit(fail ? 1 : 0);
