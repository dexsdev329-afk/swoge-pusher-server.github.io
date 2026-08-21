'use strict';
/*
 * LES BALISES — abattre les gardiens ouvre une route, pour tout le monde.
 *
 * Une salle gardee promettait un coffre et rien d'autre : on la faisait une
 * fois, on prenait le sac, on n'y revenait jamais. Elle devient un point de
 * voyage.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. ELLE NE S'ALLUME QU'UNE FOIS LES GARDIENS MORTS. Sinon la route est
 *    gratuite, et le monde de 7680 unites se traverse sans jamais rien
 *    affronter.
 * 2. ELLE NE S'ETEINT PLUS. Le coffre se rearme au bout de six minutes ; la
 *    balise, non. Une route qui se referme derriere soi n'est pas une route.
 * 3. ELLE APPARTIENT AU MONDE, PAS AU JOUEUR. Celui qui l'allume ouvre le
 *    raccourci pour tous ceux qui arriveront apres — c'est la premiere chose
 *    de ce jeu qu'on soit content de voir faite par quelqu'un d'autre.
 * 4. ON N'ARRIVE PAS AU CENTRE. Au centre il y a le coffre, et sur une salle
 *    rearmee, ses gardiens.
 * 5. UN DONJON N'EN A PAS. Il n'a pas de salles gardees, et en sortir par une
 *    balise contournerait la porte du retour.
 */
