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

// ================== 12. L'ARCHER TIRE, ET SES FLECHES BLESSENT
{
  const r = new Realm({ alea: alea(101) });
  const j = r.rejoint(A, FICHE);
  const t = M.MONSTRES.archer;
  /* On le pose A PORTEE mais pas au contact : c'est la ou il doit decocher
     au lieu de s'approcher. */
  r.monstres = [{ id: 42, espece: 'archer', biome: 'neige',
                  x: j.x + t.tir.portee * 0.7, y: j.y,
                  ancreX: j.x, ancreY: j.y,
                  pv: t.pv, pvMax: t.pv, dir: 'left', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  const pv0 = j.pv;
  let touche = null, tirsVus = 0;
  for (let i = 0; i < 400 && !touche; i++) {
    const ev = r.pas(0.05);
    if (r.tirsM.length > tirsVus) tirsVus = r.tirsM.length;
    if (ev.degats.length) touche = ev.degats[0];
  }
  ok(tirsVus > 0, 'l archer a decoche (' + tirsVus + ' fleches en vol au plus)');
  ok(touche, 'et une fleche a touche');
  eq(touche.par, 'archer', 'l evenement nomme l archer');
  ok(j.pv < pv0, 'les points de vie ont baisse');
  eq(touche.perte, M.degatsSubis(t.att, 13), 'la perte suit la meme regle que le contact');

  /* IL GARDE SES DISTANCES. Un archer colle au joueur ne serait qu'un
     squelette mal dessine : toute sa raison d'etre est l'ecart. */
  const d = Math.sqrt((r.monstres[0].x - j.x) ** 2 + (r.monstres[0].y - j.y) ** 2);
  ok(d > t.rayon + 60, 'il ne vient pas au corps a corps (a ' + Math.round(d) + ')');

  /* SES FLECHES NE TOUCHENT PAS LES MONSTRES, et les notres ne touchent pas
     les joueurs : deux listes, deux collisions. */
  const avantM = r.monstres[0].pv;
  for (let i = 0; i < 60; i++) r.pas(0.05);
  eq(r.monstres[0].pv, avantM, 'ses propres fleches ne le blessent pas');
}

// ================== 13. L'ETAT PORTE LES DEUX SORTES DE PROJECTILES
{
  const r = new Realm({ alea: alea(103) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];
  r.tire(A, 0);
  r.tirsM.push({ id: 999, espece: 'archer', x: j.x + 40, y: j.y, a: Math.PI,
                 v: 300, reste: 1, att: 45, sprite: 'maudit' });
  const e = r.etatPour(A, 1400);
  ok(e.tirs.length > 0, 'nos projectiles sont la');
  ok(e.tirsM.length > 0, 'ceux des monstres aussi');
  ok(e.tirs[0].mien === true, 'les notres sont marques comme notres');
  eq(e.tirsM[0].f, 'maudit', 'et les leurs portent leur propre dessin');
}

// ================== 14. LA VIE ET LE MANA QUI REMONTENT
//
// Le coefficient vient de monde.js (celui de RotMG). Ce qui se verifie ici,
// c'est ce que realm.js en fait : que les points soient reellement VERSES.
// La faute qui guette est bete et invisible — a 4.9 PV/s, un pas de 100 ms
// vaut 0.49 PV, arrondi a zero dix fois par seconde. La formule serait juste
// et la barre ne bougerait jamais.
{
  const FR = { ...FICHE, stats: { hp: 400, mp: 200, att: 28, def: 13, vit: 40, wis: 50 } };
  const r = new Realm({ alea: alea(200) });
  r.monstres = [];
  const j = r.rejoint(A, FR);
  j.pv = 100; j.mp = 0;

  /* Une seconde de simulation, en pas de 100 ms comme le vrai serveur. */
  for (let i = 0; i < 10; i++) r.pas(0.1);
  ok(j.pv > 100, `un point de vie est bien verse en une seconde (${j.pv})`);
  ok(j.mp > 0, `du mana aussi (${j.mp})`);

  /* Le DEBIT suit la vitalite. On ne compare pas a un chiffre en dur — le
     coefficient a le droit de changer — mais deux vitalites differentes ne
     peuvent pas donner le meme resultat, sinon la stat ne sert a rien. */
  const lent = new Realm({ alea: alea(201) }); lent.monstres = [];
  const jl = lent.rejoint(B, { ...FR, stats: { ...FR.stats, vit: 0 } });
  jl.pv = 100;
  for (let i = 0; i < 30; i++) { lent.pas(0.1); r.pas(0.1); }
  ok((j.pv - 100) > (jl.pv - 100) * 2,
     `40 de vitalite soigne bien plus vite que 0 (${j.pv - 100} contre ${jl.pv - 100})`);
}

// ================== 15. LE REPOS DOUBLE, TIRER ET COURIR CASSENT LE REPOS
//
// C'est la seule chose qui rend la vitalite lisible en jeu. Si bouger ne
// cassait pas le repos, la regeneration doublee s'appliquerait en plein
// combat et annulerait les degats recus — c'est-a-dire rendrait les monstres
// inoffensifs.
{
  const FR = { ...FICHE, stats: { hp: 900, mp: 200, att: 28, def: 13, vit: 40, wis: 50 } };

  const calme = new Realm({ alea: alea(202) }); calme.monstres = [];
  const jc = calme.rejoint(A, FR); jc.pv = 100;
  for (let i = 0; i < 60; i++) calme.pas(0.1);   // six secondes sans rien faire

  const actif = new Realm({ alea: alea(203) }); actif.monstres = [];
  const ja = actif.rejoint(A, FR); ja.pv = 100;
  for (let i = 0; i < 60; i++) {
    /* On avance de deux unites a chaque pas : loin d'etre une triche de
       vitesse, mais assez pour que ce ne soit plus du repos. */
    actif.bouge(A, ja.x + 2, ja.y, 'down', 'walk', 0.1);
    actif.pas(0.1);
  }
  ok((jc.pv - 100) > (ja.pv - 100) * 1.5,
     `six secondes de calme soignent bien plus que six secondes de course ` +
     `(${jc.pv - 100} contre ${ja.pv - 100})`);

  /* Rester immobile en continuant d'ANNONCER sa position ne casse rien : le
     client parle dix fois par seconde meme a l'arret. */
  const immobile = new Realm({ alea: alea(204) }); immobile.monstres = [];
  const ji = immobile.rejoint(A, FR); ji.pv = 100;
  for (let i = 0; i < 60; i++) {
    immobile.bouge(A, ji.x, ji.y, 'down', 'idle', 0.1);
    immobile.pas(0.1);
  }
  eq(ji.pv, jc.pv, 'annoncer la meme position ne casse pas le repos');

  /* Un mort ne se releve pas tout seul. */
  const mort = new Realm({ alea: alea(205) }); mort.monstres = [];
  const jm = mort.rejoint(A, FR); jm.pv = 0;
  for (let i = 0; i < 60; i++) mort.pas(0.1);
  eq(jm.pv, 0, 'un mort ne regenere pas');

  /* Ni la vie ni le mana ne depassent la reserve. */
  const plein = new Realm({ alea: alea(206) }); plein.monstres = [];
  const jp = plein.rejoint(A, FR);
  jp.pv = jp.pvMax - 1; jp.mp = jp.mpMax - 1;
  for (let i = 0; i < 100; i++) plein.pas(0.1);
  eq(jp.pv, jp.pvMax, 'la vie s arrete au plafond');
  eq(jp.mp, jp.mpMax, 'le mana aussi');
}

// ================== 16. LE POUVOIR DU FRUIT : CE QUI LE REFUSE
//
// Chaque refus est RENDU, jamais silencieux : une barre d'espace qui ne
// repond pas se lit comme un bug, pas comme un manque de mana.
{
  const SANS = { ...FICHE, stats: { hp: 400, mp: 200, att: 28, def: 13, vit: 10, wis: 10 } };
  const r = new Realm({ alea: alea(210) }); r.monstres = [];
  r.rejoint(A, SANS);
  eq(r.pouvoir(A, null).refus, 'aucun', 'sans fruit, pas de pouvoir');

  const AVEC = { ...SANS, statFruit: 'att' };   // -> foudre
  const r2 = new Realm({ alea: alea(211) }); r2.monstres = [];
  const j2 = r2.rejoint(A, AVEC);
  eq(j2.pouvoir, 'foudre', 'un fruit d attaque donne la foudre');

  j2.mp = 0;
  const refus = r2.pouvoir(A, null);
  eq(refus.refus, 'mana', 'sans mana, refus explicite');
  ok(refus.manque === M.POUVOIRS.foudre.cout, 'et il dit combien il manque');

  j2.mp = j2.mpMax;
  const ok1 = r2.pouvoir(A, { touches: [], kills: [] });
  ok(!ok1.refus, 'avec du mana, il part');
  eq(j2.mp, j2.mpMax - M.POUVOIRS.foudre.cout, 'et le mana est bien preleve');

  const ok2 = r2.pouvoir(A, { touches: [], kills: [] });
  eq(ok2.refus, 'recharge', 'deux fois de suite : refuse, la recharge tient');

  /* La recharge descend avec le temps, pas toute seule. */
  for (let i = 0; i < Math.ceil(M.POUVOIRS.foudre.recharge / 0.1) + 2; i++) r2.pas(0.1);
  ok(!r2.pouvoir(A, { touches: [], kills: [] }).refus,
     'la recharge ecoulee, il repart');

  /* Un mort ne lance rien. */
  j2.pv = 0;
  eq(r2.pouvoir(A, null), null, 'un mort ne lance pas de pouvoir');
}

// ================== 17. LA FOUDRE FRAPPE, ET SON XP PASSE PAR LE MEME CHEMIN
{
  const r = new Realm({ alea: alea(212) });
  const j = r.rejoint(A, { ...FICHE, statFruit: 'att',
                           stats: { hp: 400, mp: 300, att: 28, def: 13, vit: 10, wis: 10 } });
  const t = M.MONSTRES.lime;
  r.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: j.x + 120, y: j.y,
                  ancreX: j.x + 120, ancreY: j.y, pv: t.pv, pvMax: t.pv,
                  dir: 'down', cible: null, recharge: 0, stase: 0,
                  errX: 0, errY: 0, errChrono: 0 }];

  const ev = { touches: [], kills: [] };
  const s = r.pouvoir(A, ev);
  eq(s.cle, 'foudre', 'c est bien la foudre');
  ok(s.perte > 0, `elle enleve quelque chose (${s.perte})`);
  eq(ev.touches.length, 1, 'et ca passe par ev.touches, comme une fleche');

  /* PLUS FORT QU'UN TIR ORDINAIRE — sinon soixante mana et six secondes de
     recharge ne servent a rien. */
  const ordinaire = M.degatsInfliges(28, P.DEGATS_ARME.commun[1], t.def);
  ok(s.perte > ordinaire * 2, `elle frappe bien plus fort qu un tir (${s.perte} contre ${ordinaire})`);

  /* Elle ne frappe RIEN hors de portee : un pouvoir qui touche a l autre
     bout de la carte n aurait pas de portee du tout. */
  const loin = new Realm({ alea: alea(213) });
  const jl = loin.rejoint(A, { ...FICHE, statFruit: 'att',
                               stats: { hp: 400, mp: 300, att: 28, def: 13 } });
  loin.monstres = [{ id: 1, espece: 'lime', biome: 'terre',
                     x: jl.x + M.POUVOIRS.foudre.portee + 200, y: jl.y,
                     ancreX: 0, ancreY: 0, pv: t.pv, pvMax: t.pv, dir: 'down',
                     cible: null, recharge: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 }];
  const sl = loin.pouvoir(A, { touches: [], kills: [] });
  ok(sl.vide === true, 'hors de portee, elle part dans le vide');
  eq(loin.monstres[0].pv, t.pv, 'et le monstre lointain n a rien');

  /* Elle TUE, et l XP remonte par ev.kills — pas par un raccourci. */
  const mortel = new Realm({ alea: alea(214) });
  const jm = mortel.rejoint(A, { ...FICHE, statFruit: 'att',
                                 stats: { hp: 400, mp: 300, att: 55, def: 13 } });
  mortel.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: jm.x + 60, y: jm.y,
                       ancreX: 0, ancreY: 0, pv: 3, pvMax: t.pv, dir: 'down',
                       cible: null, recharge: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 }];
  const evm = { touches: [], kills: [] };
  mortel.pouvoir(A, evm);
  eq(evm.kills.length, 1, 'un eclair qui tue rend bien un kill');
  eq(evm.kills[0].xp, t.xp, 'avec l XP de l espece, la meme qu une fleche');
  eq(jm.xpGagnee, t.xp, 'et elle est portee au compte du joueur');
}

