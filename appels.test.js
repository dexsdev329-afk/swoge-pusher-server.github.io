'use strict';
/*
 * LE BOSS EN APPELLE D'AUTRES.
 *
 * C'est la premiere mecanique du jeu ou une creature en fait naitre d'autres.
 * Tout ce qui peut mal tourner ici coute cher, parce que ca se passe au fond
 * d'un donjon dont on ne sort pas facilement.
 *
 * ---- ce que ce fichier protege, dans l'ordre ----
 *
 * 1. LE PLAFOND TIENT. Un boss de deux minutes qui appelle sans borne remplit
 *    la salle : on ne l'atteint plus, et un boss qu'on ne peut plus toucher
 *    n'est pas difficile, il est inatteignable.
 * 2. IL COMPTE LES SIENS, pas les creatures de la salle. Le jour ou l'on
 *    donne un appel a un monstre du monde ouvert, un comptage global le
 *    rendrait muet au milieu d'une meute qu'il n'a pas faite.
 * 3. PERSONNE NE NAIT DANS LA PIERRE. Une creature nee dans un mur y reste
 *    pour toujours, immobile et hors d'atteinte, et la salle ne se vide plus.
 *    C'est le defaut le plus cher : le donjon devient infinissable.
 * 4. CE QUI EST APPELE NE LAISSE RIEN. Sinon on laisse le boss en vie pour
 *    farmer ses appels — l'inverse exact de ce qu'un boss doit provoquer.
 * 5. ET L'APPEL SUIT LA PHASE. Il n'existe pas avant, il change en cours de
 *    combat, et il s'arrete de lui-meme quand le boss meurt.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/appels-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const monde = require('./monde');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const fiche = () => ({ skin: 'andy', nom: 'Alice',
  stats: { att: 75, def: 45, spd: 65, dex: 90, vit: 40, wis: 50, hp: 6000, mp: 300 },
  famille: 'lame', degats: [55, 80] });

/* ---- TOUT VIENT DU MONDE ----
 * L'espece appelee, le plafond, la cadence, les seuils de phase : les ecrire
 * ici ferait passer l'essai le jour ou l'on regle le boss, et c'est justement
 * ce jour-la qu'on veut qu'il parle. */
const BOSS = 'idole';
const PVMAX = monde.MONSTRES[BOSS].pv;
/* La liste des phases QUI APPELLENT, deduite du moteur. */
const AVEC_APPEL = [];
for (let i = 0; i < monde.nbPhases(BOSS); i++) {
  for (let q = 1000; q >= 0; q--) {
    const pv = PVMAX * (q / 1000);
    if (monde.phaseMonstre(BOSS, pv, PVMAX) !== i) continue;
    const t = monde.statsMonstre(BOSS, pv, PVMAX);
    if (t.appel) AVEC_APPEL.push({ i, pv, appel: t.appel });
    break;
  }
}

function scene() {
  const plan = monde.planDeDonjon('sanctuaire', Math.random);
  const R = new Realm({ plan });
  R.rejoint('0xaaa', fiche());
  const j = R.joueurs.get('0xaaa');
  const boss = R.monstres.find((m) => m.espece === BOSS);
  /* On se pose a portee de vue mais hors de sa zone : l'essai mesure les
     APPELS, pas la survie du personnage. */
  if (boss) { j.x = boss.x + 420; j.y = boss.y; }
  return { R, j, boss };
}
/* On avance en gardant le boss a sa vie choisie et le joueur a sa place : sans
   ca le boss meurt, ou le joueur sort de sa vue, et l'essai mesurerait autre
   chose que l'appel. */
function tient(R, boss, j, pv, secondes) {
  const evs = [];
  for (let t = 0; t < secondes; t += 0.1) {
    boss.pv = pv;
    j.x = boss.x + 420; j.y = boss.y; j.pv = j.pvMax;
    evs.push(R.pas(0.1));
  }
  return evs;
}
const sbires = (R, boss) => R.monstres.filter((m) => m.pv > 0 && m.invoquePar === boss.id);

