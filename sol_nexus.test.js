'use strict';
/*
 * LE SOL DU NEXUS — jeter une piece dans le hall, et que tout le monde puisse
 * la prendre.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. RIEN NE SE DUPLIQUE. C'est la seule chose vraiment grave ici : une piece
 *    achetee en $SWOGE qui existerait a deux endroits a la fois. On compte
 *    donc les exemplaires AVANT et APRES chaque geste.
 * 2. RIEN NE SE PERD NON PLUS. Si le sol refuse — huit places prises — la
 *    piece revient dans le sac. Elle a ete sortie de l'inventaire avant qu'on
 *    sache s'il y avait la place ; sans le retour, elle disparaitrait.
 * 3. LA DISTANCE SE VERIFIE SUR LA POSITION DU SERVEUR. « N'importe qui peut
 *    le prendre » est exactement la phrase qu'un client aurait interet a
 *    falsifier : nommer un identifiant depuis l'autre bout du hall ne doit
 *    rien donner.
 * 4. C'EST LE MEME SAC QUE DANS LE MONDE DE COMBAT. Meme minute, meme rayon,
 *    meme forme envoyee a la page — parce que c'est le meme module.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/solnex-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const monde = require('./monde');
const sacs = require('./sacs');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; console.log('  ok   ' + m); };

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
let no = 1;
const id = () => no++;

// ================== 1. LES REGLES SONT CELLES DU MONDE DE COMBAT
console.log('\n-- le meme sac qu ailleurs --');
{
  const l = [];
  const r = sacs.depose(l, 100, 100, A, { item: 7, nom: 'Epee' }, id);
  ok(r && !r.refuse, 'on pose une piece');
  eq(l.length, 1, 'un sac est ne');
  eq(l[0].reste, monde.SAC.duree, `avec la minute entiere (${monde.SAC.duree} s)`);
  eq(l[0].sac, 'brun', 'un sac BRUN : un objet depose ne doit pas ressembler a un butin rare');
  /* La vue reseau est celle de sacs.js, donc identique a celle du monde de
     combat : la page n'a qu'une facon de lire un sac. */
  const v = sacs.vue(l[0]);
  ok(v.i && v.x === 100 && v.c.length === 1, `la vue reseau est la meme (${JSON.stringify(v.c)})`);
}

// ================== 2. LE RAYON, ET RIEN QUE LE RAYON
console.log('\n-- il faut etre dessus --');
{
  const l = [];
  sacs.depose(l, 1000, 1000, A, { item: 7 }, id);
  const R = monde.SAC.rayon;
  ok(sacs.sousLesPieds(l, 1000, 1000), 'sur le sac : trouve');
  ok(sacs.sousLesPieds(l, 1000 + R - 2, 1000), `au bord du rayon (${R}) : trouve`);
  eq(sacs.sousLesPieds(l, 1000 + R + 10, 1000), null, 'un pas plus loin : rien');
  /* C'EST LE REFUS QUI COMPTE : sans lui, nommer un identifiant depuis
     l'autre bout du hall viderait le sac. */
  eq(sacs.sousLesPieds(l, 5000, 5000), null, 'a l autre bout du hall : rien');
}

// ================== 3. LE PLUS PROCHE, PAS LE PREMIER
console.log('\n-- deux sacs cote a cote --');
{
  const l = [];
  sacs.depose(l, 0, 0, A, { item: 1 }, id);
  sacs.depose(l, 300, 0, A, { item: 2 }, id);
  const s = sacs.sousLesPieds(l, 290, 0);
  eq(s.contenu[0].item, 2, 'on ouvre celui sur lequel on se tient, pas le premier de la liste');
}

// ================== 4. HUIT PLACES, PAS UNE DE PLUS
console.log('\n-- le sac est plein --');
{
  const l = [];
  for (let k = 0; k < monde.SAC.cases; k++) sacs.depose(l, 0, 0, A, { item: k + 1 }, id);
  eq(l[0].contenu.length, monde.SAC.cases, `${monde.SAC.cases} places prises`);
  const r = sacs.depose(l, 0, 0, A, { item: 99 }, id);
  ok(r && r.refuse, 'la neuvieme est refusee');
  eq(r.raison, 'sac-plein', 'et on dit pourquoi');
  /* Le refus ne doit RIEN avoir consomme : c'est l'appelant qui a sorti la
     piece de l'inventaire, et c'est lui qui la remettra. */
  eq(l[0].contenu.length, monde.SAC.cases, 'et rien n a ete ajoute');
  eq(l.length, 1, 'ni un deuxieme sac cree sous le premier');
}

