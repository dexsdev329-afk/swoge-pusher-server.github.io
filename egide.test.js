'use strict';
/*
 * L'EGIDE : DEUX SECONDES OU RIEN NE PASSE.
 *
 * ---- POURQUOI CE FICHIER EST LE PLUS SEVERE DU DEPOT ----
 *
 * C'est le pouvoir le plus dangereux du jeu, et sa faute la plus probable est
 * SILENCIEUSE : une source de degats oubliee. On mourrait pendant l'animation
 * qui dit qu'on est protege, dans un duel ou l'on perd son sac, et personne
 * ne comprendrait.
 *
 * Le joueur perd de la vie a CINQ endroits — la zone, le projectile de
 * monstre, le COUP AU CONTACT, le tir d'un autre joueur, et la brulure. Deux
 * seulement passaient par le filtre existant : la brulure ignore l'armure par
 * regle, et le duel calcule comme contre une creature. Une egide posee dans
 * `_amorti` aurait donc laisse passer exactement les deux qui comptent.
 *
 * Ce fichier en a longtemps enumere QUATRE et oublie le contact — la source la
 * plus courante du jeu. Il passait au vert pendant que le pouvoir laissait
 * mourir sous l'animation qui annonce l'invulnerabilite. Une liste incomplete
 * dans un essai d'exhaustivite est pire qu'une absence d'essai : elle rassure.
 *
 * ---- ce que ce fichier protege, dans l'ordre ----
 *
 * 1. LES CINQ SOURCES SONT ARRETEES. Enumerees depuis le monde quand c'est
 *    possible, pour qu'une sixieme ajoutee demain se voie.
 * 2. ELLE NE SE CUMULE PAS. Sinon un joueur qui appuie en rythme reste
 *    intuable pour toujours, et la recharge ne sert plus a rien.
 * 3. ELLE NE MET RIEN EN PAUSE. Sous egide on brule dans le vide ; sinon deux
 *    secondes de protection couteraient deux secondes de feu de plus.
 * 4. ET SA PART DU TEMPS RESTE PETITE. C'est la seule chose qui la separe
 *    d'une facon de jouer.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/egide-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const monde = require('./monde');
const P = require('./personnages');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const fiche = (stat) => ({ skin: 'andy', nom: 'Alice',
  stats: { att: 60, def: 30, spd: 40, dex: 40, vit: 30, wis: 30, hp: 2000, mp: 400 },
  famille: 'lame', degats: [40, 60], statFruit: stat });

/* Tout vient du monde : le nom du pouvoir, sa duree, sa recharge, son cout.
   Les ecrire ici ferait passer l'essai le jour ou on les regle — et c'est
   justement ce jour-la qu'on veut qu'il parle. */
const CLE = monde.POUVOIR_PAR_STAT.def;
const E = monde.POUVOIRS[CLE];
const avance = (R, s) => { for (let t = 0; t < s; t += 0.1) R.pas(0.1); };

console.log('-- ce que le monde declare --');
eq(CLE, 'egide', `la garde donne « ${CLE} »`);
ok(E && E.duree > 0 && E.recharge > 0 && E.cout > 0,
   `${E.duree}s toutes les ${E.recharge}s pour ${E.cout} de mana`);
/* ---- LA PART DU TEMPS EST LA SEULE CHOSE QUI COMPTE ----
 * Un joueur intuable n'est pas « plus fort » : celui d'en face ne peut rien
 * faire de ces secondes-la. A huit secondes de recharge — celle de la rafale
 * — deux secondes feraient vingt-cinq pour cent du duel. */
const part = E.duree / E.recharge;
ok(part < 0.10,
   `soit ${(part * 100).toFixed(1)} % du temps — sous les 10 % au-dela desquels ce n'est plus une sortie de secours`);
/* Et elle coute le plus cher du jeu : porter l'egide, c'est renoncer a lancer
   autre chose pendant longtemps. */
const couts = Object.keys(monde.POUVOIRS).map((k) => monde.POUVOIRS[k].cout);
eq(E.cout, Math.max(...couts), 'et c est le pouvoir le plus cher en mana');

/* ================== 1. LES QUATRE SOURCES ================== */
console.log('\n-- ce qu elle arrete : tout --');

/* Chaque source est mesuree DEUX FOIS, avec et sans. Le temoin est ce qui
   fait la preuve : « zero degat » tout seul pourrait vouloir dire que la
   source ne marchait pas. */
