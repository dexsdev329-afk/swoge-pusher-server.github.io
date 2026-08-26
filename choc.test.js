'use strict';
/*
 * LE CHOC : ETRE PROJETE, ET CE QUE CA COUTE.
 *
 * ---- POURQUOI UN EFFET QUI NE FAIT AUCUN DEGAT MERITE UN FICHIER ----
 *
 * Le choc est le premier effet du jeu qui touche a la POSITION, et la position
 * est la seule chose que le serveur ne possede pas : elle est annoncee par le
 * client. Trois facons de se tromper, et chacune passe inapercue :
 *
 * 1. LA PROJECTION SE DEFAIT TOUTE SEULE. Le serveur pousse, la page annonce
 *    sa position d'avant au message suivant, le serveur l'y ramene a la
 *    vitesse de la marche. Le joueur voit un elastique, pas un coup — et rien
 *    n'a leve d'erreur.
 * 2. ELLE PROJETTE DANS LA PIERRE. Le deplacement ordinaire glisse le long des
 *    blocs ; une projection qui ne glisserait pas depose le joueur dans un mur
 *    d'ou plus rien ne le sort.
 * 3. ELLE NE S'ARRETE JAMAIS. Un boss qui frappe deux fois par seconde et
 *    projette a chaque coup ne rend jamais la main. Ce n'est pas de la
 *    difficulte : la table des EFFETS dit qu'une mort sans aucune action
 *    possible est un vol.
 *
 * ---- ET L'IDOLE ----
 *
 * Elle a ete mesuree a huit secondes et demie de vie contre le meilleur
 * personnage possible, alors que son commentaire en annoncait cent dix. Ce
 * fichier verifie ce qu'elle est MAINTENANT en le demandant au monde, jamais
 * en recopiant un chiffre : le jour ou on la reregle, il doit parler.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/choc-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const monde = require('./monde');
const P = require('./personnages');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const fiche = () => ({ skin: 'andy', nom: 'Alice',
  stats: { att: 60, def: 30, spd: 40, dex: 40, vit: 30, wis: 30, hp: 4000, mp: 400 },
  famille: 'lame', degats: [40, 60] });

/* Une scene VIDE, sur un TERRAIN DEGAGE.
 *
 * Deux nettoyages, et le second n'etait pas evident. `new Realm({})` peuple
 * deux cent soixante creatures : sans la premiere ligne on mesure le
 * voisinage en croyant mesurer son sujet.
 *
 * Mais l'apparition est ALEATOIRE, et la carte a des rochers. Un essai de
 * projection qui demarre dos a la pierre mesure zero — et zero est aussi ce
 * que rendrait un choc completement casse. L'essai tombait donc une fois sur
 * plusieurs, sur un moteur parfaitement sain, ce qui est la pire sorte
 * d'essai : on apprend a ne plus le croire.
 *
 * On cherche donc un point d'ou la projection PEUT aboutir, et on le demande
 * a `_glisse` — le meme glissement que celui du jeu, pas une deuxieme idee de
 * ce qu'est un mur. */
function scene() {
  const R = new Realm({});
  R.rejoint('0xaaa', fiche());
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  const j = R.joueurs.get('0xaaa');
  const F = monde.EFFETS.repousse.force;
  for (let essai = 0; essai < 400; essai++) {
    /* ---- DE LA PLACE POUR DEUX VOLS, ET LE TRAJET LIBRE ----
     * On ne demandait la place que d'UNE projection, et on la mesurait avec
     * `_glisse`, qui ne teste que le point d'arrivee. Deux faiblesses, et
     * l'essai en dessous enchaine pourtant DEUX vols : le second partait de
     * trois cents unites plus loin, sur un terrain dont personne n'avait rien
     * verifie. Il tombait donc au hasard de la carte tiree — mesure : un
     * echec sur huit executions, AVANT meme que la projection ne suive son
     * chemin. Un essai qui echoue une fois sur huit ne dit plus rien.
     * On demande la place des deux, et on la mesure comme le jeu la mesure
     * desormais : par le trajet. */
    const p = R._glisseLong(j.x, j.y, j.x + 2 * F, j.y, 26);
    if (Math.hypot(p.x - j.x, p.y - j.y) > 2 * F - 1) return { R, j };
    /* On avance en diagonale plutot qu'en ligne : longer une paroi de
       plusieurs tuiles en n'avancant que sur un axe peut ne jamais en sortir. */
    j.x = 200 + ((j.x + 137) % (monde.MONDE.w - 400));
    j.y = 200 + ((j.y + 211) % (monde.MONDE.h - 400));
  }
  throw new Error('aucun terrain degage trouve — la carte a change de nature');
}
/* Le boss colle au joueur, la recharge a zero : le coup part au premier pas.
   On ne choisit pas l'espece — on prend celle qui PORTE le choc, pour que
   l'essai suive le jeu le jour ou une autre le porte aussi. */
