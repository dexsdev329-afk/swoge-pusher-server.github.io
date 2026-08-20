'use strict';
/*
 * L'ATTAQUE DE ZONE — le seul coup du jeu qu'on n'esquive pas en se decalant.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE CERCLE EST L'ATTAQUE. Une zone qui frappe sans avoir ete annoncee
 *    n'est pas difficile, elle est arbitraire. Tout ce fichier tourne autour
 *    de ce point : le delai existe, il est envoye a la page, et il est ASSEZ
 *    LONG pour que le personnage le plus lent du jeu en sorte.
 * 2. ELLE TOMBE SUR LES PIEDS DU JOUEUR, jamais devant lui. Viser ou il va
 *    serait un piege sans reponse ; posee sur lui, la reponse est toujours la
 *    meme et toujours disponible — partir.
 * 3. TUER LE MONSTRE N'ANNULE PAS LE COUP. Sinon la meilleure reponse a une
 *    zone serait de tirer plus fort, ce qu'elle doit justement empecher.
 * 4. MARQUER ET FRAPPER SONT DEUX MECANIQUES. Le monstre marque ; la zone
 *    frappe toute seule. Les deux sont testees separement parce qu'elles ne
 *    se parlent pas.
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
const FICHE = { skin: 'andy', nom: 'Dodexel', famille: 'lame',
                degats: P.DEGATS_ARME.commun,
                stats: { hp: 4000, mp: 300, att: 28, def: 13 } };

const AVEC_ZONE = Object.keys(M.MONSTRES).filter((k) => M.MONSTRES[k].zone);
/* Rempli par l'essai 2 : la forme exacte d'une zone, relevee sur une vraie. */
let MODELE = null;

// ================== 1. LA REGLE : ON PEUT TOUJOURS EN SORTIR
//
// C'est la seule chose qui separe une attaque de zone d'une taxe. Le calcul
// n'est pas une opinion : la zone tombe sur les pieds du joueur, donc il part
// du centre, donc il a exactement `rayon` a couvrir.
{
  ok(AVEC_ZONE.length >= 4, `${AVEC_ZONE.length} creatures frappent au sol`);

  /* Le plus lent du jeu, pas le plus lent qu'on imagine : on le CALCULE. Si
     un jour un personnage plus lourd arrive, ce test se met a jour tout seul
     et refuse les zones devenues injustes. */
  let vmin = Infinity, lent = '';
  for (const k of Object.keys(P.BASE)) {
    const v = M.vitesseDe(P.statAuNiveau(P.BASE[k].spd, 1));
    if (v < vmin) { vmin = v; lent = k; }
  }
  ok(vmin > 0, `le personnage le plus lent du jeu est ${lent}, a ${vmin.toFixed(0)} u/s`);

  for (const k of AVEC_ZONE) {
    const z = M.MONSTRES[k].zone;
    ok(z.annonce > 0, `« ${M.MONSTRES[k].nom} » annonce son coup (${z.annonce} s)`);
    ok(z.rayon > 0, 'et il a un rayon');
    const exige = z.rayon / vmin + M.ZONE_REACTION;
    ok(z.annonce >= exige,
       `${k} : ${z.annonce} s d'annonce pour ${z.rayon} u — il en faut ${exige.toFixed(2)}`);
    /* ET PAS TROP LONGUE. Une annonce de trois secondes serait une attaque
       qu'on ignore : on en sort en marchant, sans jamais avoir a choisir. */
    ok(z.annonce < exige + 0.6,
       `${k} : et pas si longue qu'on en sorte sans y penser (marge ${(z.annonce - exige).toFixed(2)} s)`);
  }

  /* LE COUP FAIT MAL. Une zone qu'on peut encaisser pour continuer a tirer
     est une zone qu'on encaissera toujours. */
  for (const k of AVEC_ZONE) {
    const t = M.MONSTRES[k];
    ok(t.zone.att >= t.tir.att,
       `« ${t.nom} » : rester dans le cercle coute plus cher qu'un de ses tirs (${t.zone.att} contre ${t.tir.att})`);
  }

  /* CE N'EST PAS UNE ATTAQUE ORDINAIRE. Une creature commune qui frappe au
     sol remplirait la carte de cercles, et le geste perdrait son sens. Toutes
     les porteuses sont donc rares : soit un boss, soit un poids qui les rend
     rares la ou elles vivent. */
  for (const k of AVEC_ZONE) {
    const t = M.MONSTRES[k];
    const rare = M.BOSS[k] || t.biomes.every((b) => {
      const p = M.PEUPLEMENT[b];
      return p.poids && p.poids[k] !== undefined && p.poids[k] < 1;
    });
    ok(rare, `« ${t.nom} » ne se croise pas a tous les coins de carte`);
  }

  /* L'EFFET, QUAND IL Y EN A UN, EXISTE VRAIMENT. Un `effet: 'gel'` mal
     orthographie ne planterait rien : `_poseEtat` rendrait false, en silence,
     et la moitie de l'attaque disparaitrait sans laisser de trace. */
  for (const k of AVEC_ZONE) {
    const e = M.MONSTRES[k].zone.effet;
    if (!e) continue;
    ok(M.EFFETS[e], `l'effet « ${e} » de ${k} est un vrai effet`);
  }
}

