'use strict';
/*
 * LE MONDE VIVANT — la simulation qui tourne sur le SERVEUR.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE CLIENT NE PEUT PAS TRICHER. Ni se teleporter, ni tirer plus vite que
 *    son arme, ni s'attribuer de l'XP. C'est la raison d'etre du fichier :
 *    des objets payes en vrai $SWOGE disparaissent a la mort.
 * 2. LES MONSTRES POURSUIVENT, PUIS S'ARRETENT AU CONTACT. Un monstre qui
 *    pousse le joueur devant lui transforme la poursuite en remorquage.
 * 3. ON BLESSE, ON MEURT, ON GAGNE DE L'XP — et chaque evenement est RENDU,
 *    jamais applique ici : les soldes appartiennent a game.js.
 * 4. ON ARRIVE PAR LE BORD, jamais au milieu de la lave.
 * 5. LA CARTE NE SE VIDE PAS, et rien ne nait dans le dos du joueur.
 */
const assert = require('assert');
const { Realm } = require('./realm');
const M = require('./monde');
const P = require('./personnages');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

function alea(graine) {
  let s = graine >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
/* Un personnage de reference : niveau 1, arme commune. */
const FICHE = { skin: 'andy', nom: 'Dodexel', famille: 'lame',
                degats: P.DEGATS_ARME.commun,
                stats: { hp: 350, att: 28, def: 13 } };

// ================== 1. ON ARRIVE PAR LE BORD
{
  for (let g = 1; g <= 40; g++) {
    const r = new Realm({ alea: alea(g) });
    const j = r.rejoint(A, FICHE);
    eq(M.biomeEn(j.x, j.y), 'terre', 'on arrive toujours sur la terre, jamais dans la lave');
  }
}

// ================== 2. ON NE PEUT PAS SE TELEPORTER
{
  const r = new Realm({ alea: alea(5) });
  const j = r.rejoint(A, FICHE);
  const x0 = j.x, y0 = j.y;

  // un pas honnete passe tel quel
  ok(r.bouge(A, x0 + 20, y0, 'right', 'run', 0.15), 'un pas normal est accepte');
  eq(Math.round(j.x), Math.round(x0 + 20), 'et la position annoncee est prise telle quelle');

  // un bond a l'autre bout de la carte est RAMENE
  const avant = { x: j.x, y: j.y };
  ok(!r.bouge(A, j.x + 4000, j.y, 'right', 'run', 0.15), 'un bond de 4000 unites est refuse');
  const parcouru = Math.sqrt((j.x - avant.x) ** 2 + (j.y - avant.y) ** 2);
  ok(parcouru <= M.VITESSE_JOUEUR * 0.15 * 1.7,
    'on n avance que de ce que la vitesse permet (a ' + Math.round(parcouru) + ' unites)');
  ok(j.x < avant.x + 4000, 'on n est PAS arrive a la position demandee');

  // et jamais hors de la carte
  r.bouge(A, -9999, -9999, 'left', 'run', 99);
  ok(j.x >= 0 && j.y >= 0, 'on ne sort pas de la carte par la gauche');
  r.bouge(A, 1e9, 1e9, 'right', 'run', 99);
  ok(j.x <= M.MONDE.w && j.y <= M.MONDE.h, 'ni par la droite');
}

// ================== 3. LA CADENCE EST TENUE PAR LE SERVEUR
{
  const r = new Realm({ alea: alea(9) });
  r.rejoint(A, FICHE);
  const a = M.ARMES.lame;

  eq(r.tire(A, 0), a.tirs, 'le premier tir part');
  let refuses = 0;
  for (let i = 0; i < 50; i++) if (r.tire(A, 0) === 0) refuses++;
  eq(refuses, 50, 'cinquante demandes immediates ne donnent AUCUN projectile de plus');

  // apres le temps de recharge, un seul nouveau tir
  r.pas(1 / a.cadence + 0.01);
  eq(r.tire(A, 0), a.tirs, 'une fois recharge, le tir repart');

  /* En une seconde de jeu, on ne peut pas depasser la cadence annoncee.
     C'est LE verrou : sans lui, un client modifie viderait la carte. */
  const r2 = new Realm({ alea: alea(10) });
  r2.rejoint(A, FICHE);
  let partis = 0;
  for (let i = 0; i < 100; i++) { partis += r2.tire(A, 0); r2.pas(0.01); }
  ok(partis <= Math.ceil(a.cadence) * a.tirs + a.tirs,
    'en une seconde on ne depasse pas la cadence de l arme (a ' + partis + ' projectiles)');
}

// ================== 4. LES MONSTRES POURSUIVENT ET S'ARRETENT AU CONTACT
{
  const r = new Realm({ alea: alea(3) });
  const j = r.rejoint(A, FICHE);
  // on plante un lime a portee de vue, mais pas au contact
  r.monstres = [{ id: 99, espece: 'lime', biome: 'terre',
                  x: j.x + 300, y: j.y, ancreX: j.x + 300, ancreY: j.y,
                  pv: 60, pvMax: 60, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  const d0 = 300;
  for (let i = 0; i < 20; i++) r.pas(0.1);
  const m = r.monstres[0];
  const d1 = Math.abs(m.x - j.x);
  ok(d1 < d0, 'le monstre s est rapproche (de ' + d0 + ' a ' + Math.round(d1) + ')');
  eq(m.cible, A, 'et il a bien pris le joueur pour cible');

  // il finit au contact et s y ARRETE, sans traverser
  for (let i = 0; i < 80; i++) r.pas(0.1);
  const d2 = Math.sqrt((r.monstres[0].x - j.x) ** 2 + (r.monstres[0].y - j.y) ** 2);
  ok(d2 >= M.MONSTRES.lime.rayon, 'il ne rentre pas DANS le joueur (a ' + Math.round(d2) + ')');
  ok(d2 <= M.MONSTRES.lime.rayon + 40, 'mais il reste colle (a ' + Math.round(d2) + ')');
}

// ================== 5. AU CONTACT, IL BLESSE — ET ON PEUT EN MOURIR
{
  const r = new Realm({ alea: alea(11) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [{ id: 1, espece: 'skeleton', biome: 'neige',
                  x: j.x + 10, y: j.y, ancreX: j.x, ancreY: j.y,
                  pv: 180, pvMax: 180, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  const pv0 = j.pv;
  let coups = 0, mort = null;
  for (let i = 0; i < 400 && !mort; i++) {
    const ev = r.pas(0.1);
    coups += ev.degats.length;
    if (ev.morts.length) mort = ev.morts[0];
  }
  ok(coups > 0, 'le squelette a bien frappe');
  ok(j.pv < pv0, 'les points de vie ont baisse');
  ok(mort && mort.addr === A, 'et le joueur a fini par mourir');
  eq(j.pv, 0, 'a zero point de vie exactement');
  eq(mort.par, 'skeleton', 'l evenement dit QUI a tue');

  // le nombre de coups encaisses colle a ce que monde.js annonce
  const attendu = Math.ceil(350 / M.degatsSubis(M.MONSTRES.skeleton.att, 13));
  ok(Math.abs(coups - attendu) <= 1,
    'il a fallu ' + coups + ' coups, la regle en annoncait ' + attendu);
}

// ================== 6. ON TUE, ET L'XP EST RENDUE — PAS APPLIQUEE
{
  const r = new Realm({ alea: alea(21) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [{ id: 7, espece: 'lime', biome: 'terre',
                  x: j.x + 120, y: j.y, ancreX: j.x + 120, ancreY: j.y,
                  pv: 60, pvMax: 60, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  let kills = [], touches = 0, tours = 0;
  while (!kills.length && tours < 400) {
    tours++;
    r.tire(A, 0);                 // plein est, vers le lime
    const ev = r.pas(0.05);
    touches += ev.touches.length;
    kills = kills.concat(ev.kills);
  }
  eq(kills.length, 1, 'le lime est mort');
  eq(kills[0].espece, 'lime', 'et l evenement dit laquelle');
  eq(kills[0].xp, M.MONSTRES.lime.xp, 'l XP rendue est celle du catalogue');
  eq(kills[0].addr, A, 'creditee au bon joueur');
  ok(touches >= 2, 'il a fallu plusieurs coups pour l abattre (a ' + touches + ')');
  eq(r.monstres.length, 0, 'le cadavre a quitte la carte');
  eq(j.xpGagnee, M.MONSTRES.lime.xp, 'le compteur du joueur suit');
}

// ================== 7. UN TIR NE PORTE PAS PLUS LOIN QUE SON ARME
{
  const r = new Realm({ alea: alea(31) });
  const j = r.rejoint(A, FICHE);
  const portee = M.ARMES.lame.portee;
  // un monstre JUSTE hors de portee
  r.monstres = [{ id: 3, espece: 'lime', biome: 'terre',
                  x: j.x + portee + 90, y: j.y, ancreX: j.x + portee + 90, ancreY: j.y,
                  pv: 60, pvMax: 60, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  r.tire(A, 0);
  let touches = 0;
  for (let i = 0; i < 60; i++) touches += r.pas(0.02).touches.length;
  eq(touches, 0, 'le projectile meurt avant d atteindre un monstre trop loin');
  eq(r.tirs.length, 0, 'et il ne reste aucun projectile en vol');
}

// ================== 8. ON NE VOIT QUE CE QUI EST AUTOUR DE SOI
{
  const r = new Realm({ alea: alea(41) });
  const j = r.rejoint(A, FICHE);
  const etat = r.etatPour(A, 1000);
  ok(etat, 'un joueur present a un etat');
  ok(etat.monstres.length < r.monstres.length,
    'on ne recoit pas les quarante monstres de la carte (' +
    etat.monstres.length + ' sur ' + r.monstres.length + ')');
  const loin = etat.monstres.filter((m) => {
    const dx = m.x - j.x, dy = m.y - j.y;
    return Math.sqrt(dx * dx + dy * dy) > 1000;
  });
  eq(loin.length, 0, 'et aucun de ceux recus n est hors de portee');
  eq(r.etatPour('0xinconnu', 1000), null, 'un absent n a pas d etat');

  // deux joueurs se voient, chacun depuis son point de vue
  const k = r.rejoint(B, FICHE);
  k.x = j.x + 100; k.y = j.y;
  const vueA = r.etatPour(A, 1000);
  eq(vueA.joueurs.length, 1, 'A voit B');
  eq(vueA.joueurs[0].a, B, 'et c est bien B');
  ok(!vueA.joueurs.some((o) => o.a === A), 'A ne se voit pas dans la liste des autres');
  ok(vueA.moi.pv > 0, 'A recoit SES points de vie a part');
}

// ================== 9. LA CARTE NE SE VIDE PAS, ET RIEN NE NAIT DANS LE DOS
{
  const r = new Realm({ alea: alea(51) });
  const j = r.rejoint(A, FICHE);
  const plein = r.monstres.length;
  r.monstres = r.monstres.slice(0, plein - 12);      // on en tue douze
  const nes = r.repeuple(900);
  ok(nes > 0, 'des monstres reviennent (' + nes + ')');
  eq(r.monstres.length, plein, 'la carte retrouve son compte');
  const tropPres = r.monstres.filter((m) => {
    const dx = m.x - j.x, dy = m.y - j.y;
    return Math.sqrt(dx * dx + dy * dy) < 900;
  });
  /* Les anciens peuvent etre pres — ils etaient la avant. Ce sont les
     NOUVEAUX qui ne doivent pas apparaitre sous le nez du joueur. */
  const nouveaux = r.monstres.slice(plein - 12);
  const nouveauxPres = nouveaux.filter((m) => {
    const dx = m.x - j.x, dy = m.y - j.y;
    return Math.sqrt(dx * dx + dy * dy) < 900;
  });
  eq(nouveauxPres.length, 0, 'aucun nouveau monstre ne nait a moins de 900 unites du joueur');
  ok(tropPres.length >= 0, 'les anciens, eux, peuvent etre la ou ils sont');
}

// ================== 10. UN MORT NE JOUE PLUS
{
  const r = new Realm({ alea: alea(61) });
  const j = r.rejoint(A, FICHE);
  j.pv = 0;
  eq(r.tire(A, 0), 0, 'un joueur a zero point de vie ne tire pas');
  // et il ne sert plus de cible
  r.monstres = [{ id: 5, espece: 'lime', biome: 'terre',
                  x: j.x + 50, y: j.y, ancreX: j.x + 50, ancreY: j.y,
                  pv: 60, pvMax: 60, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  const ev = r.pas(0.1);
  eq(ev.degats.length, 0, 'et plus personne ne le frappe');
  eq(r.monstres[0].cible, null, 'il a cesse d etre une cible');

  // quitter le monde le retire vraiment
  r.quitte(A);
  eq(r.etatPour(A, 1000), null, 'apres avoir quitte, plus d etat');
  eq(r.tire(A, 0), 0, 'et plus de tir');
}

// ================== 11. LE MONDE EST REPRODUCTIBLE
{
  const a = new Realm({ alea: alea(77) });
  const b = new Realm({ alea: alea(77) });
  eq(JSON.stringify(a.monstres), JSON.stringify(b.monstres),
    'meme graine, meme monde — la simulation ne depend d aucun hasard cache');
}

console.log('realm.test.js : ' + n + ' verifications OK');