// ================== 18. LA STASE FIGE VRAIMENT
//
// Cinq secondes pendant lesquelles un monstre ne bouge pas, ne frappe pas et
// ne tire pas. La faute a eviter : le laisser flaner doucement, ce qui
// donnerait l impression que le pouvoir n a pas pris.
{
  const r = new Realm({ alea: alea(220) });
  const j = r.rejoint(A, { ...FICHE, statFruit: 'def',
                           stats: { hp: 900, mp: 300, att: 28, def: 13 } });
  eq(r.joueurs.get(A).pouvoir, 'stase', 'un fruit de garde donne la stase');

  const t = M.MONSTRES.lime;
  r.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: j.x + 100, y: j.y,
                  ancreX: j.x + 100, ancreY: j.y, pv: t.pv, pvMax: t.pv,
                  dir: 'down', cible: null, recharge: 0, stase: 0,
                  errX: 1, errY: 0, errChrono: 99 }];

  const s = r.pouvoir(A, { touches: [], kills: [] });
  eq(s.cle, 'stase', 'c est bien la stase');
  eq(s.figes.length, 1, 'le monstre a portee est fige');
  eq(s.duree, 5, 'pendant cinq secondes, la duree demandee');

  const x0 = r.monstres[0].x, y0 = r.monstres[0].y, pv0 = j.pv;
  for (let i = 0; i < 40; i++) r.pas(0.1);   // quatre secondes
  eq(r.monstres[0].x, x0, 'il n a pas bouge d un pouce');
  eq(r.monstres[0].y, y0, 'ni en hauteur');
  eq(j.pv, pv0, 'et il n a pas frappe');

  /* On le voit dans l etat, sinon quatre secondes de monstres immobiles se
     lisent comme un serveur qui a lache. */
  const e = r.etatPour(A, 1400);
  ok(e.monstres[0].st > 0, 'la stase se voit dans l etat');

  /* Elle FINIT. Un monstre fige pour toujours serait un monstre mort.
     On mesure le depart depuis la position OU IL ETAIT FIGE : deux secondes
     de plus suffisent au lime pour couvrir les cent unites qui le separent
     du joueur et se coller au contact, ou il s'arrete de nouveau — comparer
     deux positions apres coup ne prouverait donc rien. */
  for (let i = 0; i < 20; i++) r.pas(0.1);
  ok(!r.monstres[0].stase, 'la stase finit par tomber');
  ok(Math.abs(r.monstres[0].x - x0) > 20,
     `et le monstre repart (de ${Math.round(x0)} a ${Math.round(r.monstres[0].x)})`);

  /* Un monstre fige reste une CIBLE : il encaisse les fleches. */
  const rr = new Realm({ alea: alea(221) });
  const jj = rr.rejoint(A, { ...FICHE, statFruit: 'def',
                             stats: { hp: 900, mp: 300, att: 28, def: 13 } });
  rr.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: jj.x + 100, y: jj.y,
                   ancreX: 0, ancreY: 0, pv: t.pv, pvMax: t.pv, dir: 'down',
                   cible: null, recharge: 0, stase: 0, errX: 0, errY: 0, errChrono: 99 }];
  rr.pouvoir(A, { touches: [], kills: [] });
  rr.tire(A, 0);
  for (let i = 0; i < 10; i++) rr.pas(0.05);
  ok(rr.monstres[0].pv < t.pv, 'un monstre fige encaisse quand meme les tirs');

  /* Hors du rayon, rien n est fige. */
  const rl = new Realm({ alea: alea(222) });
  const jl = rl.rejoint(A, { ...FICHE, statFruit: 'def',
                             stats: { hp: 900, mp: 300, att: 28, def: 13 } });
  rl.monstres = [{ id: 1, espece: 'lime', biome: 'terre',
                   x: jl.x + M.POUVOIRS.stase.rayon + 150, y: jl.y,
                   ancreX: 0, ancreY: 0, pv: t.pv, pvMax: t.pv, dir: 'down',
                   cible: null, recharge: 0, stase: 0, errX: 0, errY: 0, errChrono: 99 }];
  eq(rl.pouvoir(A, { touches: [], kills: [] }).figes.length, 0,
     'hors du rayon, rien n est fige');
}

