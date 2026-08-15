'use strict';
/*
 * AUDIT du blackjack, ecrit apres un signalement : un joueur gagnerait a tous
 * les coups. On ne cherche pas a relire le code en esperant voir l'erreur — on
 * MESURE, avec plusieurs facons de jouer, y compris celles qui essaient
 * activement de tricher.
 *
 * Un taux de retour au-dessus de 100 % est la signature d'une faille.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const ADR = '0x5555555555555555555555555555555555555555';
const sol = (g) => Number(g.balanceStr(ADR));
function neuf(credit = 10000000) {
  const g = new Game();
  g._p(ADR).balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
  return g;
}

/** Valeur d'une main, meme regle que le moteur. */
/* ---- LE SERVEUR REND DES CARTES, PAS DES RANGS ----
   Depuis que le paquet porte ses enseignes, une carte vaut 0..51. Les aides
   ci-dessous raisonnent en RANGS (« r >= 9 donc c'est une figure ») : leur
   passer une carte brute ferait compter dix a presque toutes, la strategie
   simulee deviendrait absurde et le rendement mesure s'effondrerait. Ce
   fichier a effectivement chute a 86,8 % avant cette conversion — et c'etait
   lui qui avait tort, pas le moteur. */
const rang = (c) => ((Number(c) || 0) % 13 + 13) % 13;
const rangs = (cs) => (cs || []).map(rang);

function val(ranks) {
  let s = 0, as = 0;
  for (const r of ranks) { if (r === 0) { s += 11; as++; } else if (r >= 9) s += 10; else s += r + 1; }
  while (s > 21 && as) { s -= 10; as--; }
  return s;
}
const dur = (ranks) => { // vrai si la main n'a pas d'As compte 11
  let s = 0, as = 0;
  for (const r of ranks) { if (r === 0) { s += 11; as++; } else if (r >= 9) s += 10; else s += r + 1; }
  while (s > 21 && as) { s -= 10; as--; }
  return as === 0;
};

/** Strategie de base simplifiee, celle d'un joueur serieux. */
function decide(pc, upcard) {
  const v = val(pc);
  const d = upcard === 0 ? 11 : upcard >= 9 ? 10 : upcard + 1;
  if (v >= 17) return 'stand';
  if (!dur(pc)) return v >= 19 ? 'stand' : 'hit';     // main souple
  if (v >= 13 && d <= 6) return 'stand';
  if (v === 12 && d >= 4 && d <= 6) return 'stand';
  return 'hit';
}

function joue({ parties, mise, strategie, triche }) {
  const g = neuf();
  const depart = sol(g);
  let engage = 0;
  for (let i = 0; i < parties; i++) {
    if (sol(g) < mise * 3) break;
    let st;
    try { st = g.bjBet(ADR, mise); } catch (e) { break; }
    engage += mise;
    while (st.stage === 'player') {
      // le tricheur change sa graine AVANT chaque tirage
      if (triche) g.setClientSeed(ADR, 'triche-' + i + '-' + st.player.cards.length);
      /* On convertit ICI, au seul endroit ou les cartes du serveur entrent
         dans les aides : elles raisonnent en rangs. */
      const a = strategie(rangs(st.player.cards), rang(st.dealer.cards[0]), st);
      if (a === 'double' && st.canDouble) { st = g.bjDouble(ADR); engage += mise; }
      else if (a === 'hit') st = g.bjHit(ADR);
      else st = g.bjStand(ADR);
    }
  }
  return { retour: (sol(g) - depart + engage) / engage, engage, solde: sol(g) - depart };
}

console.log('  taux de retour du blackjack (100 % = la maison ne gagne rien) :');
const cas = [
  ['strategie de base    ', (pc, up) => decide(pc, up), false],
  ['toujours rester      ', () => 'stand', false],
  ['tirer jusqu a 17     ', (pc) => (val(pc) < 17 ? 'hit' : 'stand'), false],
  ['double des que permis', (pc, up, st) => (st.canDouble ? 'double' : decide(pc, up)), false],
  ['base + graine changee', (pc, up) => decide(pc, up), true],
];
const resultats = [];
for (const [nom, strat, triche] of cas) {
  const r = joue({ parties: 120000, mise: 10, strategie: strat, triche });
  console.log('    %s : %s %%  (%s mise)', nom, (100 * r.retour).toFixed(2), r.engage);
  resultats.push([nom, r.retour]);
}

