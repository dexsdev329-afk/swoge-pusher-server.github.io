'use strict';
/*
 * LA CARTE ROUGE : ON SE TIRE DESSUS, ET TOMBER N'EST PAS MOURIR.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE TIR PORTE. C'est ce qui manquait : la porte rouge menait a un monde
 *    ou l'on se croisait sans pouvoir rien faire, et les projectiles
 *    passaient au travers. Ca ne se lit pas comme une regle, ca se lit comme
 *    une panne.
 * 2. ET SEULEMENT LA. Le monde vert est une zone sure. Un tir qui y toucherait
 *    un joueur serait la pire regression possible : on se ferait tuer par un
 *    inconnu la ou le jeu promet qu'on ne peut pas l'etre.
 * 3. ON NE SE TUE PAS SOI-MEME. Un projectile nait sur son tireur.
 * 4. TOMBER FAIT PERDRE LE SAC, PAS L'EQUIPEMENT. C'est toute la difference
 *    entre un jeu ou l'on entre et un jeu ou l'on n'entre plus : un objet
 *    achete en $SWOGE qui change de main sur l'issue d'un duel est une mise.
 * 5. RIEN NE DISPARAIT. Le sol a huit places ; on ne lache que ce qui tient.
 *    Ce qui sort de l'inventaire sans entrer nulle part est detruit, et c'est
 *    la faute la plus chere du jeu.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/pvp-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const monde = require('./monde');
const boutique = require('./boutique');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

/* Une fiche de combat minimale : le monde n'en demande pas plus. */
const fiche = (nom) => ({ skin: 'andy', nom,
                          stats: { att: 40, def: 10, spd: 30, dex: 30, vit: 30, wis: 20, hp: 500, mp: 100 },
                          famille: 'lame', degats: [40, 60] });

/* On pose deux joueurs COLLES l'un a l'autre : le tir nait sur le tireur et
   n'a qu'un pas a faire. Compter des pas de projectile reviendrait a verifier
   la physique, qui n'est pas le sujet ici. */
function duel(opts) {
  const R = new Realm(opts);
  const A = '0xaaa', B = '0xbbb';
  R.rejoint(A, fiche('Alice'));
  R.rejoint(B, fiche('Bob'));
  const ja = R.joueurs.get(A), jb = R.joueurs.get(B);
  jb.x = ja.x + 20; jb.y = ja.y;
  return { R, A, B, ja, jb };
}
/* Tirer vers la droite, puis avancer la simulation d'un pas court. */
function tire(R, addr, tours) {
  R.tire(addr, 0);
  const evs = [];
  for (let k = 0; k < (tours || 3); k++) evs.push(R.pas(0.05));
  return evs;
}

console.log('\n-- dans la carte rouge, le tir porte --');
{
  const { R, A, B, jb } = duel({ pvp: true });
  const pvAvant = jb.pv;
  const evs = tire(R, A);
  const touche = evs.some((e) => e.touches.some((t) => t.joueur === B));
  ok(touche, 'le tir d Alice touche Bob');
  ok(jb.pv < pvAvant, `et Bob perd de la vie (${pvAvant} -> ${jb.pv})`);
  const subi = evs.some((e) => e.degats.some((d) => d.addr === B && d.quoi === 'joueur'));
  ok(subi, 'Bob l apprend par un degat a son nom');
}

console.log('\n-- dans la carte verte, il ne porte pas --');
{
  const { R, A, B } = duel({});
  const evs = tire(R, A);
  /* MEME RAISON QUE PLUS BAS : comparer les points de vie de Bob mesurerait
     les creatures de la carte, pas le tir d'Alice. La question est de savoir
     si un JOUEUR peut lui faire mal dans la zone sure ; `quoi: 'joueur'` est
     la seule marque qui reponde. */
  ok(!evs.some((e) => e.degats.some((d) => d.addr === B && d.quoi === 'joueur')),
     'Bob ne prend aucun degat de joueur');
  ok(!evs.some((e) => e.touches.some((t) => t.joueur === B)),
     'et aucun coup n est annonce : la zone sure reste sure');
}

console.log('\n-- on ne se tire pas dessus soi-meme --');
{
  const { R, A, ja } = duel({ pvp: true });
  /* Bob ecarte : il ne doit pas encaisser le tir a la place d'Alice. */
  R.joueurs.get('0xbbb').x = ja.x + 4000;
  const evs = tire(R, A);
  /* ---- ON REGARDE LA SOURCE, PAS LE TOTAL DE VIE ----
   *
   * La version d'avant comparait les points de vie d'Alice avant et apres.
   * C'etait mesurer du BRUIT : la carte est peuplee, elle est generee au
   * hasard (aucune graine n'est passee a `Realm`), et une creature qui la
   * mord pendant les trois tours de simulation faisait tomber l'essai une
   * fois sur quatre — sur un message qui accusait son propre projectile.
   *
   * Ce qu'on veut savoir tient en une phrase : est-ce que le tir d'Alice
   * porte un degat AU NOM D'ALICE ? `quoi: 'joueur'` est la marque que seul
   * un projectile de joueur pose (realm.js), donc la question se pose
   * exactement, sans rien devoir a ce que font les monstres a cote. */
  const parUnJoueur = evs.some((e) =>
    e.degats.some((d) => d.addr === A && d.quoi === 'joueur'));
  ok(!parUnJoueur, 'Alice ne se blesse pas avec son propre projectile');
  ok(!evs.some((e) => e.touches.some((t) => t.joueur === A)),
     'et aucun coup de joueur n est annonce sur elle');
}

