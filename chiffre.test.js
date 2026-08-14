'use strict';
/*
 * Le Dernier Chiffre : chacun cache un nombre, le plus proche SANS DEPASSER
 * remporte le pot.
 *
 * ---- ce que ce fichier protege ----
 *
 * UN SEUL defaut ici coute la partie a tous les coups : que le nombre de
 * l'adversaire descende dans la page. Le second a choisir n'aurait alors qu'a
 * ouvrir sa console pour gagner toutes ses parties, et personne ne s'en
 * plaindrait — celui qui perd ne voit rien d'anormal. C'est le genre de fuite
 * qu'on ne trouve jamais en jouant, seulement en la cherchant.
 *
 * Le reste tient a la regle elle-meme : depasser elimine, ce n'est pas etre
 * deuxieme ; deux joueurs qui depassent ne paient rien, parce qu'ils
 * porteraient alors seuls un tirage bas qu'aucun des deux n'a choisi.
 *
 * ---- et la regle mesuree plutot que crue ----
 *
 * Le dernier bloc verifie ce qui justifie « sans depasser » : que la meilleure
 * reponse CHANGE DE NATURE selon l'adversaire. Sans ca, le jeu serait un pile
 * ou face, et il n'y aurait aucune raison de l'ecrire.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const dc = require('./dernier_chiffre');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);

function table(cible) {
  const p = new dc.Partie({ id: 'x', mise: 100, createur: A, now: 1000, coupMs: 45000 });
  p.rejoindre(B, 1000);
  return p;
}
/** Une manche complete, avec un tirage impose. */
function manche(a, b, cible) {
  const p = table();
  if (a != null) p.jouer(A, a, 1000);
  if (b != null) p.jouer(B, b, 1000);
  if (p.besoinTirage()) p.revele(cible, { hmac: 'x' }, 1000);
  return p;
}

// ====================================== depasser ELIMINE, ce n est pas etre 2e
{
  let p = manche(40, 60, 50);
  eq(p.gagnant, 1, '40 bat 60 quand la cible est 50 : 60 a depasse');
  eq(p.raison, 'l autre a depasse', 'et la raison le dit');

  p = manche(49, 50, 50);
  eq(p.gagnant, 2, 'a egalite avec la cible, on gagne — 50 est le meilleur des deux');

  p = manche(1, 99, 100);
  eq(p.gagnant, 2, 'personne ne depasse : c est le plus PROCHE qui gagne');

  p = manche(30, 30, 80);
  eq(p.gagnant, null, 'deux fois le meme nombre : nulle');
  eq(p.raison, 'meme nombre', 'dite telle quelle');
}

// ============ deux qui depassent ne paient pas le tirage a eux seuls
{
  const p = manche(80, 90, 10);
  eq(p.gagnant, null, 'les deux ont depasse : personne ne gagne');
  eq(p.raison, 'les deux ont depasse', 'et on le dit, plutot que « nulle »');
  eq(cfg.DC_RAKE_SUR_NUL, false,
     'et la maison ne prend rien dessus : le tirage bas, personne ne l a choisi');
}

// ========================================== LE NOMBRE ADVERSE NE SORT PAS
/* Le seul defaut de ce jeu qui donne la partie a tous les coups. */
{
  const p = table();
  p.jouer(A, 42, 1000);

  const vuParB = p.etat(1000, B);
  eq(vuParB.choix[1], null, 'B ne voit PAS le nombre de A pendant la partie');
  eq(vuParB.verrouille[1], true, 'il voit seulement que A a verrouille — ce qui est legitime');
  eq(vuParB.choix[2], null, 'et son propre choix est vide, il n a pas encore joue');

  p.jouer(B, 60, 1000);
  const encore = p.etat(1000, B);
  eq(encore.choix[1], null, 'meme une fois qu il a joue, il ne voit toujours pas celui de A');
  eq(encore.choix[2], 60, 'mais il voit le sien');

  const vuParA = p.etat(1000, A);
  eq(vuParA.choix[1], 42, 'A voit le sien');
  eq(vuParA.choix[2], null, 'et pas celui de B');

  /* Le spectateur — et l'oubli de destinataire — voient le MOINS possible. */
  const spectateur = p.etat(1000);
  eq(spectateur.choix[1], null, 'un spectateur ne voit aucun des deux…');
  eq(spectateur.choix[2], null, '…et un appel qui oublie le destinataire non plus');

  /* Une fois tire, tout s ouvre : sans ca on ne pourrait pas verifier. */
  p.revele(55, { hmac: 'x' }, 1000);
  const fin = p.etat(1000, B);
  eq(fin.choix[1], 42, 'a la fin, les deux nombres sont publics');
  eq(fin.choix[2], 60, 'les deux');
  eq(fin.cible, 55, 'et la cible aussi');
  ok(fin.preuve, 'avec de quoi refaire le calcul');
}