/* Le seuil. Un blackjack correct rend 99,5 % en strategie de base ; l'ecart-type
   sur 120 000 mains vaut environ 0,3 %. Au-dessus de 101 % il y a une faille,
   pas de la chance. */
for (const [nom, r] of resultats) {
  ok(r < 1.01, `${nom.trim()} : retour ${(100 * r).toFixed(2)} % — AU-DESSUS DE 100 %, faille probable`);
}
// et la strategie de base doit rendre a peu pres ce qu'un blackjack rend
const base = resultats[0][1];
ok(base > 0.95 && base < 1.005, `strategie de base plausible (${(100 * base).toFixed(2)} %)`);
/* Changer de graine a chaque tirage ne doit RIEN rapporter. Les deux series
   sont des echantillons INDEPENDANTS : chacune porte environ 0,3 % d'incertitude
   sur 120 000 mains, leur difference environ 0,45 %. Le seuil est donc a trois
   ecarts-types, pas a la precision qu'on aimerait avoir. */
const ecart = Math.abs(resultats[4][1] - base);
console.log('    ecart du tricheur : %s point(s) de pourcentage', (100 * ecart).toFixed(2));
ok(ecart < 0.014, `changer de graine ne change pas le retour (ecart ${(100 * ecart).toFixed(2)} %)`);
ok(resultats[4][1] < 1.0, 'le tricheur ne passe pas au-dessus de 100 %');

// ---------------------------------------------------- gestes interdits
{
  /* PIEGE : une main sur dix environ est un blackjack naturel et se resout des
     la donne. Un simple « if (stage === 'player') » sautait alors CINQ
     controles en silence — le compteur de verifications passait de 19 a 14 sans
     que rien ne le signale. On redonne jusqu'a obtenir une main qui dure. */
  const enCours = (g, mise) => {
    for (let i = 0; i < 80; i++) { const st = g.bjBet(ADR, mise); if (st.stage === 'player') return st; }
    throw new Error('aucune main en cours apres 80 donnes');
  };

  const g = neuf(100000);
  enCours(g, 10);
  assert.throws(() => g.bjBet(ADR, 10), /in progress/); n++;
  g.bjDouble(ADR);
  assert.throws(() => g.bjDouble(ADR), /cannot double/); n++;
  assert.throws(() => g.bjHit(ADR), /no active hand/); n++;
  assert.throws(() => g.bjStand(ADR), /no active hand/); n++;

  /* Il a 15, il mise 10, il lui reste 5 : doubler en demande 10. */
  let double = false;
  for (let i = 0; i < 80 && !double; i++) {
    const pauvre = neuf(0);
    pauvre._p(ADR).balance = ethers.utils.parseUnits('15', cfg.DECIMALS);
    if (pauvre.bjBet(ADR, 10).stage !== 'player') continue;
    assert.throws(() => pauvre.bjDouble(ADR), /not enough/); n++; double = true;
  }
  ok(double, 'le joueur sans les moyens ne peut pas doubler');
  assert.throws(() => neuf(1000).bjBet(ADR, cfg.BJ_MAX_BET + 1), /max bet/); n++;
  assert.throws(() => neuf(1000).bjBet(ADR, 0), /too small/); n++;
  assert.throws(() => neuf(1000).bjBet(ADR, -50), /too small/); n++;
}

// ------------------------------------- la carte cachee ne doit pas fuiter
{
  const g = neuf();
  for (let i = 0; i < 500; i++) {
    const st = g.bjBet(ADR, 10);
    if (st.stage !== 'player') continue;
    ok(st.dealer.cards.length === 1, 'une seule carte de croupier visible');
    ok(st.dealer.hidden === true, 'la seconde est annoncee cachee');
    ok(JSON.stringify(st).indexOf('"dc"') < 0, 'la main complete du croupier n est pas envoyee');
    g.bjStand(ADR);
    break;
  }
}

console.log(`bj_audit.test.js : ${n} verifications OK`);
