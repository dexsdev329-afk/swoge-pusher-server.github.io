'use strict';
/*
 * LES PLAQUES DE BRAISE : DE LA LAVE A MEME LE SOL.
 *
 * ---- CE QU'ELLES SONT, ET CE QU'ELLES NE SONT PAS ----
 *
 * Elles ne bloquent pas et ne s'annoncent pas : c'est du TERRAIN. Ce qui les
 * rend difficiles, c'est qu'elles ne prennent aucune decision — c'est le
 * joueur qui entre dedans, ou le boss qui l'y projette.
 *
 * ---- LES QUATRE FACONS DE LES RATER ----
 *
 * 1. ELLES MANGENT LA SALLE. La pose est ALEATOIRE. Une moyenne acceptable
 *    cache toujours un tirage qui ne l'est pas : au-dela d'une certaine part
 *    de sol couvert, il n'y a plus de bonne place, seulement des moins
 *    mauvaises — et ce n'est plus de la difficulte, c'est un couloir. On
 *    mesure donc sur des centaines de plans, jamais sur un.
 * 2. ELLES FUSIONNENT. Deux disques qui se touchent font un lac, et un lac
 *    n'est plus quelque chose qu'on contourne.
 * 3. ELLES DEBORDENT DANS LA PIERRE. Une plaque a moitie dans le mur n'offre
 *    plus de contournement de ce cote-la — c'est-a-dire exactement la ou le
 *    joueur recule.
 * 4. ELLES TRAVERSENT L'EGIDE. La lave est la SIXIEME source de degats du
 *    jeu. La cinquieme — le coup au contact — a traverse l'egide pendant des
 *    semaines parce qu'elle appelait la fonction d'a-cote. Celle-ci est
 *    verifiee le jour ou elle nait.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/braises-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const monde = require('./monde');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const B = monde.BRAISES;
const CLE = 'sanctuaire';
const fiche = (def) => ({ skin: 'andy', nom: 'Alice',
  stats: { att: 60, def, spd: 40, dex: 40, vit: 0, wis: 30, hp: 4000, mp: 400 },
  famille: 'lame', degats: [40, 60] });

function donjon() {
  const plan = monde.planDeDonjon(CLE, Math.random);
  const R = new Realm({ plan });
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  return { R, plan };
}

console.log('-- ce que le monde declare --');
ok(B && B.rayon > 0 && B.parSeconde > 0,
   `la plaque fait ${B.rayon} de rayon et coute ${B.parSeconde} par seconde`);
ok(B.partMax > 0 && B.partMax < 0.5,
   `elle ne peut couvrir plus de ${(B.partMax * 100).toFixed(0)} % du sol de la salle`);
ok(!!monde.EFFETS[B.effet], `et elle allume « ${B.effet} »`);

/* ================== LA POSE ================== */
console.log('\n-- la pose, sur trois cents plans --');
{
  const D = monde.DONJONS[CLE];
  ok(D.braises > 0, `le Sanctuaire en declare ${D.braises}`);
  let pireCouvert = 0, fusions = 0, debords = 0, mini = Infinity, total = 0;
  for (let k = 0; k < 300; k++) {
    const plan = monde.planDeDonjon(CLE, Math.random);
    const liste = plan.braises;
    total += liste.length;
    mini = Math.min(mini, liste.length);
    /* La part de sol couverte. On demande la surface au DONJON : le nombre de
       tuiles qu'il a envoyees, fois l'aire d'une tuile. Recopier « 19 x 19 »
       ici, c'est un chiffre a tenir d'accord avec monde.js — et l'essai
       mentirait le jour ou la salle change de taille. */
    const solTotal = plan.tuiles.length * monde.TUILE * monde.TUILE;
    const couvert = liste.reduce((t, b) => t + Math.PI * b.r * b.r, 0);
    pireCouvert = Math.max(pireCouvert, couvert / solTotal);
    for (let i = 0; i < liste.length; i++) {
      for (let j2 = i + 1; j2 < liste.length; j2++) {
        const dx = liste[i].x - liste[j2].x, dy = liste[i].y - liste[j2].y;
        if (Math.hypot(dx, dy) < B.rayon * B.ecart - 1) fusions++;
      }
      /* Deborder, c'est etre pose la ou le donjon n'a pas de sol. On le lit
         dans les TUILES envoyees, comme la page le lira : si le centre plus
         le rayon tombe hors de la forme, la plaque mord la pierre. */
      const dedans = (x, y) => plan.tuiles.some(([c, l]) =>
        x >= c * monde.TUILE && x < (c + 1) * monde.TUILE &&
        y >= l * monde.TUILE && y < (l + 1) * monde.TUILE);
      const b = liste[i];
      for (const [ax, ay] of [[b.r, 0], [-b.r, 0], [0, b.r], [0, -b.r]]) {
        if (!dedans(b.x + ax, b.y + ay)) { debords++; break; }
      }
    }
  }
  ok(mini >= monde.DONJONS[CLE].braises - 2,
     `on en pose au moins ${mini} sur ${monde.DONJONS[CLE].braises} demandees (moyenne ${(total / 300).toFixed(1)})`);
  ok(pireCouvert < B.partMax,
     `le pire plan couvre ${(pireCouvert * 100).toFixed(1)} % du sol, sous les ${(B.partMax * 100).toFixed(0)} % permis`);
  eq(fusions, 0, 'aucune paire de plaques ne fusionne, sur 300 plans');
  eq(debords, 0, 'aucune plaque ne mord la pierre, sur 300 plans');
}