console.log('-- ce que le monde declare --');
ok(AVEC_APPEL.length >= 2,
   `${AVEC_APPEL.length} phases de « ${BOSS} » appellent des creatures`);
for (const a of AVEC_APPEL) {
  ok(!!monde.MONSTRES[a.appel.espece],
     `phase ${a.i + 1} appelle « ${a.appel.espece} », qui existe dans la table`);
  ok(a.appel.plafond > 0 && a.appel.combien > 0 && a.appel.cadence > 0,
     `et elle dit combien (${a.appel.combien}), a quel rythme (${a.appel.cadence}/s) `
     + `et jusqu'ou (${a.appel.plafond})`);
}

/* ================== 1. AVANT SA PHASE, IL N'APPELLE PAS ================== */
console.log('\n-- a pleine vie, il ne fait venir personne --');
{
  const { R, j, boss } = scene();
  ok(!!boss, 'le boss est au fond du sanctuaire');
  const t0 = monde.statsMonstre(BOSS, PVMAX, PVMAX);
  ok(!t0.appel, 'sa premiere phase n a pas d appel');
  tient(R, boss, j, PVMAX, 30);
  eq(sbires(R, boss).length, 0, 'et rien n est ne en trente secondes');
}

/* ================== 2. LE PLAFOND TIENT ================== */
console.log('\n-- le plafond, quoi qu il arrive --');
for (const a of AVEC_APPEL) {
  const { R, j, boss } = scene();
  /* LONGTEMPS. Le plafond ne se voit qu'en laissant tourner : sur une fenetre
     courte, n'importe quel chiffre passe. */
  tient(R, boss, j, a.pv, 180);
  const vus = sbires(R, boss);
  ok(vus.length <= a.appel.plafond,
     `phase ${a.i + 1} : ${vus.length} vivants sur trois minutes, plafond ${a.appel.plafond}`);
  ok(vus.length > 0, 'et il en a bien fait venir');
  ok(vus.every((m) => m.espece === a.appel.espece),
     `tous de l espece annoncee (${a.appel.espece})`);
}

/* ================== 3. PERSONNE NE NAIT DANS LA PIERRE ==================
 *
 * ---- ON REGARDE LE POINT DE NAISSANCE, PAS OU ELLES SONT ----
 *
 * Premiere version : on relevait la position des sbires VIVANTS a la fin. Elle
 * ne prouvait rien — une creature nee dans un mur se met a poursuivre le
 * joueur et en sort. L'essai rendait donc zero meme en retirant la recherche
 * de place, et il l'a fait.
 *
 * Le point d'apparition voyage dans l'evenement (`ev.appels[].nes`), et c'est
 * la seule chose qui dise ce que le placement a decide.
 */
{
  let nes = 0, dedans = 0;
  /* Sur BEAUCOUP d'ouvertures : le decor et les murs changent a chaque plan,
     et un seul plan ne dit rien de la forme des autres. C'est le defaut le
     plus cher du lot — une creature coincee rend le donjon infinissable. */
  for (let k = 0; k < 40; k++) {
    const { R, j, boss } = scene();
    const evs = tient(R, boss, j, AVEC_APPEL[AVEC_APPEL.length - 1].pv, 60);
    for (const a of evs.flatMap((e) => e.appels || [])) {
      for (const b of (a.nes || [])) {
        nes++;
        const t = monde.MONSTRES[b.e];
        if (monde.bloque(R.obstacles, b.x, b.y, t.rayon)) dedans++;
      }
    }
  }
  ok(nes > 40, `${nes} naissances relevees sur quarante ouvertures`);
  eq(dedans, 0, 'aucune n a eu lieu dans la pierre');
}

