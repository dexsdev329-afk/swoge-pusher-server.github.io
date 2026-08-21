'use strict';
/*
 * OPTIMUS DOIT TOUJOURS EXISTER QUELQUE PART.
 *
 * « Je l'ai tue une fois, je le vois plus depuis. »
 *
 * Il pese 0,12 sur les cinq et quelques de l'anneau de lave : deux pour cent
 * de dix-huit places, soit 0,38 vivant en moyenne — donc AUCUN dans le monde
 * deux fois sur trois. Et comme le repeuplement tire une creature au hasard
 * dans la table du monde entier, en abattre un revenait a en attendre quatre
 * cents autres avant d'en revoir un.
 *
 * Ce n'est pas un probleme de rarete, c'est un probleme de PLANIFICATION : il
 * est la seule porte de la Fonderie. « Je vais chercher Optimus » doit etre un
 * projet, pas un pari sur la composition du monde.
 *
 * Quatre choses a tenir, et elles se cassent differemment :
 *
 * 1. IL Y EN A TOUJOURS UN. Sinon la Fonderie est fermee sans que rien ne le
 *    dise.
 * 2. IL N'Y EN A JAMAIS DEUX. Un socle qui empile ferait de l'anneau de lave
 *    un elevage d'Optimus, et un donjon a butin GARANTI une chaine de montage.
 * 3. IL NE RENAIT PAS TOUT DE SUITE. Sans delai, un joueur poste sur la
 *    depouille en enchaine un toutes les secondes.
 * 4. LE DELAI NE COURT QUE PENDANT QU'IL EST MORT. Un compte a rebours qui
 *    tourne pendant qu'il vit ferait apparaitre son remplacant a la seconde
 *    ou on l'abat, ce qui revient a ne pas avoir de delai du tout.
 */
const assert = require('assert');
const { Realm } = require('./realm');
const M = require('./monde');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; console.log('  ok   ' + m); };

