'use strict';
/*
 * LA MAISON PERD-ELLE SUR UN PARI QU'ELLE PROPOSE ?
 *
 * `cotes.test.js` verifie que le lot est COHERENT : la marge y est, le favori
 * paie moins, les six marches ne se contredisent pas. Rien de tout ca ne dit
 * si un pari precis est gagnant pour le PARIEUR a la longue — et c'est
 * pourtant la seule question qui se paie en argent.
 *
 * Trois fuites ont ete trouvees en la posant. Chacune a son essai ici.
 *
 * ---- 1. LE SCORE EXACT ----
 * Le modele posait deux lois de Poisson independantes, qui sous-estiment
 * lourdement le 0-0. Mesure sur nos propres cotes, avant correction :
 *
 *     PSG v Angers        0-0 a 40,80   retour du parieur  109,8 %
 *     Barcelona v Alaves  0-0 a 45,63   retour du parieur  114,4 %
 *     Bayern v Augsburg   0-0 a 47,36   retour du parieur  115,3 %
 *
 * Sur toute affiche a gros favori, le 0-0 etait un pari que la maison perd,
 * et de dix a quinze pour cent.
 *
 * ---- 2. LE FAVORI ----
 * La methode de l'exposant repartit la marge sur les outsiders — « comme
 * dans un vrai livre ». Elle laissait donc le favori a 2,2 points de
 * probabilite du basculement, sur un modele qui ignore les blessures et la
 * forme. Le livre affichait 10 % de marge et n'en portait que 2,6 la ou tout
 * l'argent se pose.
 *
 * ---- 3. CE QU'ON NE SAIT PAS ----
 * La correction de Dixon-Coles demande un `rho`. On prend -0,13, la valeur
 * publiee, mais on ne PARIE pas dessus : le garde-fou du score exact est
 * calcule contre le rho le plus defavorable de toute la plage plausible.
 * Un essai qui ne verifierait qu'a rho = -0,13 validerait un pari sur notre
 * propre hypothese.
 */
const assert = require('assert');
const paris = require('./paris');
const cotes = require('./cotes');

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('  ok   ' + m); };

cotes.chargeNotes();

/* Des affiches a gros favori : c'est la que tout se joue, et c'est de celles-la
   que le proprietaire du jeu parle — « PSG, Barcelone, Real qui gagnent tout
   le temps ». */
const AFFICHES = [
  ['paris saint germain', 'angers'],
  ['real madrid', 'malaga'],
  ['barcelona', 'alaves'],
  ['bayern munich', 'augsburg'],
  ['arsenal', 'bolton'],
  ['manchester city', 'birmingham'],
];

function scoresA(lh, la, rho) {
  const g = cotes.grilleDesScores(lh, la, rho);
  const e = {};
  for (const s of paris.SCORES) e[s] = 0;
  for (let i = 0; i < g.length; i++)
    for (let j = 0; j < g[i].length; j++) {
      const c = i + '-' + j;
      if (e[c] !== undefined) e[c] += g[i][j]; else e.autre += g[i][j];
    }
  return e;
}

console.log('\n-- 1. aucun score exact n est gagnant pour le parieur --');
let pireScore = 0, ouScore = '';
for (const [d, e] of AFFICHES) {
  const p = cotes.probabilites('foot', d, e);
  const L = cotes.ajusteButs(p['1'], p.N, p['2']);
  const m = cotes.marchesDe('foot', d, e, undefined, null);
  if (!m.score) continue;
  for (const rho of cotes.RHO_PLAGE) {
    const vrai = scoresA(L.lh, L.la, rho);
    for (const s of paris.SCORES) {
      const c = m.score.cotes[s];
      if (!c) continue;
      const retour = vrai[s] * c;
      if (retour > pireScore) { pireScore = retour; ouScore = `${d} v ${e}, ${s} a ${c}, rho ${rho}`; }
    }
  }
}
ok(pireScore < 1,
   'sur toute la plage de rho, le meilleur score exact rend ' + (100 * pireScore).toFixed(1)
   + ' % au parieur (' + ouScore + ')');