// ================== 2. LE MONSTRE MARQUE LE SOL
{
  const r = new Realm({ alea: alea(11) });
  const j = r.rejoint(A, FICHE);
  const t = M.MONSTRES.brasier;
  /* Assez loin pour qu'il n'arrive jamais au contact pendant l'essai, assez
     pres pour qu'il marque : la fenetre est `zone.rayon * 3`. */
  r.monstres = [{ id: 1, espece: 'brasier', biome: 'lave', x: j.x + 400, y: j.y,
                  ancreX: j.x + 400, ancreY: j.y, pv: t.pv, pvMax: t.pv,
                  dir: 'down', cible: null, recharge: 0, rechargeT: 0,
                  stase: 0, errX: 0, errY: 0, errChrono: 0 }];

  /* IL NE MARQUE PAS AU PREMIER PAS. Sinon un monstre qui entre dans la vue
     poserait son cercle dans le meme dixieme de seconde, sans qu'on ait pu
     le voir arriver. */
  const ev0 = r.pas(0.1);
  eq(ev0.marques.length, 0, 'il ne marque pas des la premiere image');

  let marques = 0, chrono = 0;
  for (let i = 0; i < 60 && !marques; i++) { chrono += 0.1; marques += r.pas(0.1).marques.length; }
  eq(marques, 1, `il finit par marquer (au bout de ${chrono.toFixed(1)} s)`);
  eq(r.zones.length, 1, 'et la zone existe dans la simulation');

  const z = r.zones[0];
  ok(Math.abs(z.x - j.x) < 1 && Math.abs(z.y - j.y) < 1,
     'le cercle est pose SUR le joueur, pas devant lui');
  eq(z.r, t.zone.rayon, 'avec le rayon de l espece');
  eq(z.att, t.zone.att, 'et sa force');
  eq(z.effet, 'brulure', 'et sa brulure');
  eq(z.espece, 'brasier', 'et son nom, pour que la page sache quoi peindre');
  eq(z.duree, t.zone.annonce, 'le cercle porte la duree totale de l annonce');
  ok(z.reste > 0 && z.reste <= z.duree, 'et ce qu il en reste');

  /* LE MODELE. Les essais qui suivent posent des zones a la main pour tester
     ce qu'elles font en frappant. S'ils inventaient leur propre forme, ils
     continueraient de passer le jour ou la vraie forme change. On releve donc
     celle-ci, une fois, et on la leur impose. */
  MODELE = Object.keys(z).sort();

  /* IL N'EN POSE PAS UNE PAR IMAGE. `cadence` est tout ce qui separe une
     attaque d'un tapis de cercles. */
  const debut = r.zones.length;
  let posees = 0;
  for (let i = 0; i < 100; i++) posees += r.pas(0.1).marques.length;   // dix secondes
  const attendues = 10 * t.zone.cadence;
  ok(posees >= attendues - 1 && posees <= attendues + 1,
     `en dix secondes il en pose ${posees}, la cadence en promet ${attendues.toFixed(1)}`);
  ok(debut >= 0, 'et la file ne grossit pas indefiniment');
  ok(r.zones.length <= Math.ceil(t.zone.annonce * t.zone.cadence) + 1,
     `il n en reste qu une poignee en attente (${r.zones.length})`);

  /* HORS DE VUE, PAS DE CERCLE. Un monstre qui marque le sol a l'autre bout
     de la carte est un monstre qui frappe quelqu'un qui ne sait pas qu'il
     existe. */
  {
    const r2 = new Realm({ alea: alea(12) });
    const j2 = r2.rejoint(A, FICHE);
    r2.monstres = [{ id: 1, espece: 'brasier', biome: 'lave',
                     x: j2.x + t.vue + 200, y: j2.y,
                     ancreX: j2.x + t.vue + 200, ancreY: j2.y, pv: t.pv, pvMax: t.pv,
                     dir: 'down', cible: null, recharge: 0, rechargeT: 0,
                     stase: 0, errX: 0, errY: 0, errChrono: 0 }];
    let m2 = 0;
    for (let i = 0; i < 200; i++) m2 += r2.pas(0.1).marques.length;
    eq(m2, 0, 'un brasier qui ne voit personne ne marque rien');
    eq(r2.zones.length, 0, 'et rien ne l attend au sol');
  }

  /* FIGE, IL NE MARQUE PAS. La stase arrete un monstre : si elle n'arretait
     que ses jambes, le pouvoir mentirait sur ce qu'il fait. */
  {
    const r3 = new Realm({ alea: alea(13) });
    const j3 = r3.rejoint(A, FICHE);
    r3.monstres = [{ id: 1, espece: 'brasier', biome: 'lave', x: j3.x + 400, y: j3.y,
                     ancreX: j3.x + 400, ancreY: j3.y, pv: t.pv, pvMax: t.pv,
                     dir: 'down', cible: null, recharge: 0, rechargeT: 0,
                     stase: 30, errX: 0, errY: 0, errChrono: 0 }];
    let m3 = 0;
    for (let i = 0; i < 200; i++) m3 += r3.pas(0.1).marques.length;
    eq(m3, 0, 'un brasier fige ne marque pas le sol');
  }

}
ok(MODELE, `la forme d une zone est relevee : ${MODELE.join(', ')}`);