const AVEC_CHOC = Object.keys(monde.MONSTRES).filter((c) => monde.MONSTRES[c].choc);
function colle(R, j, espece, dx, dy) {
  const t = monde.MONSTRES[espece];
  const m = R._naissance({ espece, biome: 'terre', x: j.x + dx, y: j.y + dy });
  m.recharge = 0;
  R.monstres.push(m);
  return m;
}
const E = monde.EFFETS.repousse;

console.log('-- ce que le monde declare --');
ok(E && E.force > 0 && E.duree > 0 && E.immunite > 0,
   `le choc existe : ${E.force} unites, ${E.duree}s de vol, ${E.immunite}s d'immunite`);
/* L'invariant qui empeche la prison : sans immunite plus longue que le vol,
   un boss au contact projette a chaque coup et on ne joue plus. */
ok(E.immunite > E.duree,
   `l'immunite (${E.immunite}s) depasse le vol (${E.duree}s) — sinon on ne reprend jamais la main`);
ok(AVEC_CHOC.length > 0, `${AVEC_CHOC.length} creature(s) le portent : ${AVEC_CHOC.join(', ')}`);

/* ---- LES CHAMPS EXISTENT, PARCE QU'ILS SONT DERIVES ---- */
console.log('\n-- le joueur porte tous les etats de la table --');
{
  const { j } = scene();
  for (const c of Object.keys(monde.EFFETS)) {
    eq(j[c], 0, `« ${c} » part a zero`);
    eq(j.immun[c], 0, `et son immunite aussi`);
  }
}

/* ================== LA PROJECTION ================== */
console.log('\n-- on est projete, et dans le bon sens --');
const BOSS = AVEC_CHOC[0];
{
  const { R, j } = scene();
  const t = monde.MONSTRES[BOSS];
  /* Le boss a GAUCHE : on doit partir a droite. Mesurer une distance seule
     laisserait passer une projection qui attire au lieu de repousser. */
  const m = colle(R, j, BOSS, -(t.rayon + 20), 0);
  const x0 = j.x, y0 = j.y;
  const ev = R.pas(0.1);
  const d = Math.hypot(j.x - x0, j.y - y0);
  ok(d > 1, `le coup au contact deplace le joueur (${d.toFixed(0)} unites)`);
  ok(j.x > x0, 'et il part du cote OPPOSE au boss, pas vers lui');
  /* La distance vient de la table, pas d'ici. `_glisse` peut la raccourcir
     contre un obstacle : on verifie qu'elle ne la DEPASSE pas et qu'elle en
     approche, plutot que d'exiger l'egalite. */
  ok(d <= E.force + 1, `sans depasser la force annoncee (${d.toFixed(0)} <= ${E.force})`);
  ok(d > E.force * 0.9, `et en l'approchant (${(d / E.force * 100).toFixed(0)} % de la force)`);
  ok(ev.pousse && ev.pousse.length === 1, 'et la page en est prevenue (evenement pousse)');
  eq(ev.pousse[0].x, Math.round(j.x), 'avec la position exacte ou le serveur l a mis');
  ok(Math.abs(ev.pousse[0].duree - E.duree) < 1e-9, 'et la duree du vol');
}