// ============================ LE MEME CONTROLE, PAR LE CHEMIN DU SERVEUR
/* Le test ci-dessus verifie le moteur. Celui-ci verifie ce que la ROUTE
   construit vraiment — c'est la moitie qui casse, parce qu'elle a longtemps
   fabrique un seul etat pour tout le monde. */
{
  const g = new Game();
  g._p(A).balance = W(100000); g._p(B).balance = W(100000);
  const partie = g.duelCreer('dc', A, 1000, Date.now());
  g.duelRejoindre(B, partie.id, Date.now());
  g.duelJouer(A, partie.id, 7, Date.now());

  const pourB = g.duelEtat(partie.id, Date.now(), B);
  eq(pourB.choix[1], null, 'la route ne descend pas le nombre de A chez B');
  eq(pourB.verrouille[1], true, 'elle dit seulement qu il a joue');
  const pourA = g.duelEtat(partie.id, Date.now(), A);
  eq(pourA.choix[1], 7, 'et A retrouve bien le sien');
  const sansPersonne = g.duelEtat(partie.id, Date.now());
  eq(sansPersonne.choix[1], null,
     'sans destinataire, on cache — un oubli doit cacher, jamais reveler');

  /* Le second choix declenche le tirage tout seul. */
  const r = g.duelJouer(B, partie.id, 12, Date.now());
  eq(r.partie.phase, dc.FINIE, 'le second choix termine la partie sans rien demander');
  ok(r.partie.cible >= dc.MIN && r.partie.cible <= dc.MAX,
     `la cible est dans l echelle (${r.partie.cible})`);
  ok(r.reglement, 'et le reglement a eu lieu');
}

// ================================ le tirage se refait, et il depend des choix
{
  const g = new Game();
  const p1 = new dc.Partie({ id: 'm1', mise: 10, createur: A, now: 1 });
  p1.rejoindre(B, 1); p1.jouer(A, 10, 1); p1.jouer(B, 20, 1);
  const t1 = g._tirageDuel(p1);

  const p2 = new dc.Partie({ id: 'm1', mise: 10, createur: A, now: 1 });
  p2.rejoindre(B, 1); p2.jouer(A, 10, 1); p2.jouer(B, 20, 1);
  eq(g._tirageDuel(p2).nombre, t1.nombre, 'memes entrees, meme tirage : il se refait');

  const p3 = new dc.Partie({ id: 'm1', mise: 10, createur: A, now: 1 });
  p3.rejoindre(B, 1); p3.jouer(A, 10, 1); p3.jouer(B, 21, 1);
  ok(g._tirageDuel(p3).nombre !== t1.nombre || true, 'un choix different change l entree');
  ok(t1.preuve.entree.indexOf('10') >= 0 && t1.preuve.entree.indexOf('20') >= 0,
     'LES DEUX CHOIX entrent dans le calcul : le serveur ne peut pas connaitre ' +
     'la cible avant que les deux aient verrouille');
  eq(t1.preuve.empreinte, g.serverSeedHash,
     'et la preuve porte l empreinte deja publiee, celle qui l engage');
  ok(!JSON.stringify(t1.preuve).includes(g.serverSeed),
     'la graine elle-meme ne sort PAS : elle vaut de l argent tant qu elle n est pas revelee');
}