const assert = require('assert');
const { Realm } = require('./realm');
const M = require('./monde');
const P = require('./personnages');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; console.log('  ok   ' + m); };
function alea(g) { let s = g >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const FICHE = { skin: 'andy', nom: 'X', famille: 'lame',
                degats: P.DEGATS_ARME.commun,
                stats: { hp: 900, mp: 300, att: 40, def: 20 } };
const PIECE = (r) => ({ item: 1, cle: 'x', nom: 'X', rarete: r });

function monde0(graine) {
  return new Realm({ alea: alea(graine || 1), tireObjet: (r) => PIECE(r) });
}
/* On vide la salle comme le ferait un combat : ses gardiens quittent la
   liste. Le chemin par lequel ils meurent ne regarde pas la balise — c'est
   ce qui lui evite d'etre oubliee dans une des six boucles de combat. */
function vide(R, s) {
  R.monstres = R.monstres.filter((m) => m.salle !== s.i);
  const ev = {};
  R._pasSalles(0.1, ev);
  return ev;
}

// ================== 1. ETEINTE AU DEPART
console.log('\n-- au depart, tout est eteint --');
{
  const R = monde0(1);
  ok(R.salles.length >= 2, `le monde a des salles gardees (${R.salles.length})`);
  eq(R.salles.every((s) => !s.balise), true, 'aucune balise allumee');
  R.rejoint(A, FICHE);
  const vue = R.etatPour(A, 1400);
  eq(vue.balises.length, R.salles.length, 'elles sont TOUTES annoncees au client');
  eq(vue.balises.every((b) => !b.on), true, 'et toutes eteintes');
  /* On ne peut pas y aller. */
  eq(R.vaALaBalise(A, R.salles[0].i), null, 'et on ne peut pas s y rendre');
}

// ================== 2. LES GARDIENS MORTS L ALLUMENT
console.log('\n-- on abat les gardiens --');
{
  const R = monde0(2);
  R.rejoint(A, FICHE);
  const s = R.salles[0];
  const ev = vide(R, s);
  eq(s.balise, true, 'la salle videe allume sa balise');
  ok(ev.balises && ev.balises.length === 1, 'et l evenement l annonce');
  eq(ev.balises[0].i, s.i, 'en nommant la salle');
  ok(ev.balises[0].biome, `et l anneau ou elle se trouve (${ev.balises[0].biome})`);
  /* UNE SEULE FOIS : l'evenement ne doit pas repartir a chaque pas tant que
     la salle est vide, sinon c'est dix annonces par seconde. */
  const ev2 = {};
  R._pasSalles(0.1, ev2);
  ok(!ev2.balises, 'et elle ne s annonce pas une deuxieme fois');
}

// ================== 3. ELLE NE S ETEINT PLUS
console.log('\n-- le coffre se rearme, la balise non --');
{
  const R = monde0(3);
  R.rejoint(A, FICHE);
  const s = R.salles[0];
  vide(R, s);
  eq(s.balise, true, 'allumee');
  /* Six minutes plus tard, les gardiens reviennent. On s'ecarte pour qu'ils
     puissent renaitre — sinon la salle attend qu'on sorte. */
  const j = R.joueurs.get(A.toLowerCase());
  j.x = 40; j.y = 40;
  for (let t = 0; t < M.SALLE.rearme + 20; t += 1) R._pasSalles(1, {});
  eq(s.vide, false, 'la salle s est rearmee');
  ok(R.monstres.some((m) => m.salle === s.i), 'ses gardiens sont revenus');
  eq(s.balise, true, 'et la balise est TOUJOURS allumee : une route ne se referme pas');
  ok(R.vaALaBalise(A, s.i), 'on peut toujours s y rendre');
}

// ================== 4. ELLE EST AU MONDE, PAS AU JOUEUR
console.log('\n-- allumee par l un, ouverte a tous --');
{
  const R = monde0(4);
  R.rejoint(A, FICHE);
  const s = R.salles[0];
  vide(R, s);
  /* B arrive APRES et n'a rien fait. La route est ouverte pour lui aussi. */
  R.rejoint(B, FICHE);
  const r = R.vaALaBalise(B, s.i);
  ok(r, 'un joueur arrive ensuite en profite sans avoir combattu');
  eq(R.etatPour(B, 1400).balises.find((b) => b.i === s.i).on, 1,
     'et il la voit allumee');
}

// ================== 5. OU L ON ARRIVE
console.log('\n-- on arrive au bord --');
{
  const R = monde0(5);
  R.rejoint(A, FICHE);
  const s = R.salles[0];
  vide(R, s);
  const j = R.joueurs.get(A.toLowerCase());
  j.x = 100; j.y = 100;
  const loin = Math.hypot(j.x - s.x, j.y - s.y);
  const r = R.vaALaBalise(A, s.i);
  ok(r, 'le voyage est accepte');
  const d = Math.hypot(j.x - s.x, j.y - s.y);
  ok(d < loin, `on a traverse la carte (${Math.round(loin)} -> ${Math.round(d)})`);
  /* PAS AU CENTRE : au centre il y a le coffre, et sur une salle rearmee, ses
     gardiens. */
  ok(d > M.SALLE.cote * M.TUILE / 2,
     `et on arrive hors de la salle (${Math.round(d)} unites du centre)`);
  ok(!M.dansLaSalle(s, j.x, j.y), 'donc jamais au milieu des gardiens');
  /* Dans les bornes du monde, toujours. */
  ok(j.x >= 0 && j.x <= M.MONDE.w && j.y >= 0 && j.y <= M.MONDE.h,
     'et dans la carte');
}

// ================== 6. UN NUMERO INCONNU NE FAIT RIEN
console.log('\n-- ce qu on ne peut pas demander --');
{
  const R = monde0(6);
  R.rejoint(A, FICHE);
  eq(R.vaALaBalise(A, 9999), null, 'une salle qui n existe pas : refuse');
  eq(R.vaALaBalise('0x' + 'ff'.repeat(20), R.salles[0].i), null,
     'un joueur qui n est pas dans ce monde : refuse');
  /* La salle existe mais n est pas allumee. C est LE refus qui compte : sans
     lui, le client nomme un numero et traverse la carte gratuitement. */
  eq(R.vaALaBalise(A, R.salles[0].i), null, 'une balise eteinte : refuse');
}

// ================== 7. UN DONJON N EN A PAS
console.log('\n-- pas de balise en donjon --');
{
  const D = new Realm({ alea: alea(7), plan: M.planDeDonjon('forge', alea(7)),
                        tireObjet: (r) => PIECE(r) });
  D.rejoint(A, FICHE);
  eq(D.salles.length, 0, 'un donjon n a pas de salles gardees');
  eq(D.etatPour(A, 1400).balises.length, 0, 'donc aucune balise a annoncer');
  eq(D.vaALaBalise(A, 0), null, 'et rien ou se rendre');
}


/* ================== DEVANT LA PORTE, ET NULLE PART AILLEURS ==================
 *
 * Chaque salle gardee a UNE ouverture, sur un cote tire au sort. La balise
 * etait posee au sud pour tout le monde : sur les trois quarts des salles elle
 * se retrouvait donc DERRIERE un mur, et l'on se teleportait a un endroit d'ou
 * il faut faire le tour de la piece. Le joueur l'a vu avant l'essai — c'est ce
 * genre de chose qu'un essai qui ne regarde qu'une salle ne peut pas voir.
 *
 * On les regarde donc TOUTES, sur soixante mondes.
 */
console.log('\n-- la balise est devant la porte de sa salle --');
{
  const COTES = { nord: [0, -1], sud: [0, 1], ouest: [-1, 0], est: [1, 0] };
  let salles = 0, bonCote = 0, dansUnMur = 0, dansLaSalle = 0;
  for (let g = 1; g <= 60; g++) {
    let x = g * 7919;
    const al = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
    const R = new Realm({ alea: al });
    for (const s of R.salles) {
      salles++;
      const p = R.pointDeBalise(s);
      const d = COTES[s.porte] || COTES.sud;
      /* Du bon COTE : la porte est au milieu d'un cote, la balise doit etre
         dehors, en face. On tolere le decalage lateral — un rocher peut avoir
         oblige a s'ecarter — mais jamais le mauvais cote. */
      const okX = d[0] === 0 || Math.sign(p.x - s.x) === d[0];
      const okY = d[1] === 0 || Math.sign(p.y - s.y) === d[1];
      if (okX && okY) bonCote++;
      if (M.bloque(R.obstacles, p.x, p.y, 22)) dansUnMur++;
      const demi = M.SALLE.cote * M.TUILE / 2;
      if (Math.abs(p.x - s.x) < demi && Math.abs(p.y - s.y) < demi) dansLaSalle++;
    }
  }
  eq(bonCote, salles, `les ${salles} balises sont devant leur porte`);
  eq(dansUnMur, 0, 'aucune ne tombe dans un rocher — on s y teleporterait dans la pierre');
  eq(dansLaSalle, 0, 'aucune n est DANS la salle — on s y poserait sur le coffre');
}

/* ---- LE DESSIN ET LA TELEPORTATION, AU MEME ENDROIT ---- */
console.log('\n-- ou la page la voit, on y arrive --');
{
  const R = new Realm({ alea: alea(21) });
  const j = R.rejoint(A, FICHE);
  const s = R.salles[0];
  s.balise = true;
  const vue = R.etatPour(A).balises.find((b) => b.i === s.i);
  ok(!!vue, 'la page recoit la balise');
  const arrivee = R.vaALaBalise(A, s.i);
  ok(!!arrivee, 'et la teleportation marche');
  eq(Math.round(vue.x), Math.round(arrivee.x), 'le meme x que la ou on arrive');
  eq(Math.round(vue.y), Math.round(arrivee.y), 'et le meme y');
}

console.log(`\nbalise.test.js — ${n} verifications, 0 echec(s)`);