console.log('\n-- tomber, c est perdre son sac --');
{
  const { R, A, B, jb } = duel({ pvp: true });
  /* ---- ON VIDE LA CARTE DE SES CREATURES ----
   *
   * Bob est pose a UN point de vie : n'importe quelle morsure le tue avant le
   * projectile d'Alice, et sa chute n'est alors pas marquee PvP. L'essai
   * accusait le marquage alors qu'il mesurait qui avait frappe le premier —
   * une fois sur quatre, sur une carte peuplee au hasard.
   *
   * Vider suffit : une naissance est deja interdite a moins de
   * `ecartDeNaissance` du joueur, donc aucune creature ne peut reapparaitre
   * sur lui pendant les trois tours qui suivent. */
  R.monstres = [];
  jb.pv = 1;
  const evs = tire(R, A);
  const mort = evs.flatMap((e) => e.morts).find((m) => m.addr === B);
  ok(!!mort, 'Bob tombe');
  eq(mort ? mort.pvp : 0, 1, 'et sa chute est marquee PvP');
  eq(mort ? mort.par : null, 'Alice', 'avec le nom de celui qui l a eu');
  ok(mort && typeof mort.x === 'number' && typeof mort.y === 'number',
     'et l endroit ou il est tombe, la ou son sac ira');
}

/* ================== LE SAC QUI TOMBE ================== */
console.log('\n-- ce qui tombe, et ce qui ne tombe pas --');
{
  const { Game } = require('./game');
  const g = new Game();
  const addr = '0xccc';
  const p = g._p(addr);
  /* Un sac trop plein POUR LE SOL : huit places par terre, et l'on porte ici
     six pieces plus douze fioles. C'est le cas ou une version naive detruit
     dix objets sans un mot. */
  const communs = boutique.ITEMS_DROP.filter((o) => o.rarete === 'commun').slice(0, 3);
  const rares = boutique.ITEMS_DROP.filter((o) => o.rarete === 'legendaire').slice(0, 3);
  p.sac = {};
  for (const o of communs) p.sac[o.id] = 1;
  for (const o of rares) p.sac[o.id] = 1;
  p.sacFioles = { att: 12 };
  p.sacCases = null;
  const avant = 6 + 12;

  const tombe = g.videLeSac(addr, monde.SAC.cases);
  eq(tombe.length, monde.SAC.cases,
     `on lache exactement ce que le sol peut tenir (${monde.SAC.cases})`);

  /* RIEN NE DISPARAIT : ce qui n a pas ete lache est reste dans le sac. */
  const reste = Object.keys(p.sac).reduce((t, k) => t + p.sac[k], 0)
              + Object.keys(p.sacFioles).reduce((t, k) => t + p.sacFioles[k], 0);
  eq(reste + tombe.length, avant,
     `et le compte est juste : ${tombe.length} au sol + ${reste} garde = ${avant}`);

  /* LE MEILLEUR PART EN PREMIER : c est ce que le vainqueur vient chercher. */
  const cles = tombe.filter((o) => o.rarete).map((o) => o.rarete);
  eq(cles.filter((r) => r === 'legendaire').length, 3,
     'les trois legendaires sont dans le lot');
  ok(!cles.includes('commun') || cles.indexOf('legendaire') < cles.indexOf('commun'),
     'et ils passent avant les communs');
}

console.log('\n-- et l equipement, lui, ne bouge pas --');
{
  const { Game } = require('./game');
  const g = new Game();
  const addr = '0xddd';
  const p = g._p(addr);
  const arme = boutique.ITEMS_DROP.find((o) => o.famille === 'lame');
  p.objets = {}; p.objets[arme.id] = 1;
  p.persos = { andy: { ea: arme.id, ef: null, ar: null, ba: null, xp: 4000 } };
  p.sac = {}; p.sacFioles = {};
  g.videLeSac(addr, monde.SAC.cases);
  eq(p.persos.andy.ea, arme.id, 'l arme portee est toujours portee');
  eq(p.objets[arme.id], 1, 'et toujours au coffre');
  eq(p.persos.andy.xp, 4000, 'le niveau ne bouge pas non plus');
}

console.log(`\npvp.test.js : ${n} verifications OK`);