/* ================== 4. ELLES NE LAISSENT RIEN ==================
 *
 * ---- POURQUOI CETTE SECTION COMPTE BEAUCOUP DE MORTS ----
 *
 * Mesure : `butinDe` rend un sac pour ces especes 17 % du temps. Sur les six
 * creatures qu'un combat pose, ne rien voir tomber arrive donc DEUX FOIS SUR
 * TROIS par pur hasard — et l'essai passait meme quand `sansButin` etait
 * retire. Il ne prouvait rien.
 *
 * On en tue donc trois cents, et l'on compare a trois cents de la MEME espece
 * nees autrement. Le temoin est ce qui fait la preuve : sans lui, « zero sac »
 * pourrait simplement vouloir dire que cette creature ne laisse jamais rien.
 */
{
  const { R, j, boss } = scene();
  const evNul = () => ({ degats: [], morts: [], kills: [], touches: [], regen: [],
                         butins: [], ramasses: [], expires: [], marques: [],
                         zones: [], portails: [] });
  const espece = AVEC_APPEL[0].appel.espece;
  const COMBIEN = 300;

  /* Le TEMOIN d'abord : la meme espece, sans le drapeau. */
  let sacsTemoin = 0, xpTemoin = 0;
  for (let k = 0; k < COMBIEN; k++) {
    const m = R._naissance({ espece, biome: null, x: boss.x + 900, y: boss.y + 900 });
    const ev = evNul();
    m.pv = 0; R._abat(m, j, ev);
    sacsTemoin += ev.butins.length;
    xpTemoin += ev.kills.length;
  }
  ok(sacsTemoin > 0,
     `temoin : ${sacsTemoin} sacs sur ${COMBIEN} morts — cette espece PEUT laisser quelque chose`);

  /* Et les appelees, marquees comme le moteur les marque. */
  let sacs = 0, xp = 0;
  for (let k = 0; k < COMBIEN; k++) {
    const m = R._naissance({ espece, biome: null, x: boss.x + 900, y: boss.y + 900 });
    m.invoquePar = boss.id; m.sansButin = 1;
    const ev = evNul();
    m.pv = 0; R._abat(m, j, ev);
    sacs += ev.butins.length;
    xp += ev.kills.length;
  }
  eq(sacs, 0, `appelees : zero sac sur ${COMBIEN} morts, quand le temoin en donne ${sacsTemoin}`);
  /* L XP, elle, tombe : elles se battent vraiment, et un combat qui ne fait
     pas monter est un combat qu on evite. */
  eq(xp, COMBIEN, 'mais elles rapportent toutes de l XP');
}

/* ================== 5. IL COMPTE LES SIENS ================== */
console.log('\n-- le plafond compte SES appels, pas la salle --');
{
  const { R, j, boss } = scene();
  const a = AVEC_APPEL[0];
  /* On remplit la salle de creatures de la MEME espece, mais nees autrement.
     Si le plafond comptait la salle, le boss serait muet — au milieu d'une
     meute qu il n a pas faite. */
  for (let k = 0; k < a.appel.plafond + 4; k++) {
    const m = R._naissance({ espece: a.appel.espece, biome: null,
                             x: boss.x + 600 + k * 20, y: boss.y + 600 });
    R.monstres.push(m);
  }
  tient(R, boss, j, a.pv, 60);
  ok(sbires(R, boss).length > 0,
     `il appelle quand meme (${sbires(R, boss).length}), malgre ${a.appel.plafond + 4} creatures posees a cote`);
}

/* ================== 6. LA PAGE L'APPREND ================== */
console.log('\n-- l evenement part vers la page --');
{
  const { R, j, boss } = scene();
  const evs = tient(R, boss, j, AVEC_APPEL[0].pv, 60);
  const appels = evs.flatMap((e) => e.appels || []);
  ok(appels.length > 0, `${appels.length} appels annonces`);
  ok(appels.every((a) => a.combien > 0 && a.espece && a.par === BOSS),
     'chacun dit combien, de quelle espece, et qui appelle');
  ok(appels.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y)),
     'et OU — sans le point, la page ne peut rien montrer');
}