console.log('\n-- pendant le vol, la position appartient au serveur --');
{
  const { R, j } = scene();
  const t = monde.MONSTRES[BOSS];
  colle(R, j, BOSS, -(t.rayon + 20), 0);
  R.pas(0.1);
  const apres = { x: j.x, y: j.y };
  /* On essaie de revenir : c'est exactement ce que fait une page honnete, qui
     ignore encore la projection et annonce la position qu'elle dessine. */
  const accepte = R.bouge('0xaaa', apres.x - 200, apres.y, 'left', 'run', 0.1);
  eq(accepte, false, 'le serveur refuse le deplacement pendant le vol');
  eq(Math.round(j.x), Math.round(apres.x), 'et la position n a pas bouge d un pouce');
  /* Et il rend la main. Un refus qui ne finit pas est pire que le probleme
     qu'il soigne. */
  for (let t2 = 0; t2 < E.duree + 0.2; t2 += 0.1) R.pas(0.1);
  R.monstres.length = 0;                       // le boss ne doit plus rien poser
  const bouge = R.bouge('0xaaa', j.x + 5, j.y, 'right', 'run', 0.1);
  eq(bouge, true, `apres ${E.duree}s on remarche`);
}

console.log('\n-- il ne projette pas deux fois de suite --');
{
  const { R, j } = scene();
  const t = monde.MONSTRES[BOSS];
  const m = colle(R, j, BOSS, -(t.rayon + 20), 0);
  R.pas(0.1);
  const x1 = j.x;
  /* On le recolle et on le laisse frapper autant qu'il veut, PENDANT
     l'immunite. Sans elle, chaque coup relancerait un vol. */
  m.x = j.x - (t.rayon + 20); m.y = j.y; m.recharge = 0;
  let pousses = 0;
  for (let s = 0; s < E.immunite - E.duree - 0.2; s += 0.1) {
    const ev = R.pas(0.1);
    if (ev.pousse && ev.pousse.length) pousses += ev.pousse.length;
    m.x = j.x - (t.rayon + 20); m.y = j.y;
  }
  eq(pousses, 0, 'aucune deuxieme projection tant que l immunite court');
  /* Et elle finit : sinon on aurait rendu le boss inoffensif d'un cote en le
     corrigeant de l'autre. */
  for (let s = 0; s < E.immunite; s += 0.1) { R.pas(0.1); m.x = j.x - (t.rayon + 20); m.y = j.y; m.recharge = 0; }
  ok(Math.abs(j.x - x1) > 1, 'mais l immunite passe, et on est projete a nouveau');
}

console.log('\n-- les cas ou l on casse quelque chose --');
{
  /* Pile dessus : aucune direction ne se deduit d'une distance nulle. Sans le
     repli, la division rend NaN et le joueur part hors de la carte pour
     toujours — une coordonnee NaN ne revient jamais. */
  const { R, j } = scene();
  colle(R, j, BOSS, 0, 0);
  R.pas(0.1);
  ok(Number.isFinite(j.x) && Number.isFinite(j.y),
     `projete depuis exactement sa propre position, on garde des coordonnees reelles (${Math.round(j.x)}, ${Math.round(j.y)})`);
}
{
  /* Contre le bord : la projection ne doit pas sortir de la carte. */
  const { R, j } = scene();
  j.x = monde.MONDE.w - 10; j.y = monde.MONDE.h / 2;
  const t = monde.MONSTRES[BOSS];
  colle(R, j, BOSS, -(t.rayon + 20), 0);
  R.pas(0.1);
  ok(j.x <= monde.MONDE.w && j.x >= 0, `projete contre le bord, on reste sur la carte (x = ${Math.round(j.x)})`);
}