const sources = {
  'le duel (carte rouge)': (avec) => {
    const R = new Realm({ pvp: true });
    R.rejoint('0xaaa', fiche('att')); R.rejoint('0xbbb', fiche('def'));
    const a = R.joueurs.get('0xaaa'), b = R.joueurs.get('0xbbb');
    R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
    b.x = a.x + 40; b.y = a.y;
    if (avec) b.egide = E.duree;
    const pv0 = b.pv;
    for (let i = 0; i < 20; i++) { R.tire('0xaaa', 0); R.pas(0.1); }
    return pv0 - b.pv;
  },
  'la brulure': (avec) => {
    const R = new Realm({}); R.rejoint('0xaaa', fiche('def'));
    const j = R.joueurs.get('0xaaa');
    /* ---- ON VIDE LE MONDE ----
     * `new Realm({})` peuple deux cent soixante creatures. Sans cette ligne
     * l'essai mesurait les monstres alentour en croyant mesurer la brulure :
     * il a rendu 4 degats « sous egide », qui venaient d'un tir passe entre
     * deux pas. Une source oubliee et du bruit se ressemblent, et c'est
     * exactement ce qu'on ne peut pas se permettre de confondre ici. */
    R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
    j.brulure = 5; j.brulReste = 0;
    if (avec) j.egide = E.duree;
    const pv0 = j.pv;
    avance(R, 1.5);
    return pv0 - j.pv;
  },
  'la zone au sol': (avec) => {
    const R = new Realm({}); R.rejoint('0xaaa', fiche('def'));
    const j = R.joueurs.get('0xaaa');
    R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
    if (avec) j.egide = E.duree;
    R.zones.push({ id: 1, x: j.x, y: j.y, r: 200, att: 300, effet: null,
                   espece: 'lime', reste: 0.05, duree: 1.5 });
    const pv0 = j.pv;
    avance(R, 0.5);
    return pv0 - j.pv;
  },
  /* ---- LE CINQUIEME, CELUI QUI MANQUAIT ----
   * Cette liste en comptait QUATRE, comme le commentaire de l'entonnoir. Le
   * coup au CONTACT — la source la plus courante du jeu, celle du golem qui
   * vous colle — appelait `_amorti` directement et passait donc a travers
   * l'egide. L'essai etait vert, le pouvoir etait perce, et le mot « quatre »
   * ecrit en haut du fichier etait la seule trace de l'oubli.
   * On ne construit pas la creature a la main : on prend la premiere du monde
   * qui frappe au contact, pour que ce cas suive le jeu s'il change. */
  'le coup au contact': (avec) => {
    const R = new Realm({}); R.rejoint('0xaaa', fiche('def'));
    const j = R.joueurs.get('0xaaa');
    R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
    const espece = Object.keys(monde.MONSTRES)
      .find((c) => monde.MONSTRES[c].contact && !monde.MONSTRES[c].choc);
    const t = monde.MONSTRES[espece];
    const m = R._naissance({ espece, biome: 'terre', x: j.x + t.rayon + 10, y: j.y });
    m.recharge = 0;
    R.monstres.push(m);
    if (avec) j.egide = E.duree;
    const pv0 = j.pv;
    avance(R, 0.4);
    return pv0 - j.pv;
  },
  'le projectile de monstre': (avec) => {
    const R = new Realm({}); R.rejoint('0xaaa', fiche('def'));
    const j = R.joueurs.get('0xaaa');
    R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
    if (avec) j.egide = E.duree;
    R.tirsM.push({ id: 1, espece: 'lime', x: j.x, y: j.y, a: 0, v: 300,
                   reste: 1, att: 400, sprite: 'bave', effet: null });
    const pv0 = j.pv;
    avance(R, 0.4);
    return pv0 - j.pv;
  },
};
for (const [nom, f] of Object.entries(sources)) {
  const sans = f(false);
  ok(sans > 0, `${nom} fait bien mal sans elle (${sans})`);
  eq(f(true), 0, `et rien du tout sous egide`);
}

/* ---- ET ON N'EN MEURT PAS ----
 * La verification qui compte vraiment : `_meurt` est appele depuis plusieurs
 * de ces chemins, et une egide qui annulerait les degats sans empecher la
 * mort serait le pire des cas. */
console.log('\n-- et on n en meurt pas --');
{
  const R = new Realm({ pvp: true });
  R.rejoint('0xaaa', fiche('att')); R.rejoint('0xbbb', fiche('def'));
  const a = R.joueurs.get('0xaaa'), b = R.joueurs.get('0xbbb');
  /* Meme raison qu'au-dessus : la carte rouge est peuplee, et un joueur pose
     a un point de vie au milieu de deux cent soixante creatures meurt de
     n'importe quoi. On ne mesure que le DUEL. */
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  b.x = a.x + 40; b.y = a.y;
  b.pv = 1;                       // un souffle de vie
  b.egide = E.duree;
  for (let i = 0; i < 15; i++) { R.tire('0xaaa', 0); R.pas(0.1); }
  /* On ne compare pas a UN : la vie remonte toute seule pendant la seconde et
     demie, et l'essai aurait accuse l'egide d'une regeneration. Ce qui se
     verifie ici est qu'on n'a rien PERDU, et qu'on est vivant. */
  ok(b.pv >= 1, `on n a pas perdu un point (${b.pv})`);
  ok(b.pv > 0, 'et l on est toujours vivant apres une rafale entiere a un point de vie');
}

