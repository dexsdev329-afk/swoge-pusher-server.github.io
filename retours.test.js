'use strict';
/*
 * Les taux de retour, verrouilles.
 *
 * Un retour annonce est une promesse faite au joueur. Il vivait jusqu'ici dans
 * un commentaire — et un commentaire ne se casse pas quand quelqu'un touche a
 * une ligne du bareme. Ce fichier le mesure a partir des chiffres reels de la
 * configuration, et refuse deux choses :
 *
 *   • qu'un jeu descende sous un plancher. Sous ce plancher, le joueur qui
 *     compare n'en conclut pas que ce jeu-la est dur, mais que la maison n'est
 *     pas honnete — et cette impression contamine tout le catalogue.
 *   • qu'un jeu passe au-dessus de 100 %. Ce n'est plus un jeu, c'est un
 *     robinet ouvert sur le coffre, et personne ne s'en apercoit avant que le
 *     coffre soit vide.
 */
const assert = require('assert');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, `${m} (${a} vs ${b})`); n++; };
const eqNum = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };

/* Le plancher. Il n'est pas arbitraire : les machines physiques les plus dures
   tournent autour de 85 %, et un jeu en ligne en dessous se remarque. */
const PLANCHER = 88;

// ============================================= SWOGE Smash
{
  let poids = 0, somme = 0, rien = 0;
  for (const [mult, w] of cfg.SPIN_PRIZES) {
    poids += w; somme += mult * w;
    if (mult === 0) rien += w;
  }
  assert.strictEqual(poids, cfg.SPIN_TOTAL,
    'les poids du Smash doivent faire exactement SPIN_TOTAL, sinon le retour ' +
    'annonce est faux'); n++;

  const retour = somme / cfg.SPIN_TOTAL * 100;
  pres(retour, 92, 0.01, 'le Smash rend 92 %');
  ok(retour >= PLANCHER, `et reste au-dessus du plancher de ${PLANCHER} %`);
  ok(retour < 100, 'et sous 100 % — sinon c est le coffre qui joue');

  /* La FORME compte autant que le total. A 85 % de tours vides, on perd
     presque toujours en attendant un evenement qu'on ne voit jamais : le
     retour moyen est bon et la sensation est mauvaise. */
  const vide = rien / cfg.SPIN_TOTAL * 100;
  ok(vide < 70, `au plus 70 % de tours sans rien — mesure : ${vide.toFixed(2)} %`);

  /* Et la queue ne doit pas porter le retour a elle seule : un retour dont la
     moitie vient d'un tirage a 0,04 % n'est pas percu comme un retour. */
  let queue = 0;
  for (const [mult, w] of cfg.SPIN_PRIZES) if (mult >= 50) queue += mult * w;
  ok(queue / somme < 0.30,
     `les tirages rares portent ${(queue / somme * 100).toFixed(1)} % du retour, pas plus de 30`);

  /* L'exposition maximale reste bornee : c'est ce qui permet de dormir. */
  const max = 250 * cfg.SMASH_MAX_BET;
  ok(max <= 250000, `exposition maximale ${max.toLocaleString('en-US')} jetons`);
}

// ============================================= Coin Pusher
/* ATTENTION a la formule. Le pusher ne paie PAS la valeur de chaque piece :
   une piece ne paie que si elle atteint le bord, et beaucoup restent sur le
   plateau. La moyenne du bareme — 1,043 par lacher — se multiplie donc par un
   taux de collecte (~0,77 d'apres la simulation physique), ce qui donne un
   retour reel autour de 80 %.
 *
 * Appliquer ici la formule du Smash donnerait 104 %, et on « corrigerait »
 * un jeu qui n'a rien. On verrouille donc ce qui est REELLEMENT calculable —
 * la moyenne du bareme — pour qu'une modification du tableau se voie, sans
 * pretendre connaitre une physique qu'on ne simule pas dans ce fichier. */
{
  let poids = 0, somme = 0;
  for (const [valeur, w] of cfg.PRIZES) { poids += w; somme += valeur * w; }
  assert.strictEqual(poids, cfg.PRIZE_TOTAL,
    'les poids du pusher doivent faire exactement PRIZE_TOTAL'); n++;
  const moyenne = somme / cfg.PRIZE_TOTAL;
  pres(moyenne, 1.043, 0.02,
       'la valeur moyenne d un lacher au pusher reste celle qui est documentee');
  /* Le garde-fou qui compte quand meme : meme avec une collecte PARFAITE —
     toutes les pieces tombent — le jeu ne doit pas devenir un robinet. */
  ok(moyenne < 1.10,
     `avec une collecte parfaite le pusher rendrait ${(moyenne * 100).toFixed(1)} %, ` +
     'ce qui reste une perte bornee et non une fuite');
}

// ============================================= SWOGE Spin (volcan)
/* Son retour ne se lit pas dans un tableau : il sort d'une simulation. Ce qui
   se verifie ici en une milliseconde, c'est le PARAMETRE — et c'est lui le
   danger, parce qu'il est une marche d'escalier et non un curseur.
 *
 * La piece de valeur 2 est la plus frequente du jeu. A 0,74 son arrondi donne
 * 1 ; a 0,75 il donne 2, elle double, et le retour saute de 90,8 % a 103,6 %.
 * Un jeu au-dessus de 100 % est un robinet ouvert sur le coffre. Ce controle
 * existe pour que personne ne monte ce chiffre en croyant gagner deux points. */
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'volcano.js'), 'utf8');
  const m = /const VALUE_SCALE = ([\d.]+);/.exec(src);
  ok(m, 'l echelle des pieces se lit dans volcano.js');
  const echelle = parseFloat(m[1]);
  ok(echelle <= 0.74,
     `echelle ${echelle} : au-dela de 0,74 la piece la plus frequente double a ` +
     'l arrondi et le jeu passe au-dessus de 100 %');
  ok(echelle >= 0.70,
     `echelle ${echelle} : en dessous de 0,70 le retour retombe sous le plancher`);
  /* Et la piece la plus frequente doit bien arrondir vers le BAS : c'est la
     propriete exacte qui tient le retour sous 100 %. */
  eqNum(Math.round(2 * echelle), 1,
        'la piece de valeur 2 arrondit a 1 — c est ce qui borne le retour');
}

console.log(`retours.test.js : ${n} verifications OK`);
