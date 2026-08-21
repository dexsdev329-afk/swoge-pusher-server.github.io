'use strict';
/*
 * LES OEUFS, ET LE FAMILIER QU'ILS DONNENT.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE CHIFFRE EST CELUI QU'ON A ECRIT — et il se lit dans `monde.OEUF`,
 *    jamais recopie ici. Un essai qui repete le nombre qu'il verifie ne
 *    verifie rien : il continue de passer apres qu'on a change la regle, et
 *    de tomber quand on ne l'a pas changee.
 *    Sur N'IMPORTE QUELLE creature. `butinDe` est une chaine de tirages ou le
 *    premier servi obtient son vrai taux : un oeuf place apres la relique
 *    aurait silencieusement valu moins que son chiffre.
 * 2. LE LEGENDAIRE RESTE RARE PARMI LES RARES. C'est le seul qui soigne. A un
 *    sixieme des oeufs il serait la moitie des familiers du serveur au bout
 *    d'un mois.
 * 3. RIEN NE SE DUPLIQUE, RIEN NE DISPARAIT. Le geste le plus cher du jeu est
 *    « sortir d'un endroit, entrer dans un autre » : entre les deux, la chose
 *    n'est nulle part.
 * 4. LE FAMILIER NE MEURT JAMAIS. Ni avec le personnage, ni avec le compte
 *    qui redemarre. C'est la promesse faite au joueur, et elle tient a une
 *    seule chose : il vit sur le COMPTE, pas sur le personnage.
 * 5. UN DEUXIEME OEUF NE S'OUVRE PAS. On a deja l'animal ; il se range au
 *    coffre, ou il se vend. Il nourrissait le familier qu'on avait — c'etait
 *    la reponse a une question qui n'existe plus (« que faire d'un oeuf
 *    inutile ? »), et le refus arrive AVANT que l'oeuf ne quitte le sac : un
 *    refus qui l'aurait deja consomme detruirait la chose la plus rare du jeu.
 * 6. LE COFFRE A OEUFS NE PERD RIEN. Le sac se perd a la mort, le coffre non,
 *    et le passage de l'un a l'autre ne doit jamais faire disparaitre un oeuf
 *    entre les deux.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/oeufs-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const monde = require('./monde');
const sacs = require('./sacs');
const { Game } = require('./game');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

/* ================== 1. LE TAUX ================== */
console.log('\n-- une chance sur cinq mille --');
{
  const N = 2000000;
  const compte = {};
  let oeufs = 0;
  for (let k = 0; k < N; k++) {
    const b = monde.butinDe('lime', Math.random, 'terre');
    const o = b && b.contenu[0] && b.contenu[0].oeuf;
    if (o) { oeufs++; compte[o] = (compte[o] || 0) + 1; }
  }
  const un = Math.round(N / Math.max(1, oeufs));
  /* Le chiffre VISE vient du monde, il n'est pas recopie : le jour ou l'on
     change le taux — et on l'a change — un essai qui portait « 5000 » en dur
     tombait sans qu'une seule regle soit fausse. Large fourchette autour :
     c'est un tirage, pas une horloge. */
  const vise = Math.round(1 / monde.OEUF.chance);
  ok(un > vise * 0.8 && un < vise * 1.25,
     `un oeuf toutes les ${un} morts (vise : ${vise})`);
  ok(monde.OEUFS.every((e) => compte[e] > 0),
     `les six especes tombent (${monde.OEUFS.map((e) => e + ':' + (compte[e] || 0)).join(' ')})`);
  const partLeg = compte.legendaire / oeufs;
  ok(partLeg > 0.01 && partLeg < 0.10,
     `le legendaire reste rare parmi les rares (${(100 * partLeg).toFixed(1)}%)`);
  const partNorm = compte.normal / oeufs;
  ok(partNorm > 0.30, `et le normal est le plus courant (${(100 * partNorm).toFixed(0)}%)`);
}

/* ---- ET DE N'IMPORTE QUELLE CREATURE ----
 * C'est ce qui fait qu'un lime du bord vaut encore la peine au bout de trente
 * heures. Un oeuf reserve aux boss aurait fait exactement l'inverse. */