/* ================== 2. ELLE NE PEUT PAS SE CUMULER ==================
 *
 * ---- LA PROTECTION EST UNE RELATION ENTRE DEUX NOMBRES ----
 *
 * J'avais ecrit un refus explicite dans `pouvoir()`. Il etait INACCESSIBLE :
 * la recharge est testee avant, et trente secondes refusent toujours avant
 * que deux secondes d'egide n'aient a se defendre. Retirer ce refus ne
 * changeait rien — l'essai continuait de passer, ce qui est la definition du
 * code mort.
 *
 * Ce qui protege vraiment, c'est que la RECHARGE DEPASSE LA DUREE. Si un jour
 * quelqu'un descend la recharge sous deux secondes pour « rendre le pouvoir
 * plus vivant », un joueur qui appuie en rythme devient intuable pour
 * toujours — et rien dans le code ne l'arreterait. C'est donc ce rapport-la
 * qu'on verrouille, et pas une ligne qui ne s'execute jamais.
 */
{
  console.log('\n-- elle ne peut pas se cumuler --');
  ok(E.recharge > E.duree,
     `la recharge (${E.recharge}s) depasse la duree (${E.duree}s) — sans quoi elle serait permanente`);
  /* Avec de la marge : a recharge egale a la duree, on la relance a la
     seconde ou elle tombe, ce qui revient au meme. */
  ok(E.recharge >= E.duree * 3,
     `et de loin (${(E.recharge / E.duree).toFixed(0)} fois)`);

  const R = new Realm({}); R.rejoint('0xaaa', fiche('def'));
  const j = R.joueurs.get('0xaaa');
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  const ev = { touches: [], kills: [] };
  const r = R.pouvoir('0xaaa', ev);
  ok(r && !r.refus, `elle part (${E.duree}s)`);
  eq(j.egide, E.duree, 'et le compteur est pose');
  const mp = j.mp;
  avance(R, 1);
  const r2 = R.pouvoir('0xaaa', ev);
  ok(r2 && r2.refus, `une seconde plus tard, elle est refusee (${r2 && r2.refus})`);
  /* LE REFUS NE PRELEVE RIEN. Un refus qui prendrait le mana ferait payer
     cent-vingt pour rien, et c'est le genre de perte dont un joueur ne se
     remet pas au milieu d'un duel. On ne compare pas a l'identique : le mana
     remonte tout seul pendant la seconde qui separe les deux appels. */
  ok(j.mp >= mp, `et le refus n a rien preleve (${mp} -> ${j.mp})`);
  ok(j.egide < E.duree, 'le compteur continue de descendre, il ne repart pas');
}

/* ================== 3. ELLE NE MET RIEN EN PAUSE ================== */
console.log('\n-- sous egide, on brule dans le vide --');
{
  /* Si l'egide mettait la brulure en PAUSE, deux secondes de protection
     couteraient deux secondes de feu de plus : on sortirait protege pour
     recevoir exactement ce qu'on avait evite. Elle doit donc bruler, sans
     faire mal. */
  const R = new Realm({}); R.rejoint('0xaaa', fiche('def'));
  const j = R.joueurs.get('0xaaa');
  /* Monde vide : c'est la troisieme fois que le peuplement se glisse dans une
     mesure de ce fichier. Deux cent soixante creatures et un joueur pose au
     milieu, ca fait un point de vie perdu de temps en temps — et « un point
     de vie perdu » est exactement ce qu'une egide qui fuit ressemblerait. */
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  j.brulure = monde.EFFETS.brulure.duree;
  j.egide = E.duree;
  /* ---- ON MESURE A L'INTERIEUR, PAS SUR LA FRONTIERE ----
   * Avancer de PILE la duree de l'egide fait tomber le dernier pas apres sa
   * fin : le compteur passe a zero avant que la brulure ne soit reglee, et
   * l'essai voyait un point de degat qu'il attribuait a une fuite. Une
   * seconde et demie sur deux, et la question posee reste la meme. */
  const fenetre = E.duree - 0.5;
  const feu0 = j.brulure;
  avance(R, fenetre);
  ok(j.brulure < feu0 - fenetre + 0.2,
     `la brulure a bien avance pendant l egide (${feu0}s -> ${j.brulure.toFixed(1)}s)`);
  eq(j.pv, j.pvMax, 'sans avoir rien coute');
}

/* ================== 4. ELLE S'EPUISE ================== */
console.log('\n-- et elle finit --');
{
  const R = new Realm({}); R.rejoint('0xaaa', fiche('def'));
  const j = R.joueurs.get('0xaaa');
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  R.pouvoir('0xaaa', { touches: [], kills: [] });
  avance(R, E.duree + 0.3);
  eq(j.egide, 0, 'le compteur est retombe a zero');
  /* Et les coups repassent. Une egide qui ne s'eteindrait jamais serait un
     personnage immortel, et c'est exactement ce que la duree existe pour
     empecher. */
  R.tirsM.push({ id: 1, espece: 'lime', x: j.x, y: j.y, a: 0, v: 300,
                 reste: 1, att: 400, sprite: 'bave', effet: null });
  const pv0 = j.pv;
  avance(R, 0.4);
  ok(j.pv < pv0, `et les coups repassent (${pv0 - j.pv} degats)`);
}

console.log(`\negide.test.js : ${n} verifications OK`);