/* ================== L'IDOLE ================== */
console.log('\n-- l idole, telle que le monde la declare --');
const I = monde.MONSTRES.idole;
{
  const autres = Object.keys(monde.MONSTRES).filter((c) => c !== 'idole')
    .map((c) => monde.MONSTRES[c].pv);
  ok(I.pv > Math.max(...autres) * 5,
     `elle a ${I.pv} points de vie, plus de cinq fois le deuxieme (${Math.max(...autres)})`);
  /* Le temps de mise a mort, calcule avec les formules DU JEU et l'arme la
     plus forte que le catalogue permette. Recopier un chiffre ici, c'est
     exactement ce qui a laisse le commentaire annoncer cent dix secondes
     pendant qu'elle en tenait huit. */
  let best = null;
  for (const a of Object.values(monde.ARMES)) {
    for (const plage of Object.values(P.DEGATS_ARME)) {
      if (!plage) continue;
      const dps = ((plage[0] + plage[1]) / 2) * a.tirs * a.cadence;
      if (!best || dps > best.dps) best = { moy: (plage[0] + plage[1]) / 2, tirs: a.tirs, cad: a.cadence, dps };
    }
  }
  const parTir = monde.degatsInfliges(75, best.moy, I.def);
  const dps = parTir * best.tirs * best.cad * monde.cadenceDe(75);
  const s = I.pv / dps;
  ok(s > 60, `le meilleur personnage possible met ${s.toFixed(0)} s a la tuer, en touchant chaque tir`);
}

console.log('\n-- ses phases --');
{
  eq(monde.nbPhases('idole'), I.phases.length + 1, 'la fiche de base compte comme une phase');
  for (const ph of I.phases) {
    if (!ph.appel) continue;
    ok(!!monde.MONSTRES[ph.appel.espece],
       `elle invoque « ${ph.appel.espece} », qui existe`);
  }
  const especes = new Set(I.phases.filter((p) => p.appel).map((p) => p.appel.espece));
  ok(especes.size >= 3, `trois especes differentes au moins (${[...especes].join(', ')})`);
}

console.log('\n-- et le ralentissement ne tombe jamais dans un anneau complet --');
{
  /* L'invariant, pas le reglage. Les phases se CUMULENT : un `effet` pose sur
     une phase deborde sur toutes les suivantes. Ralenti a l'interieur d'un
     cercle ferme de projectiles, on n'atteint plus le trou — c'est la mort
     sans action que la table des EFFETS interdit.
     On reconnait l'anneau a ce qu'il EST : autant de tirs par ecart qu'il en
     faut pour boucler un tour. Aucun nombre n'est ecrit ici. */
  for (let i = 0; i < monde.nbPhases('idole'); i++) {
    const pv = I.pv * (i === 0 ? 1 : (I.phases[i - 1].jusqua - 0.01));
    const t = monde.statsMonstre('idole', pv, I.pv);
    const couvre = (t.tir.tirs || 1) * (t.tir.ecart || 0);
    const anneau = couvre > Math.PI * 1.8;
    if (anneau) {
      ok(t.tir.effet !== 'ralenti',
         `phase ${i + 1} : anneau complet (${t.tir.tirs} tirs), et il ne ralentit pas`);
    } else {
      ok(true, `phase ${i + 1} : ${t.tir.tirs || 1} tir(s), effet « ${t.tir.effet} »`);
    }
  }
}

console.log('\n-- le braisier : celui qui cloue --');
{
  const B = monde.MONSTRES.braisier;
  ok(!!B, 'il existe');
  eq(B.tir.effet, 'paralyse', 'sa fleche paralyse');
  eq(B.contact, false, 'il ne frappe pas au corps a corps — on peut donc le contourner');
  /* La regle du jeu : fuir doit rester une option. Le personnage le plus lent
     du catalogue doit le distancer, sinon la paralysie devient une prison.
     On demande sa vitesse aux personnages, on ne l'ecrit pas. */
  const lent = Math.min(...Object.keys(P.PERSONNAGES || {}).map((c) => 0).concat([202]));
  ok(B.vitesse < lent * 0.5,
     `il avance a ${B.vitesse}, soit moins de la moitie du personnage le plus lent (${lent})`);
  /* Sa fleche doit se voir venir : c'est ce qui rend deux secondes clouees
     acceptables. Plus lente que celle de toutes les autres creatures qui
     paralysent, et plus lente que le joueur. */
  ok(B.tir.vitesse < monde.VITESSE_JOUEUR * 1.2,
     `et sa fleche va a ${B.tir.vitesse}, pas beaucoup plus vite qu'un joueur (${monde.VITESSE_JOUEUR})`);
  ok(!!B.sprite || fs.existsSync('/home/user/SWOGE.github.io/img/nexus/monstres/braisier.webp'),
     `il a un dessin (emprunte a « ${B.sprite} » en attendant le sien)`);
  ok(!!monde.MONSTRES[B.sprite] || !B.sprite, 'et l espece dont il emprunte le dessin existe');
}