// ================== 19. LA RAFALE ACCELERE LA CADENCE, ET SEULEMENT ELLE
{
  const FR = { ...FICHE, statFruit: 'dex',
               stats: { hp: 400, mp: 300, att: 28, def: 13 } };
  const compte = (avecRafale) => {
    const r = new Realm({ alea: alea(230) });
    r.monstres = [];
    const j = r.rejoint(A, FR);
    if (avecRafale) r.pouvoir(A, { touches: [], kills: [] });
    let tirs = 0;
    /* Deux secondes : on demande a tirer a chaque pas, le serveur refuse ce
       que la cadence ne permet pas. */
    for (let i = 0; i < 40; i++) { tirs += r.tire(A, 0); r.pas(0.05); }
    return { tirs, j };
  };
  const sans = compte(false);
  const avec = compte(true);
  eq(sans.j.pouvoir, 'rafale', 'un fruit de dexterite donne la rafale');
  ok(avec.tirs > sans.tirs,
     `la rafale fait partir plus de projectiles (${avec.tirs} contre ${sans.tirs})`);

  /* Elle ne change PAS le nombre de projectiles par tir : c'est la main qui
     va plus vite, pas l arme qui se dedouble. Une lame tire 1, elle continue. */
  const r = new Realm({ alea: alea(231) }); r.monstres = [];
  r.rejoint(A, FR);
  r.pouvoir(A, { touches: [], kills: [] });
  eq(r.tire(A, 0), M.ARMES.lame.tirs, 'un tir reste un tir');

  /* Elle FINIT. */
  const rf = new Realm({ alea: alea(232) }); rf.monstres = [];
  const jf = rf.rejoint(A, FR);
  rf.pouvoir(A, { touches: [], kills: [] });
  ok(jf.rafale > 0, 'la rafale est active');
  for (let i = 0; i < Math.ceil(M.POUVOIRS.rafale.duree / 0.1) + 2; i++) rf.pas(0.1);
  eq(jf.rafale, 0, 'et elle retombe apres sa duree');
}