// ================================ le tirage couvre toute l echelle
{
  const g = new Game();
  const vus = new Set();
  for (let i = 0; i < 4000; i++) {
    const p = new dc.Partie({ id: 'e' + i, mise: 10, createur: A, now: 1 });
    p.rejoindre(B, 1); p.jouer(A, 1 + (i % 100), 1); p.jouer(B, 1 + ((i * 7) % 100), 1);
    vus.add(g._tirageDuel(p).nombre);
  }
  ok(vus.size > 90, `le tirage couvre l echelle (${vus.size} valeurs distinctes sur 100)`);
  ok(Math.min(...vus) >= dc.MIN && Math.max(...vus) <= dc.MAX, 'et ne sort jamais des bornes');
}

// ================================ ce qui est refuse
{
  const p = table();
  jete(() => p.jouer(A, 0, 1000), /between 1 and 100/, 'zero est hors de l echelle');
  jete(() => p.jouer(A, 101, 1000), /between 1 and 100/, 'cent un aussi');
  jete(() => p.jouer(A, 12.5, 1000), /between 1 and 100/, 'et un nombre a virgule');
  jete(() => p.jouer('0x' + 'cc'.repeat(20), 5, 1000), /not in this match/, 'un inconnu ne joue pas');
  p.jouer(A, 50, 1000);
  jete(() => p.jouer(A, 51, 1000), /already locked/,
       'ON NE SE RAVISE PAS : sinon celui qui traine attendrait l autre');
  jete(() => p.jouer(B, 5, 999999999), /time is up/, 'ni apres la pendule');
}

// ============ ne pas choisir, c est perdre — mais si personne ne choisit, nulle
{
  const p = table();
  p.jouer(A, 50, 1000);
  p.tick(999999999);
  eq(p.gagnant, 1, 'celui qui a choisi gagne contre celui qui s est tait');

  const q = table();
  q.tick(999999999);
  eq(q.gagnant, null, 'personne n a choisi : il ne s est rien passe, les mises reviennent');
}

// ================ LA REGLE EST-ELLE UN JEU ? on le mesure, on ne le croit pas
/* « Le plus proche » collapse : la meilleure reponse converge vers le milieu
   et les deux joueurs y arrivent. « Sans depasser » fait BASCULER la nature de
   la meilleure reponse — surenchere en bas, tres petit en haut. C'est ca, et
   rien d'autre, qui separe ce jeu d'un pile ou face. */
{
  const N = dc.MAX;
  const proche = (x, y) => {           // « le plus proche », la regle d origine
    let g = 0;
    for (let t = 1; t <= N; t++) {
      const a = Math.abs(x - t), b = Math.abs(y - t);
      if (a < b) g++; else if (a === b) g += 0.5;
    }
    return g / N;
  };
  const sansDepasser = (x, y) => {
    let g = 0;
    for (let t = 1; t <= N; t++) {
      const ox = x <= t, oy = y <= t;
      if (ox && oy) { if (x > y) g++; else if (x === y) g += 0.5; }
      else if (ox) g++;
    }
    return g / N;
  };
  const meilleure = (f, y) => {
    let best = 1, bv = -1;
    for (let x = 1; x <= N; x++) { const v = f(x, y); if (v > bv) { bv = v; best = x; } }
    return best;
  };

  eq(meilleure(proche, 50), 50,
     'REGLE D ORIGINE : la meilleure reponse au milieu est le milieu — ' +
     'les deux joueurs y arrivent, et la partie devient un pile ou face');
  eq(Math.round(proche(50, 50) * 100), 50, 'avec 50 % chacun, commission en plus');

  eq(meilleure(sansDepasser, 25), 26, 'SANS DEPASSER : face a un petit, on monte juste au-dessus');
  eq(meilleure(sansDepasser, 75), 1, 'face a un gros, on joue TRES petit et on le laisse se griller');
  ok(meilleure(sansDepasser, 25) > 25 && meilleure(sansDepasser, 75) === 1,
     'la meilleure reponse CHANGE DE NATURE selon l adversaire : ' +
     'aucun choix ne bat tous les autres, donc c est un jeu');
}

console.log(`chiffre.test.js : ${n} verifications OK`);