console.log('\n-- de n importe quelle creature --');
{
  let alea, tour = 0;
  /* Un hasard TRUQUE : le premier tirage passe toujours. On verifie ainsi que
     l'oeuf est bien le PREMIER de la chaine, sans dependre de la chance. */
  alea = () => (tour++ === 0 ? 0 : 0.999999);
  for (const espece of ['lime', 'optimus']) {
    tour = 0;
    const b = monde.butinDe(espece, alea, 'terre');
    ok(b && b.contenu[0] && b.contenu[0].oeuf,
       `${espece} peut laisser un oeuf (${b && b.contenu[0] ? JSON.stringify(b.contenu[0]) : 'rien'})`);
  }
  /* ET IL PASSE AVANT LA RELIQUE. Si l'ordre s'inversait un jour, son taux
     baisserait d'un cinquantieme sans que rien ne le dise. */
  tour = 0;
  const b = monde.butinDe('fonderie', alea, 'donjon');
  ok(b && b.contenu[0] && b.contenu[0].objet === 'relique',
     'un butin GARANTI passe quand meme avant : une promesse est une promesse');
}

/* ================== 2. LE SOL ================== */
console.log('\n-- au sol, puis dans le sac --');
{
  const g = new Game();
  const A = '0xaaa';
  const liste = [];
  let id = 1;
  const r = sacs.depose(liste, 100, 100, null, { oeuf: 'feu' }, () => id++);
  ok(r && !r.refuse, 'un oeuf se pose au sol');
  eq(r.oeuf, 'feu', 'et le sol sait ce que c est');
  const v = sacs.vue(liste[0]);
  eq(v.c[0].oe, 'feu', 'la page le recoit sous sa forme courte');
  /* ---- SON PROPRE SAC ----
   * Il avait le BLANC, celui des reliques. Le blanc disait « traverse la
   * carte » sans dire pourquoi, et l on repartait avec un oeuf en croyant
   * courir apres une relique. La couleur vient du monde, pas d ici : deux
   * endroits qui nomment le meme sac finissent par n en nommer plus le
   * meme. */
  eq(v.s, monde.OEUF.sac, 'dans SON sac, qu on reconnait de loin');
  ok(monde.OEUF.sac !== 'blanc', 'et ce n est plus celui des reliques');
  ok(monde.SACS.includes(monde.OEUF.sac),
     `le sac de l oeuf est declare avec les autres (${monde.SACS.join(', ')})`);

  const pris = sacs.prend(liste, liste[0], 0, (o) => {
    try { g.prendOeuf(A, o.oeuf); return true; } catch (e) { return e.message; }
  });
  ok(pris && !pris.refuse, 'on le ramasse');
  eq(g.sacRempli(A), 1, 'il occupe UNE place du sac');
  const cases = g.sacPour(A).filter(Boolean);
  eq(cases.length, 1, 'et une seule case le montre');
  eq(cases[0].oeuf, 'feu', 'qui sait quelle espece elle porte');
  ok(!!cases[0].nom && cases[0].nom !== 'Egg', `avec un nom lisible (${cases[0].nom})`);
}

/* ================== 3. RIEN NE SE DUPLIQUE ================== */
console.log('\n-- poser, reprendre, recompter --');
{
  const g = new Game();
  const A = '0xbbb';
  g.prendOeuf(A, 'glace');
  const total = () => (g._p(A).sacOeufs.glace || 0);
  eq(total(), 1, 'un oeuf dans le sac');
  const sorti = g.poseOeufAuSol(A, 'glace');
  eq(sorti.oeuf, 'glace', 'on le pose');
  eq(total(), 0, 'il a quitte le sac');
  g.prendOeuf(A, 'glace');
  eq(total(), 1, 'et il y revient — un seul, pas deux');
  let refus = null;
  try { g.poseOeufAuSol(A, 'terre'); } catch (e) { refus = e.message; }
  ok(!!refus, `poser ce qu on n a pas est refuse (${refus})`);
}