// ================== 5. ON NE SE REPREND PAS CE QU ON VIENT DE POSER
console.log('\n-- on s ecarte d abord --');
{
  const l = [];
  const r = sacs.depose(l, 0, 0, A, { item: 5 }, id);
  eq(l[0].pose, A, 'le sac retient QUI a pose');
  /* Sans ce garde-fou, le ramassage automatique reprend la piece dans le meme
     dixieme de seconde : jeter quelque chose devient impossible sans courir. */
  sacs.oubliePoseurs(l, () => ({ x: 0, y: 0 }));
  eq(l[0].pose, A, 'tant qu on est dessus, il s en souvient');
  sacs.oubliePoseurs(l, () => ({ x: 9999, y: 9999 }));
  eq(l[0].pose, null, 'des qu on s ecarte, il redevient a tout le monde');
  /* Et si le poseur a quitte le hall, le sac ne le retient pas pour
     toujours. */
  const l2 = [];
  sacs.depose(l2, 0, 0, B, { item: 6 }, id);
  sacs.oubliePoseurs(l2, () => null);
  eq(l2[0].pose, null, 'un poseur parti ne bloque plus personne');
}

// ================== 6. LA MINUTE, ET CE QUI PART AVEC
console.log('\n-- la minute --');
{
  const l = [];
  sacs.depose(l, 0, 0, A, { item: 42, nom: 'Relique' }, id);
  eq(sacs.vieillit(l, monde.SAC.duree - 1).length, 0, 'avant la fin, rien ne part');
  eq(l.length, 1, 'le sac est toujours la');
  const perdus = sacs.vieillit(l, 2);
  eq(l.length, 0, 'la minute passee, il disparait');
  eq(perdus.length, 1, 'et il ANNONCE ce qui part avec lui');
  eq(perdus[0].item, 42, 'en nommant la piece');
  /* Sans cette annonce, une piece a plafond d emission serait retiree du
     monde pour toujours : elle est comptee des qu elle tombe. */
}

// ================== 7. PRENDRE UNE PLACE
console.log('\n-- prendre --');
{
  const l = [];
  sacs.depose(l, 0, 0, A, { item: 1, nom: 'Un' }, id);
  sacs.depose(l, 0, 0, A, { item: 2, nom: 'Deux' }, id);
  const s = l[0];
  const r = sacs.prend(l, s, 0, () => true);
  eq(r.item, 1, 'on prend la place nommee');
  eq(s.contenu.length, 1, 'elle quitte le sac');
  eq(r.vide, false, 'le sac n est pas vide');
  /* UN REFUS NE RETIRE RIEN : une potion prise a son plafond serait bue pour
     rien et la place serait videe. */
  const refus = sacs.prend(l, s, 0, () => 'sac-plein');
  ok(refus.refuse, 'un refus est rendu comme tel');
  eq(s.contenu.length, 1, 'et la piece reste dans le sac');
  /* Vide, il disparait tout de suite : le laisser finir sa minute donnerait
     un sac qu on rouvre pour rien. */
  sacs.prend(l, s, 0, () => true);
  eq(l.length, 0, 'la derniere place prise, le sac disparait');
}

// ================== 8. RIEN NE SE DUPLIQUE
console.log('\n-- l inventaire des exemplaires --');
{
  /* Le compte total doit etre le meme avant et apres. C'est LA verification
     qui compte : une piece qui existerait dans le sac ET au sol serait une
     piece fabriquee. */
  const l = [];
  const inventaire = { 7: 1 };
  // poser : on sort d abord, on pose ensuite
  inventaire[7] -= 1;
  const r = sacs.depose(l, 0, 0, A, { item: 7 }, id);
  ok(r && !r.refuse, 'pose acceptee');
  const total = (inventaire[7] || 0) + l.reduce((t, s) => t + s.contenu.filter((o) => o.item === 7).length, 0);
  eq(total, 1, 'un exemplaire, toujours un seul');
  // reprendre
  const pris = sacs.prend(l, l[0], 0, () => true);
  inventaire[7] += 1;
  const total2 = (inventaire[7] || 0) + l.reduce((t, s) => t + s.contenu.filter((o) => o.item === 7).length, 0);
  eq(total2, 1, 'et apres l avoir repris, toujours un seul');
  ok(pris.item === 7, 'c est bien la meme piece');
}

console.log(`\nsol_nexus.test.js — ${n} verifications, 0 echec(s)`);