ok(pireScore < 0.97,
   'et il garde une reserve : sous 97 %, pas seulement sous 100');

console.log('\n-- 2. le favori porte une vraie marge --');
let mince = 99, ouMince = '';
for (const [d, e] of AFFICHES) {
  const p = cotes.probabilites('foot', d, e);
  const c = cotes.cotesDe('foot', d, e);
  const coussin = 100 * (1 / c['1'] - p['1']);
  if (coussin < mince) { mince = coussin; ouMince = `${d} v ${e} a ${c['1']}`; }
}
ok(mince >= 4,
   'le favori le moins protege laisse ' + mince.toFixed(1)
   + ' points de probabilite avant de basculer (' + ouMince + ') — il en laissait 2,2');

console.log('\n-- 3. le rabot ne prend jamais plus que le prix ne permet --');
/* A 94,7 % — un ecart banal en NBA — exiger 6 % demanderait une probabilite
   implicite de 100,4 %. La premiere version tombait sous la cote minimale et
   le match entier etait ECARTE. */
cotes.poseNote('nba', 'ECRASANT', 1500);
cotes.poseNote('nba', 'FAIBLE', 1100);
const nba = cotes.cotable('nba', 'ECRASANT', 'FAIBLE');
ok(nba.cotable,
   'un match de NBA a 400 points d ecart reste cote (favori '
   + (100 * nba.proba).toFixed(1) + ' %, cote ' + nba.plusCourte + ')');
const rab = cotes.raboteIssues({ a: 1.20 }, { a: 0.99 }, ['a']);
ok(rab.a >= paris.COTE_MIN, 'et meme a 99 % le rabot rend une cote affichable (' + rab.a + ')');

console.log('\n-- 4. aucune affiche REELLE n est perdue --');
/* Le balayage synthetique de `cotes.test.js` va a +-1200 points et ecarte donc
   beaucoup ; ca ne dit rien du catalogue reel. Ici on prend les equipes du
   fichier de forces et on les croise toutes. */
const eq = Object.keys(cotes.notes()).filter((k) => k.startsWith('foot:')).map((k) => k.slice(5));
let paires = 0, perdues = 0, exemple = '';
for (let i = 0; i < eq.length; i++) {
  for (let j = 0; j < eq.length; j++) {
    if (i === j) continue;
    paires++;
    if (!cotes.cotable('foot', eq[i], eq[j]).cotable) {
      perdues++; if (!exemple) exemple = eq[i] + ' v ' + eq[j];
    }
  }
}
ok(perdues === 0,
   'les ' + paires + ' paires possibles entre equipes connues sont toutes cotables'
   + (perdues ? ' — sauf ' + perdues + ', par exemple ' + exemple : ''));

console.log('\n-- 5. le garde-fou du score ne parie pas sur notre hypothese --');
const L0 = (() => { const p = cotes.probabilites('foot', 'barcelona', 'alaves');
                    return cotes.ajusteButs(p['1'], p.N, p['2']); })();
const prudent = cotes.scoresPrudents(L0.lh, L0.la);
const auModele = scoresA(L0.lh, L0.la, cotes.RHO);
let plusHaut = 0;
for (const s of paris.SCORES) if (prudent[s] >= auModele[s] - 1e-12) plusHaut++;
ok(plusHaut === paris.SCORES.length,
   'la borne prudente est, pour CHAQUE score, au moins egale a celle du modele ('
   + plusHaut + '/' + paris.SCORES.length + ')');
ok(cotes.RHO_PLAGE.indexOf(0) >= 0,
   'et la plage contient rho = 0 — le cas ou la correction serait entierement fausse');

console.log('\ncotes_risque.test.js : ' + n + ' verifications OK');