/* ================== 7. LA MUE ENTRE DEUX PHASES ==================
 *
 * Deux secondes ou le boss ne peut PAS etre touche.
 *
 * ---- CE QUE CETTE SECTION GARDE ----
 *
 * Une creature perd de la vie a HUIT endroits : nos tirs, la foudre du fruit,
 * les gestes du familier, la brulure, les epines. Poser l'invulnerabilite
 * dans un seul d'entre eux l'aurait laissee traverser par les sept autres, et
 * le boss serait mort pendant sa transformation.
 *
 * On mesure donc sur PLUSIEURS chemins, et pas seulement sur le tir — le tir
 * est celui qu'on penserait a verifier, donc celui qui ne prouve rien.
 */
{
  console.log('\n-- il est intouchable pendant qu il mue --');
  const seuils = [];
  for (let i = 1; i < monde.nbPhases(BOSS); i++) {
    /* Le point de bascule, demande au moteur : ecrire « 0,8 » ici ferait
       passer l'essai le jour ou l'on decale les phases. */
    for (let q = 1000; q >= 0; q--) {
      const pv = PVMAX * (q / 1000);
      if (monde.phaseMonstre(BOSS, pv, PVMAX) === i) { seuils.push(pv); break; }
    }
  }
  ok(seuils.length > 0, `${seuils.length} passages de phase a verifier`);

  for (let k = 0; k < seuils.length; k++) {
    const { R, j, boss } = scene();
    j.x = boss.x - 200; j.y = boss.y;
    R.pas(0.1);                       // la phase de depart est notee
    eq(boss.invulPhase || 0, 0, `phase ${k + 1} : il ne nait pas invulnerable`);
    boss.pv = seuils[k];
    R.pas(0.1);                       // le seuil est franchi
    ok(boss.invulPhase > 0,
       `il mue en passant a la phase ${k + 2} (${boss.invulPhase.toFixed(1)}s)`);

    /* ---- ON LE FRAPPE PAR TROIS CHEMINS DIFFERENTS ---- */
    const pv0 = boss.pv;
    for (let i = 0; i < 12; i++) {
      R.tire('0xaaa', 0);                       // nos projectiles
      boss.feu = 3; boss.feuTaux = 200; boss.feuPar = j.addr;  // la brulure
      j.x = boss.x - 200; j.y = boss.y;
      R.pas(0.1);
    }
    eq(boss.pv, pv0, 'ni les tirs ni la brulure ne l entament');
    /* Et la morsure du familier non plus : c'est le chemin qu'on oublie. */
    const av = boss.pv;
    R._familierAgit(j, 'mord', monde.familierEffet('mord', 100), { fam: [], touches: [] });
    eq(boss.pv, av, 'ni le familier');
  }

  /* ---- ET ELLE FINIT ---- */
  const { R, j, boss } = scene();
  j.x = boss.x - 200; j.y = boss.y;
  R.pas(0.1);
  boss.pv = seuils[0];
  R.pas(0.1);
  for (let t = 0; t < monde.PHASE_MUE + 0.5; t += 0.1) {
    j.x = boss.x - 200; j.y = boss.y; R.pas(0.1);
  }
  eq(boss.invulPhase, 0, 'la mue se termine toute seule');
  const pv1 = boss.pv;
  for (let i = 0; i < 12; i++) { R.tire('0xaaa', 0); j.x = boss.x - 200; j.y = boss.y; R.pas(0.1); }
  ok(boss.pv < pv1, `et les coups repassent (${Math.round(pv1 - boss.pv)} degats)`);

  /* ---- LA PAGE L'APPREND ---- */
  const e = R.etatPour('0xaaa');
  const vu = (e.monstres || []).find((x) => x.e === BOSS);
  ok(vu, 'le boss est dans l instantane');
  ok(vu.ph > 0 && vu.phMax > 1,
     `avec sa phase (${vu.ph}/${vu.phMax}) — sans quoi le temps mort n a pas de sens`);
}

console.log(`\nappels.test.js : ${n} verifications OK`);