function alea(graine) {
  let s = graine >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const compte = (R, esp) => R.monstres.filter((m) => m.espece === esp && !m.salle).length;
const P = require('./personnages');
const FICHE = { skin: 'andy', nom: 'Dodexel', famille: 'lame',
                degats: P.DEGATS_ARME.mythique,
                stats: { hp: 900, mp: 300, att: 60, def: 40, spd: 20, dex: 20 } };
/* Un joueur present : `repeuple` ne tourne que pour un monde habite, et le
   serveur ne l'appelle que s'il a des clients. On passe par `rejoint`, pas par
   un objet bricole : c'est la simulation entiere qui va tourner dessus. */
function habite(R, ou) {
  R.rejoint('0x' + '11'.repeat(20), FICHE, ou || null);
  return R;
}
/* On avance le temps comme le serveur : par tours de simulation, en
   repeuplant entre deux. Sauter directement a `socleAttente = 0` testerait le
   champ, pas la regle. */
function attend(R, secondes) {
  for (let t = 0; t < secondes; t += 0.5) { R.pas(0.5); R.repeuple(900); }
}

// ================== 1. LE MONDE EN A TOUJOURS UN
console.log('\n-- il y en a toujours un --');
{
  /* Plusieurs graines : une seule prouverait qu'on a eu de la chance. */
  const trouves = [];
  for (const g of [1, 2, 3, 7, 11, 19, 23]) {
    const R = habite(new Realm({ alea: alea(g) }));
    R.repeuple(900);
    trouves.push(compte(R, 'optimus'));
  }
  ok(trouves.every((c) => c === 1),
     `sept mondes tires au hasard, un Optimus dans chacun (${trouves.join(',')})`);

  /* ---- ET IL EST DANS SON ANNEAU ----
   * Le poser n'importe ou reviendrait a mettre un boss de lave dans l'herbe
   * de depart, ou un joueur de niveau trois le croiserait. */
  const R = habite(new Realm({ alea: alea(5) }));
  R.repeuple(900);
  const o = R.monstres.find((m) => m.espece === 'optimus');
  eq(M.biomeEn(o.x, o.y), 'lave', `et il nait dans la lave (${M.biomeEn(o.x, o.y)})`);
  /* Pas dans un rocher : un colosse ne dans un bloc y resterait pour toujours,
     immobile, et se lirait comme un monstre casse. */
  ok(!M.bloque(R.obstacles, o.x, o.y, M.MONSTRES.optimus.rayon), 'et pas dans un rocher');
}

// ================== 2. JAMAIS DEUX
console.log('\n-- jamais deux --');
{
  const R = habite(new Realm({ alea: alea(4) }));
  for (let i = 0; i < 60; i++) { R.pas(0.5); R.repeuple(900); }
  eq(compte(R, 'optimus'), 1,
     `trente secondes de repeuplement n en empilent pas (${compte(R, 'optimus')})`);
}

// ================== 3. IL NE RENAIT PAS TOUT DE SUITE
console.log('\n-- le delai apres sa mort --');
{
  const R = habite(new Realm({ alea: alea(6) }));
  R.repeuple(900);
  eq(compte(R, 'optimus'), 1, 'un Optimus au depart');
  /* On l'abat — c'est-a-dire qu'il quitte la liste, quelle qu'ait ete l'arme.
     Le socle regarde le MONDE, pas le chemin par lequel la creature est
     morte : c'est ce qui lui evite d'etre oublie dans une des six boucles de
     combat. */
  R.monstres = R.monstres.filter((m) => m.espece !== 'optimus');
  R.repeuple(900);
  eq(compte(R, 'optimus'), 0, 'abattu, il ne revient pas dans la seconde');

  const delai = M.SOCLE_DELAI.optimus;
  attend(R, delai * 0.5);
  eq(compte(R, 'optimus'), 0,
     `ni a la moitie du delai (${Math.round(delai * 0.5)} s sur ${delai})`);
  attend(R, delai * 0.6 + 2);
  eq(compte(R, 'optimus'), 1, `mais il revient une fois le delai passe (${delai} s)`);
}

// ================== 4. LE DELAI NE COURT QUE PENDANT QU IL EST MORT
console.log('\n-- le compte a rebours ne court pas de son vivant --');
{
  const R = habite(new Realm({ alea: alea(8) }));
  R.repeuple(900);
  /* Il vit, et on laisse passer BEAUCOUP plus que le delai. Si le compte a
     rebours tournait pendant ce temps-la, son remplacant apparaitrait a la
     seconde ou on l abat — c est-a-dire qu il n y aurait pas de delai. */
  attend(R, M.SOCLE_DELAI.optimus * 2);
  eq(compte(R, 'optimus'), 1, 'il vit toujours, seul');
  R.monstres = R.monstres.filter((m) => m.espece !== 'optimus');
  attend(R, M.SOCLE_DELAI.optimus * 0.5);
  eq(compte(R, 'optimus'), 0,
     'et apres sa mort le delai repart de zero, pas de la ou il en etait');
  attend(R, M.SOCLE_DELAI.optimus * 0.6 + 2);
  eq(compte(R, 'optimus'), 1, 'puis il revient');
}

// ================== 5. PAS DANS UN DONJON
console.log('\n-- pas dans le donjon --');
{
  const R = new Realm({ alea: alea(9), plan: M.planDeDonjon('forge', alea(9)),
                        tireObjet: () => ({ item: 1, cle: 'x', nom: 'X', rarete: 'relique' }) });
  habite(R);
  for (let i = 0; i < 40; i++) { R.pas(0.5); R.repeuple(900); }
  eq(compte(R, 'optimus'), 0,
     'un donjon ne fait naitre personne : il se VIDE, c est ce qui en fait une expedition');
}

// ================== 6. IL OUVRE TOUJOURS LA PORTE
console.log('\n-- et il ouvre toujours la Fonderie --');
{
  /* Le socle serait sans objet si la creature garantie n etait pas celle qui
     ouvre le donjon. On le relit dans la table plutot que de le supposer. */
  ok(M.PORTAIL_DE.optimus, `Optimus ouvre bien un donjon (${M.PORTAIL_DE.optimus})`);
  ok(M.SOCLE.optimus >= 1, 'et c est lui qui a un socle');
  for (const esp of Object.keys(M.SOCLE)) {
    ok(M.biomeDe(esp), `${esp} a un anneau ou naitre (${M.biomeDe(esp)})`);
    ok(M.MONSTRES[esp], `${esp} est une espece connue`);
  }
}

// ================== 7. LE CHASSEUR NE BLOQUE PLUS SA PROIE
/*
 * C'EST LE DEFAUT QUI A ETE SIGNALE, et il ne ressemble pas a une rarete.
 *
 * `repeuple` refuse toute naissance a moins de 900 unites d'un joueur. La lave
 * est un DISQUE de 768 unites de rayon : aucun de ses points n'est a 900 d'un
 * joueur qui s'y trouve. Autrement dit, tant qu'on chassait dans la lave,
 * aucune creature de lave ne pouvait y renaitre — et le joueur qui cherchait
 * Optimus etait precisement celui qui l'empechait d'exister.
 */
console.log('\n-- le chasseur ne bloque plus sa proie --');
{
  const rayonLave = M.ANNEAUX[0].jusqua * (M.MONDE.w / 2);
  ok(rayonLave < 900,
     `l anneau de lave est plus PETIT que la regle des 900 (rayon ${Math.round(rayonLave)})`);
  const ecart = M.ecartDeNaissance('optimus', 900);
  ok(ecart < 900 && ecart > M.MONSTRES.optimus.zone.rayon * 2,
     `l ecart s adapte a l anneau sans laisser naitre sous le nez (${ecart} unites)`);

  const R = new Realm({ alea: alea(12) });
  /* Le pire cas : le joueur au centre EXACT du disque de lave. C'est de la
     que tous les points de l anneau sont le plus pres de lui. */
  habite(R, { x: M.CENTRE.x, y: M.CENTRE.y });
  const j = R.joueurs.values().next().value;
  eq(M.biomeEn(j.x, j.y), 'lave', 'le joueur campe au milieu de la lave');
  R.repeuple(900);
  R.monstres = R.monstres.filter((m) => m.espece !== 'optimus');
  /* On mesure AU MOMENT DE LA NAISSANCE. Deux cents secondes plus tard, il a
     marche : lire sa position a ce moment-la dirait ou il en est de sa
     promenade, pas ou le monde l a pose. */
  let o = null;
  for (let t = 0; t < M.SOCLE_DELAI.optimus + 40 && !o; t += 1) {
    attend(R, 1);
    o = R.monstres.find((m) => m.espece === 'optimus') || null;
  }
  ok(!!o, 'et Optimus renait quand meme : c est la regle qui cede, pas le boss');
  const d = Math.round(Math.hypot(o.x - j.x, o.y - j.y));
  ok(d >= ecart, `sans apparaitre dans son dos (${d} unites, minimum ${ecart})`);
  /* Et il nait DANS la lave : un ecart obtenu en le poussant dans les cendres
     mettrait un boss de fin dans l anneau d a cote. */
  eq(M.biomeEn(o.x, o.y), 'lave', 'et sans sortir de son anneau');
}

// ================== 8. ET L ANNEAU ENTIER SE REMPLIT A NOUVEAU
/*
 * Le meme defaut ne touchait pas qu'Optimus : AUCUNE creature de lave ne
 * pouvait renaitre tant qu'un joueur etait dans la lave. L'anneau le plus dur
 * du jeu se vidait a mesure qu'on le nettoyait et ne se remplissait qu'une
 * fois qu'on l'avait quitte — c'est-a-dire quand ca ne servait plus a rien.
 */
console.log('\n-- et l anneau de lave se remplit pendant qu on y est --');
{
  const R = new Realm({ alea: alea(31) });
  habite(R, { x: M.CENTRE.x, y: M.CENTRE.y });
  const dansLaLave = () => R.monstres.filter(
    (m) => !m.salle && M.biomeEn(m.x, m.y) === 'lave').length;
  R.repeuple(900);
  const avant = dansLaLave();
  ok(avant > 0, `la lave est peuplee au depart (${avant})`);
  /* On la nettoie, comme un joueur qui y campe. */
  R.monstres = R.monstres.filter((m) => m.salle || M.biomeEn(m.x, m.y) !== 'lave');
  eq(dansLaLave(), 0, 'on la vide entierement');
  for (let i = 0; i < 400; i++) R.repeuple(900);
  const apres = dansLaLave();
  ok(apres >= Math.floor(avant / 2),
     `elle se remplit sans qu on ait besoin de partir (${apres} sur ${avant})`);
}

console.log(`\noptimus.test.js — ${n} verifications, 0 echec(s)`);