console.log('\n-- un donjon qui n en declare pas n en a pas --');
{
  const sans = Object.keys(monde.DONJONS).filter((c) => !monde.DONJONS[c].braises);
  ok(sans.length > 0, `${sans.length} donjon(s) sans braises : ${sans.join(', ')}`);
  for (const c of sans) {
    const p = monde.planDeDonjon(c, Math.random);
    eq(p.braises.length, 0, `« ${c} » n'en pose aucune`);
  }
  /* Et le monde ouvert non plus : la liste doit exister vide, pas manquer. */
  const R = new Realm({});
  ok(Array.isArray(R.braises) && R.braises.length === 0,
     'le monde ouvert a une liste vide, pas un champ absent');
}

/* ================== CE QU'ELLE COUTE ================== */
console.log('\n-- rester dessus --');
const pose = (R, plan, def) => {
  R.rejoint('0xaaa', fiche(def === undefined ? 30 : def));
  const j = R.joueurs.get('0xaaa');
  const b = plan.braises[0];
  j.x = b.x; j.y = b.y;
  return j;
};
const avance = (R, s) => { for (let t = 0; t < s - 1e-9; t += 0.1) R.pas(0.1); };
{
  const { R, plan } = donjon();
  const j = pose(R, plan, 30);
  j.vit = 0;                                   // la regeneration ne doit pas brouiller la mesure
  const pv0 = j.pv;
  avance(R, 1.0);
  const perdu = pv0 - j.pv;
  /* Le chiffre attendu vient de la TABLE, pas d'ici. La brulure s'ajoute :
     on borne par le bas avec la lave seule, par le haut avec les deux. */
  const brul = monde.EFFETS[B.effet].parSeconde;
  ok(perdu >= B.parSeconde - 2,
     `une seconde dessus coute ${perdu} points, au moins les ${B.parSeconde} de la plaque`);
  ok(perdu <= B.parSeconde + brul + 2,
     `et pas plus que la plaque plus sa brulure (${B.parSeconde} + ${brul})`);
  ok(j[B.effet] > 0, `et l'on ressort en « ${B.effet} »`);
}

console.log('\n-- a cote, rien --');
{
  const { R, plan } = donjon();
  R.rejoint('0xaaa', fiche(30));
  const j = R.joueurs.get('0xaaa');
  const b = plan.braises[0];
  /* Juste en dehors : c'est le bord qu'on verifie, pas l'autre bout de la
     salle — un essai pose a mille unites passerait meme si le rayon etait
     faux de moitie. */
  j.x = b.x + b.r + 6; j.y = b.y; j.vit = 0;
  const pv0 = j.pv;
  avance(R, 1.0);
  eq(pv0 - j.pv, 0, `six unites en dehors du bord, on ne perd rien`);
}

console.log('\n-- l armure ne protege pas, l egide si --');
{
  /* Sans armure et avec la meilleure : le meme prix. C'est ce qui donne a un
     personnage bien defendu une raison de regarder ou il marche. */
  const perte = (def) => {
    const { R, plan } = donjon();
    const j = pose(R, plan, def); j.vit = 0;
    const pv0 = j.pv; avance(R, 1.0); return pv0 - j.pv;
  };
  const nu = perte(0), blinde = perte(200);
  eq(blinde, nu, `deux cents de defense n'y changent rien (${nu} dans les deux cas)`);
}
{
  const { R, plan } = donjon();
  const j = pose(R, plan, 30); j.vit = 0;
  j.egide = monde.POUVOIRS[monde.POUVOIR_PAR_STAT.def].duree;
  const pv0 = j.pv;
  avance(R, 1.0);
  eq(pv0 - j.pv, 0, 'et sous egide, la lave ne prend rien — la sixieme source est bouchee');
}

console.log('\n-- traverser coute, camper tue --');
{
  /* La promesse de reglage : on PEUT traverser. Le prix se calcule avec la
     vitesse du jeu et le diametre de la table, pas avec un chiffre ecrit ici. */
  const secondes = (B.rayon * 2) / monde.VITESSE_JOUEUR;
  const prix = secondes * B.parSeconde;
  ok(prix < 4000 * 0.12,
     `la traverser en courant coute ${prix.toFixed(0)} points (${secondes.toFixed(2)} s), moins d'un huitieme d'une reserve de 4000`);
  /* Et camper tue, sans qu'on ait a l'ecrire : on laisse le temps passer. */
  const { R, plan } = donjon();
  const j = pose(R, plan, 30); j.vit = 0;
  let ev = null;
  for (let t = 0; t < 240 && j.pv > 0; t += 0.1) ev = R.pas(0.1);
  eq(j.pv, 0, `y rester tue (en ${(4000 / B.parSeconde).toFixed(0)} s environ)`);
  ok(ev.morts.some((m) => m.addr === '0xaaa'), 'et la mort est annoncee');
}

console.log('\n-- le compteur existe des la naissance --');
{
  const { R, plan } = donjon();
  const j = pose(R, plan, 30);
  eq(j.braiseReste, 0, 'braiseReste part a zero, jamais undefined');
  /* La preuve que ca compte : `undefined + x` rend NaN, et des points de vie
     NaN ne redescendent jamais a zero — le joueur serait immortel. */
  avance(R, 0.5);
  ok(Number.isFinite(j.pv) && Number.isFinite(j.braiseReste),
     `et les deux restent des nombres reels (pv ${j.pv})`);
}

console.log(`\nbraises.test.js : ${n} verifications OK`);