// ================== 20. L'ETAT PORTE LE MANA ET L'ETAT DU POUVOIR
//
// Le bouton doit pouvoir s eteindre a la seconde ou le mana manque, pas
// quand le joueur appuie pour rien.
{
  const r = new Realm({ alea: alea(240) }); r.monstres = [];
  const j = r.rejoint(A, { ...FICHE, statFruit: 'wis',
                           stats: { hp: 400, mp: 250, att: 28, def: 13, vit: 20, wis: 30 } });
  const e = r.etatPour(A, 1400);
  eq(e.moi.mpMax, 250, 'la reserve de mana part avec l etat');
  eq(e.moi.mp, 250, 'et ce qu il en reste');
  eq(e.moi.po, 'stase', 'le pouvoir aussi');
  eq(e.moi.poR, 0, 'et sa recharge');

  r.pouvoir(A, { touches: [], kills: [] });
  const e2 = r.etatPour(A, 1400);
  ok(e2.moi.mp < 250, 'le mana depense se voit tout de suite');
  ok(e2.moi.poR > 0, 'la recharge aussi');

  /* Sans fruit, le client doit savoir qu il n y a rien a montrer. */
  const r2 = new Realm({ alea: alea(241) }); r2.monstres = [];
  r2.rejoint(B, FICHE);
  eq(r2.etatPour(B, 1400).moi.po, null, 'sans fruit, aucun pouvoir annonce');
}

console.log('realm.test.js : ' + n + ' verifications OK');