/* ================== 4. L ECLOSION ================== */
console.log('\n-- on ouvre l oeuf --');
{
  const g = new Game();
  const A = '0xccc';
  g.prendOeuf(A, 'legendaire');
  const r = g.ouvreOeuf(A, 'legendaire');
  ok(r.nouveau, 'le premier oeuf donne un familier');
  eq(r.familier.niveau, 1, 'au niveau un');
  ok(!!r.familier.pouvoir, `avec son pouvoir (${r.familier.pouvoir.nom})`);
  eq(g.sacRempli(A), 0, 'et l oeuf a quitte le sac');

  /* ---- ET LE DEUXIEME NE S OUVRE PAS ----
   * Le refus doit arriver AVANT que l oeuf ne quitte le sac. C est le seul
   * ordre acceptable : un refus qui l aurait deja consomme detruirait la chose
   * la plus rare du jeu pour un geste que le joueur n a pas voulu. */
  g.prendOeuf(A, 'legendaire');
  let deux = null;
  try { g.ouvreOeuf(A, 'legendaire'); } catch (e) { deux = e.message; }
  ok(/already have/.test(deux || ''),
     `un DEUXIEME oeuf de la meme espece est refuse (${deux})`);
  eq(g.sacRempli(A), 1, 'et il est TOUJOURS dans le sac — rien n a ete detruit');
  eq(g.familiersDe(A).length, 1, 'il n y a toujours qu un familier');

  /* ---- IL SE RANGE AU COFFRE ---- */
  const range = g.rangeOeuf(A, 'legendaire');
  eq(range.coffre, 1, 'il part au coffre');
  eq(g.sacRempli(A), 0, 'et quitte le sac');
  const auCoffre = g.oeufsDuCoffre(A);
  eq(auCoffre.length, 1, 'le coffre en montre un');
  eq(auCoffre[0].espece, 'legendaire', 'de la bonne espece');
  ok(auCoffre[0].eclos === true,
     'et il DIT que l animal est deja eclos — la page n a pas a le deduire');

  /* ---- ET IL EN RESSORT ---- */
  const sorti = g.sortOeuf(A, 'legendaire');
  eq(sorti.sac, 1, 'on le reprend au sac');
  eq(g.oeufsDuCoffre(A).length, 0, 'le coffre est vide');
  eq(g.sacRempli(A), 1, 'et le sac le porte — rien ne s est perdu en chemin');

  /* ---- LE SAC PLEIN NE FAIT PAS DISPARAITRE L OEUF ----
   * On verifie la place AVANT de retirer du coffre. L ordre inverse laisserait
   * l oeuf nulle part : sorti du coffre, refuse par le sac. */
  g.rangeOeuf(A, 'legendaire');
  const q = g._p(A);
  q.sac = {};
  const it = require('./boutique');
  let mis = 0;
  for (let id = 1000; id < 6000 && mis < monde.SAC.cases; id++) {
    if (it.item(id)) { q.sac[id] = 1; mis++; }
  }
  q.sacCases = null;
  eq(g.sacRempli(A), monde.SAC.cases, 'le sac est plein');
  let plein = null;
  try { g.sortOeuf(A, 'legendaire'); } catch (e) { plein = e.message; }
  ok(/full/.test(plein || ''), `sortir dans un sac plein est refuse (${plein})`);
  eq(g.oeufsDuCoffre(A).length, 1, 'et l oeuf est TOUJOURS au coffre');

  let refus = null;
  try { g.ouvreOeuf(A, 'feu'); } catch (e) { refus = e.message; }
  ok(!!refus, `ouvrir un oeuf qu on n a pas est refuse (${refus})`);
}

/* ================== 5. IL NE MEURT JAMAIS ================== */
console.log('\n-- le familier survit a tout --');
{
  const g = new Game();
  const A = '0xddd';
  const p = g._p(A);
  p.skins = { andy: true }; p.skinActif = 'andy';
  p.persos = { andy: { ef: null, ea: null, ar: null, ba: null, xc: 9000 } };
  g.prendOeuf(A, 'terre');
  g.ouvreOeuf(A, 'terre');
  /* Un DEUXIEME oeuf, pas ouvert celui-la : il est dans le sac, donc il est
     en danger. C'est ce qui donne sa tension a la trouvaille — rentrer tout
     de suite l ouvrir, ou continuer avec lui dans le dos. */
  g.prendOeuf(A, 'feu');

  const bilan = g.meurt(A, 'andy');
  eq(g.familiersDe(A).length, 1, 'mourir dans le monde vert ne tue pas le familier');
  eq(p.persos.andy.xc, 0, 'alors que le personnage, lui, est bien remis a zero');
  eq((p.sacOeufs || {}).feu | 0, 0, 'et l oeuf NON OUVERT du sac, lui, se perd');
  eq((bilan.oeufsPerdus || {}).feu, 1, 'l ecran de fin le nomme, au lieu de le taire');
}

/* ================== 6. LA CHUTE EN PVP ================== */
console.log('\n-- tomber dans le rouge avec un oeuf --');
{
  const g = new Game();
  const A = '0xeee';
  const p = g._p(A);
  const B = require('./boutique');
  const communs = B.ITEMS_DROP.filter((o) => o.rarete === 'commun').slice(0, 8);
  p.sac = {};
  for (const o of communs) p.sac[o.id] = 1;
  p.sacOeufs = { tenebre: 1 };
  p.sacCases = null;
  const tombe = g.videLeSac(A, monde.SAC.cases);
  ok(tombe.some((o) => o.oeuf === 'tenebre'),
     'l oeuf est dans ce qui tombe, meme avec huit pieces devant lui');
  eq(tombe[0].oeuf, 'tenebre', 'et il est EN TETE : le vainqueur vient chercher ca');
  eq((p.sacOeufs.tenebre | 0), 0, 'il a bien quitte le sac de celui qui est tombe');
}

console.log(`\noeufs.test.js : ${n} verifications OK`);