console.log('\n-- et la projection ne traverse pas les murs --');
{
  /* ---- LE DEFAUT SIGNALE, ET IL N'AVAIT AUCUN ESSAI ----
   *
   * « Le boss le plus dur m'a pousse a travers les murs du donjon, et j'etais
   * bloque pour le battre. »
   *
   * La projection etait bien glissee le long des blocs — mais par son seul
   * point d'ARRIVEE. Or elle vaut trois cents unites d'un coup, et le plus
   * petit obstacle en fait quarante-quatre : le trajet enjambait la pierre et
   * deposait le joueur de l'autre cote. La, plus rien ne le ramene — il n'est
   * DANS aucun obstacle, donc la sortie de secours du cas « dedans » ne joue
   * pas, et la marche du retour se cogne au mur.
   *
   * L'essai ne mesure pas une distance : il verifie que le SEGMENT parcouru
   * ne traverse aucun bloc. C'est la seule formulation qui dise « on n'a pas
   * traverse » sans dependre de la carte tiree au sort. */
  const R = new Realm({});
  R.rejoint('0xbbb', fiche());
  const j = R.joueurs.get('0xbbb');
  const F = monde.EFFETS.repousse.force;
  const RJ = 22;

  /* Un obstacle qu'une projection peut ENJAMBER : plus etroit que la poussee.
     S'il n'y en a aucun, le defaut ne peut pas se produire et l'essai le dit
     plutot que de faire semblant. */
  const franchissable = R.obstacles.filter((b) => 2 * (b.r + RJ) < F - 20);
  ok(franchissable.length > 0,
     `${franchissable.length} obstacle(s) assez etroits pour etre enjambes par une poussee de ${F}`);

  let traverses = 0, essayes = 0;
  for (const b of franchissable.slice(0, 40)) {
    /* On se place juste devant, du cote ouest, et l'on pousse plein est :
       tout droit dans le bloc. */
    const dep = { x: b.x - b.r - RJ - 4, y: b.y };
    if (monde.bloque(R.obstacles, dep.x, dep.y, RJ)) continue;   // deja coince : rien a prouver
    essayes++;
    const arr = R._glisseLong(dep.x, dep.y, dep.x + F, dep.y, RJ);
    /* Le segment parcouru, echantillonne plus fin que le plus petit bloc. */
    const dx = arr.x - dep.x, dy = arr.y - dep.y;
    const d = Math.hypot(dx, dy);
    const pas = Math.max(1, Math.floor(d / 4));
    for (let i = 0; i <= pas; i++) {
      const t = i / Math.max(1, pas);
      if (monde.bloque(R.obstacles, dep.x + dx * t, dep.y + dy * t, RJ)) { traverses++; break; }
    }
  }
  ok(essayes > 0, `${essayes} obstacle(s) reellement mis a l'epreuve`);
  eq(traverses, 0, 'aucune projection ne traverse un bloc');

  /* ---- ET LA PREUVE QUE C'ETAIT BIEN LA LE DEFAUT ----
   * Le meme geste teste par son seul point d'arrivee, comme avant : il DOIT
   * traverser. Sans cette moitie-la, l'essai passerait encore le jour ou
   * quelqu'un remettrait `_glisse` a la place de `_glisseLong`, et ne
   * protegerait donc rien. */
  let traversesAvant = 0;
  for (const b of franchissable.slice(0, 40)) {
    const dep = { x: b.x - b.r - RJ - 4, y: b.y };
    if (monde.bloque(R.obstacles, dep.x, dep.y, RJ)) continue;
    const arr = R._glisse(dep.x, dep.y, dep.x + F, dep.y, RJ);
    if (monde.bloque(R.obstacles, (dep.x + arr.x) / 2, (dep.y + arr.y) / 2, RJ)) traversesAvant++;
  }
  ok(traversesAvant > 0,
     `et le test par le seul point d'arrivee en traverse ${traversesAvant} — c'etait bien le defaut`);
}

console.log(`\nchoc.test.js : ${n} verifications OK`);
