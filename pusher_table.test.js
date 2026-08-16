'use strict';
/*
 * La table du Coin Pusher.
 *
 * Une table de lots est le seul endroit du jeu ou une faute de frappe se paie
 * en argent reel et ne se voit pas : les poids sont des nombres a sept
 * chiffres, et une somme fausse decale silencieusement TOUS les tirages —
 * l'HMAC continue de choisir un nombre dans [0, PRIZE_TOTAL[, mais la table
 * n'y repond plus jusqu'au bout.
 *
 * Ce qui est verifie ici :
 *
 *   • la somme des poids vaut EXACTEMENT PRIZE_TOTAL, sinon la queue de la
 *     table est inatteignable ou l'on tire hors table ;
 *   • la valeur moyenne par lacher est celle qu'on croit — c'est elle, et
 *     elle seule, qui fixe le retour du jeu ;
 *   • la table est triee et sans doublon, parce que la selection avance en
 *     cumulant les poids dans l'ordre ;
 *   • et la FORME : moins de petites pieces, plus de grosses. C'est ce qui a
 *     ete demande, et sans mesure ca se perd a la prochaine retouche.
 */
const cfg = require('./config');

let rates = 0;
const ok = (c, quoi) => { console.log((c ? '  ok   ' : '  RATE ') + quoi); if (!c) rates++; };
const pres = (a, b, eps, quoi) =>
  ok(Math.abs(a - b) <= eps, quoi + '  (' + (Math.round(a * 10000) / 10000) + ')');

const T = cfg.PRIZES;
const som = T.reduce((s, [, w]) => s + w, 0);
const val = T.reduce((s, [v, w]) => s + v * w, 0);
const part = (min) => T.filter(([v]) => v >= min).reduce((s, [, w]) => s + w, 0) / som;

console.log('\nLa table de lots du Coin Pusher.\n');

ok(som === cfg.PRIZE_TOTAL,
   'la somme des poids vaut exactement PRIZE_TOTAL (' + som + ')');
pres(val / som, 1.043, 1e-9,
     'la valeur moyenne par lacher est inchangee');

ok(T.every(([v, w]) => Number.isInteger(w) && w > 0),
   'tous les poids sont des entiers strictement positifs');
ok(T.every(([v]) => Number.isInteger(v) && v >= 0),
   'toutes les valeurs sont des entiers positifs ou nuls');
ok(T.every(([v], i) => i === 0 || v > T[i - 1][0]),
   'la table est triee par valeur croissante, sans doublon');
ok(T[0][0] === 0, 'la premiere entree est la piece qui ne paie pas');

/* ---- la forme demandee ---- */
const petit = T.filter(([v]) => v > 0 && v <= 2).reduce((s, [, w]) => s + w, 0) / som;
ok(petit < 0.05,
   'une piece a 1 ou 2 tombe moins d une fois sur vingt  (' + (petit * 100).toFixed(2) + ' %)');
ok(part(10) > 0.04,
   'un gain d au moins 10 tombe plus souvent qu une fois sur vingt-cinq  (1 sur ' +
   Math.round(1 / part(10)) + ')');
ok(part(50) > 0.002,
   'un gain d au moins 50 tombe plus souvent qu une fois sur cinq cents  (1 sur ' +
   Math.round(1 / part(50)) + ')');
ok(part(25) > part(50) && part(50) > part(100),
   'plus le lot est gros, plus il est rare — la table reste monotone');

/* ---- le tirage lui-meme : chaque nombre de [0, TOTAL[ trouve un lot ---- */
let cumul = 0, trous = 0;
for (const [, w] of T) cumul += w;
ok(cumul === cfg.PRIZE_TOTAL, 'le cumul couvre toute la plage de tirage');
/* On verifie les bornes : le tout premier et le tout dernier nombre tirables. */
const lot = (n) => { let c = 0; for (const [v, w] of T) { c += w; if (n < c) return v; } return null; };
ok(lot(0) === 0, 'le tirage 0 rend bien un lot');
ok(lot(cfg.PRIZE_TOTAL - 1) === T[T.length - 1][0],
   'le dernier tirage rend le gros lot — la queue de la table est atteignable');
ok(lot(cfg.PRIZE_TOTAL) === null, 'et rien au-dela');

console.log(rates ? '\n' + rates + ' verification(s) ratee(s)\n'
                  : '\npusher_table.test.js : tout passe.\n');
process.exit(rates ? 1 : 0);