/* Poser une zone a la main, avec EXACTEMENT la forme que la simulation
   produit. `id` mis a part, tout vient de l'espece. */
function poseZone(r, espece, x, y) {
  const z = M.MONSTRES[espece].zone;
  const o = { id: r._nouvelId(), x, y, r: z.rayon, att: z.att,
              effet: z.effet || null, espece,
              reste: z.annonce, duree: z.annonce };
  assert.deepStrictEqual(Object.keys(o).sort(), MODELE,
    'la zone posee a la main a la meme forme que celle du monstre');
  r.zones.push(o);
  return o;
}

// ================== 3. LE CERCLE ATTEND, PUIS FRAPPE
{
  const r = new Realm({ alea: alea(21) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];                 // la zone frappe seule : rien d autre ici
  const t = M.MONSTRES.machine;
  poseZone(r, 'machine', j.x, j.y);
  eq(Object.keys(r.zones).length, 1, 'une zone attend');

  /* ELLE NE FRAPPE PAS TOUT DE SUITE. C'est toute la difference avec un coup
     au contact — et c'est ce que le joueur voit du cercle qui se remplit. */
  const pv0 = j.pv;
  let ecoule = 0;
  while (ecoule < t.zone.annonce - 0.15) { r.pas(0.1); ecoule += 0.1; }
  eq(j.pv, pv0, `apres ${ecoule.toFixed(1)} s d annonce, elle n a pas encore frappe`);
  eq(r.zones.length, 1, 'et elle attend toujours');

  const ev = (() => { let e; for (let i = 0; i < 5; i++) { e = r.pas(0.1); if (e.zones.length) return e; } return e; })();
  eq(ev.zones.length, 1, 'au bout de l annonce, elle frappe');
  eq(r.zones.length, 0, 'et elle disparait : un cercle ne frappe pas deux fois');
  eq(ev.zones[0].espece, 'machine', 'l evenement dit d ou vient le coup');
  eq(ev.zones[0].r, t.zone.rayon, 'et son rayon, pour la peindre au bon endroit');

  const perte = M.degatsSubis(t.zone.att, j.def);
  eq(j.pv, pv0 - perte, `le joueur reste dedans et prend ${perte} degats`);
  const d = ev.degats.find((x) => x.quoi === 'zone');
  ok(d, 'le coup est rendu comme un degat, pas comme un silence');
  eq(d.par, 'machine', 'en nommant la creature');
  eq(d.perte, perte, 'avec la perte exacte');
  eq(d.pv, j.pv, 'et la vie qui reste');
}

// ================== 4. EN SORTIR SUFFIT
//
// Le contraire de l essai precedent, et la raison d etre du delai.
{
  const r = new Realm({ alea: alea(22) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];
  const t = M.MONSTRES.brasier;
  const cx = j.x, cy = j.y;
  poseZone(r, 'brasier', cx, cy);

  const pv0 = j.pv;
  /* On marche VERS LA DROITE a la vitesse du plus lent — pas a celle d'andy :
     ce qu'on veut prouver, c'est que meme lui s'en sort. */
  let vmin = Infinity;
  for (const k of Object.keys(P.BASE)) vmin = Math.min(vmin, M.vitesseDe(P.statAuNiveau(P.BASE[k].spd, 1)));
  /* Et il ne part pas a l'image ou le cercle apparait : il le VOIT d'abord. */
  let ecoule = 0;
  while (ecoule < M.ZONE_REACTION) { r.pas(0.05); ecoule += 0.05; }
  let ev = null;
  for (let i = 0; i < 60 && !ev; i++) {
    r.bouge(A, j.x + vmin * 0.05, j.y, 'right', 'run', 0.05);
    const e = r.pas(0.05);
    if (e.zones.length) ev = e;
  }
  ok(ev, 'la zone a bien fini par frapper');
  const dist = Math.hypot(j.x - cx, j.y - cy);
  ok(dist > t.zone.rayon,
     `il est sorti du cercle a temps (${dist.toFixed(0)} u pour un rayon de ${t.zone.rayon})`);
  eq(j.pv, pv0, 'et il n a rien pris');
  eq(ev.degats.filter((x) => x.quoi === 'zone').length, 0, 'aucun degat de zone rendu');
}

// ================== 5. TUER LE LANCEUR N ANNULE RIEN
//
// La faute qu on veut rendre impossible : faire de « tirer plus fort » la
// reponse a une attaque dont le but est d obliger a arreter de tirer.
{
  const r = new Realm({ alea: alea(23) });
  const j = r.rejoint(A, FICHE);
  const t = M.MONSTRES.carapace;
  r.monstres = [{ id: 1, espece: 'carapace', biome: 'neige', x: j.x + 400, y: j.y,
                  ancreX: j.x + 400, ancreY: j.y, pv: t.pv, pvMax: t.pv,
                  dir: 'down', cible: null, recharge: 0, rechargeT: 0,
                  stase: 0, errX: 0, errY: 0, errChrono: 0 }];
  let pose = false;
  for (let i = 0; i < 100 && !pose; i++) pose = r.pas(0.05).marques.length > 0;
  ok(pose, 'la carapace a marque le sol');

  r.monstres[0].pv = 0;             // on l abat pendant l annonce
  const pv0 = j.pv;
  let ev = null;
  for (let i = 0; i < 60 && !ev; i++) { const e = r.pas(0.05); if (e.zones.length) ev = e; }
  ok(ev, 'le cercle frappe quand meme');
  ok(j.pv < pv0, `et le joueur immobile le prend (${pv0 - j.pv} degats)`);
  ok(j.ralenti > 0, 'avec le ralentissement que la carapace pose');
}

// ================== 6. CE QUE LA PAGE RECOIT
//
// Sans le temps RESTANT, la page devrait deviner ou en est le cercle — donc
// se tromper, donc mentir sur le moment ou ca frappe.
{
  const r = new Realm({ alea: alea(24) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];
  const t = M.MONSTRES.colosse;
  poseZone(r, 'colosse', j.x, j.y);

  const e1 = r.etatPour(A, 1400);
  eq(e1.zones.length, 1, 'l etat porte la zone');
  eq(e1.zones[0].d, t.zone.annonce, 'avec la duree totale');
  eq(e1.zones[0].r, t.zone.rayon, 'et le rayon');
  ok(e1.zones[0].t > 0, 'et ce qu il reste a attendre');
  ok(e1.zones[0].i > 0, 'et un numero, pour ne pas la confondre avec la suivante');

  r.pas(0.5);
  const e2 = r.etatPour(A, 1400);
  eq(e2.zones[0].i, e1.zones[0].i, 'c est toujours la meme zone');
  eq(e2.zones[0].d, e1.zones[0].d, 'la duree totale ne bouge pas');
  ok(e2.zones[0].t < e1.zones[0].t - 0.4, 'mais le reste a diminue');

  /* Une zone a l autre bout de la carte ne voyage pas : c'est le meme filtre
     que pour les sacs et les tombes, et il existe pour que l'etat ne grossisse
     pas avec la carte. */
  poseZone(r, 'colosse', j.x + 4000, j.y);
  eq(r.etatPour(A, 1400).zones.length, 1, 'une zone hors de portee ne voyage pas');
}

// ================== 7. ELLE NE FRAPPE QUE CE QUI EST DEDANS
{
  const r = new Realm({ alea: alea(25) });
  const jA = r.rejoint(A, FICHE);
  const jB = r.rejoint(B, FICHE);
  r.monstres = [];
  const t = M.MONSTRES.brasier;
  /* B se met juste en dehors — a une unite pres. Le bord doit etre un bord,
     pas une approximation. */
  r.bouge(B, jA.x + t.zone.rayon + 1, jA.y, 'right', 'run', 5);
  const dB = Math.hypot(jB.x - jA.x, jB.y - jA.y);
  ok(dB > t.zone.rayon, `B est a ${dB.toFixed(0)} u du centre, juste dehors`);

  poseZone(r, 'brasier', jA.x, jA.y);
  const a0 = jA.pv, b0 = jB.pv;
  let ev = null;
  for (let i = 0; i < 60 && !ev; i++) { const e = r.pas(0.05); if (e.zones.length) ev = e; }
  ok(ev, 'la zone a frappe');
  ok(jA.pv < a0, 'A, au centre, la prend');
  eq(jB.pv, b0, 'B, a une unite du bord, ne la prend pas');
  eq(ev.degats.filter((x) => x.quoi === 'zone').length, 1, 'un seul degat de zone rendu');

  /* ET UN MORT NE MEURT PAS DEUX FOIS. */
  const r2 = new Realm({ alea: alea(26) });
  const j2 = r2.rejoint(A, FICHE);
  r2.monstres = [];
  j2.pv = 0;
  poseZone(r2, 'brasier', j2.x, j2.y);
  let ev2 = null;
  for (let i = 0; i < 60 && !ev2; i++) { const e = r2.pas(0.05); if (e.zones.length) ev2 = e; }
  ok(ev2, 'la zone frappe le vide');
  eq(ev2.degats.filter((x) => x.quoi === 'zone').length, 0, 'un joueur deja mort n est pas frappe');
}

// ================== 8. ELLE TUE, ET LA MORT SUIT LE MEME CHEMIN
//
// Une mort par zone doit rendre le meme rapport qu une mort par fleche :
// c est game.js qui detruit l equipement, et il n a qu un seul chemin.
{
  const r = new Realm({ alea: alea(27) });
  const j = r.rejoint(A, { ...FICHE, stats: { hp: 60, mp: 300, att: 28, def: 0 } });
  r.monstres = [];
  poseZone(r, 'brasier', j.x, j.y);
  let ev = null;
  for (let i = 0; i < 60 && !ev; i++) { const e = r.pas(0.05); if (e.zones.length) ev = e; }
  eq(j.pv, 0, 'le joueur meurt dans le cercle');
  eq(ev.morts.length, 1, 'et sa mort est rendue');
  eq(ev.morts[0].par, 'brasier', 'en nommant ce qui l a tue');
}

// ================== 9. LA BRULURE PREND, ET L IMMUNITE TIENT
{
  const r = new Realm({ alea: alea(28) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];
  poseZone(r, 'brasier', j.x, j.y);
  let ev = null;
  for (let i = 0; i < 60 && !ev; i++) { const e = r.pas(0.05); if (e.zones.length) ev = e; }
  ok(j.brulure > 0, 'la nova du brasier brule');
  eq(j.brulure <= M.EFFETS.brulure.duree, true, 'pour la duree de l effet, pas plus');

  /* Deux cercles coup sur coup ne font pas six secondes de brulure :
     l immunite existe pour ca, et c est elle qui empeche deux brasiers de
     transformer une rencontre en execution. */
  const reste = j.brulure;
  poseZone(r, 'brasier', j.x, j.y);
  for (let i = 0; i < 60; i++) r.pas(0.05);
  ok(j.brulure <= reste, 'un second cercle ne rallonge pas la brulure en cours');
}

console.log('zones.test.js : ' + n + ' verifications OK');
