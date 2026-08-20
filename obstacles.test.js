'use strict';
/*
 * CE QUI BLOQUE LE PASSAGE.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LA CARTE EST LA MEME POUR TOUT LE MONDE. Le serveur la construit et
 *    l'envoie ; la page ne la redevine pas. Un desaccord se verrait tout de
 *    suite — on marcherait dans un rocher, ou l'on serait arrete par du vide.
 * 2. ON GLISSE, ON NE COLLE PAS. Refuser le pas en bloc collerait au moindre
 *    frolement : on longe un obstacle en marchant en diagonale, et la
 *    composante qui passe doit passer.
 * 3. LES PROJECTILES S'ARRETENT AUSSI. Un mur qu'on traverse a l'arc n'est
 *    pas un mur, c'est une decoration — et le couvert n'existerait pas.
 * 4. PERSONNE NE NAIT DANS LA PIERRE. Ni joueur ni monstre : un colosse ne du
 *    dans un bloc y resterait pour toujours et se lirait comme un bug.
 * 5. LE COEUR RESTE DEGAGE. Un boss de trois cent quinze pixels coince entre
 *    deux rochers ne se combat pas, il se subit.
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
const FICHE = { skin: 'andy', nom: 'Dodexel', famille: 'lame',
                degats: P.DEGATS_ARME.commun,
                stats: { hp: 350, mp: 300, att: 28, def: 13 } };

// ================== 1. LA MEME CARTE, TOUJOURS
{
  const a = M.obstacles(alea(77));
  const b = M.obstacles(alea(77));
  eq(JSON.stringify(a), JSON.stringify(b),
     'la meme graine rend exactement la meme carte');
  const c = M.obstacles(alea(78));
  ok(JSON.stringify(a) !== JSON.stringify(c), 'une autre graine en rend une autre');
  eq(a.length, M.OBSTACLE.nombre, `${M.OBSTACLE.nombre} blocs`);

  /* Ils ne se chevauchent pas : deux rochers fondus se liraient comme un seul
     bloc de forme impossible, et le contour qu'on longe ne serait plus celui
     qu'on voit. */
  ok(a.every((q, i) => a.every((p, j) => i === j ||
       (q.x - p.x) ** 2 + (q.y - p.y) ** 2 >= (q.r + p.r) ** 2)),
     'aucun ne chevauche son voisin');

  /* ---- CHAQUE ANNEAU EN A ----
   * Une carte dont un anneau serait plat n'aurait pas d'obstacles : elle en
   * aurait par endroits, ce qui est autre chose. C'est justement l'anneau le
   * plus dur qui ne doit pas etre le seul terrain degage. */
  const parB = {};
  a.forEach((q) => { const b2 = M.biomeEn(q.x, q.y); parB[b2] = (parB[b2] || 0) + 1; });
  M.ANNEAUX.forEach((an) => {
    ok((parB[an.biome] || 0) > 0,
       `l anneau « ${an.biome} » en porte (${parB[an.biome] || 0})`);
  });

  /* Le dessin suit l'anneau : on lit l'obstacle comme on lit le sol. */
  ok(a.every((q) => q.t === M.OBSTACLE_BIOME[M.biomeEn(q.x, q.y)]),
     'chaque bloc porte le dessin de son anneau');

  /* ---- L'ARENE DU GARDIEN ---- */
  ok(!M.bloque(a, M.CENTRE.x, M.CENTRE.y, M.MONSTRES.gardien.rayon),
     'le centre exact reste libre, meme pour le plus gros du monde');
  ok(M.OBSTACLE.clairiere < M.ANNEAUX[0].jusqua * (M.MONDE.w / 2),
     `la clairiere (${M.OBSTACLE.clairiere}) est plus petite que l anneau de lave ` +
     `(${Math.round(M.ANNEAUX[0].jusqua * (M.MONDE.w / 2))}) — sinon le coeur serait plat`);
}

// ================== 2. LES COULOIRS NE SONT PAS LES MEMES POUR TOUS
{
  /* `bloque` prend le rayon de CE QUI SE DEPLACE. Deux rochers laissent donc
     passer une nuee la ou un colosse s'arrete, et c'est ce qui donne un
     interet a la petite taille au-dela du dessin. */
  const r = M.OBSTACLE.rayon;
  const paire = [{ i: 1, x: 1000, y: 1000 - (r + 30), r, t: 0 },
                 { i: 2, x: 1000, y: 1000 + (r + 30), r, t: 0 }];
  const passe = (rayon) => !M.bloque(paire, 1000, 1000, rayon);
  ok(passe(M.MONSTRES.nuee.rayon),
     `la nuee (rayon ${M.MONSTRES.nuee.rayon}) passe entre deux rochers ecartes de 30`);
  ok(!passe(M.MONSTRES.colosse.rayon),
     `le colosse (rayon ${M.MONSTRES.colosse.rayon}) ne passe pas`);
  ok(!passe(M.MONSTRES.gardien.rayon), 'le gardien non plus');
}

// ================== 3. ON GLISSE LE LONG, ON NE COLLE PAS
{
  const r = new Realm({ alea: alea(5) });
  const j = r.rejoint(A, FICHE);
  /* Un rocher pose juste a droite du joueur. */
  const bloc = { i: 999, x: j.x + 70, y: j.y, r: M.OBSTACLE.rayon, t: 0 };
  r.obstacles = [bloc];

  /* Droit dedans : on ne rentre pas. */
  const y0 = j.y;
  r.bouge(A, j.x + 40, j.y, 'right', 'run', 0.2);
  ok(M.bloque(r.obstacles, j.x, j.y, 22) === null,
     'on ne rentre pas dans le rocher');
  const avance = j.x;

  /* ---- ET EN DIAGONALE, ON LONGE ----
   * C'est la moitie qui compte. Un refus en bloc aurait fige le joueur des
   * qu'il frole la pierre : il aurait fallu reculer, se decaler, repartir —
   * en plein combat, ca se lit comme une commande qui ne repond plus. */
  r.bouge(A, j.x + 40, j.y + 40, 'right', 'run', 0.2);
  ok(j.y > y0 + 5, `le pas en diagonale FAIT AVANCER en y (${Math.round(j.y - y0)} unites)`);
  ok(M.bloque(r.obstacles, j.x, j.y, 22) === null, 'et toujours pas dans la pierre');

  /* Loin du rocher, rien ne change : le glissement ne doit pas rogner un pas
     honnete au milieu du vide. */
  const r2 = new Realm({ alea: alea(6) });
  const j2 = r2.rejoint(A, FICHE);
  r2.obstacles = [];
  r2.bouge(A, j2.x + 20, j2.y, 'right', 'run', 0.2);
  eq(Math.round(j2.x), Math.round(r2.joueurs.get(A).x), 'sans obstacle, le pas passe tel quel');
}

// ================== 4. LES MONSTRES NON PLUS
{
  const r = new Realm({ alea: alea(9) });
  const j = r.rejoint(A, FICHE);
  const bloc = { i: 1, x: j.x + 200, y: j.y, r: M.OBSTACLE.rayon, t: 0 };
  r.obstacles = [bloc];
  /* Un lime pose derriere le rocher, joueur en vue : il va vouloir le
     traverser en ligne droite. */
  r.monstres = [{ id: 1, espece: 'lime', biome: 'terre',
                  x: j.x + 400, y: j.y, ancreX: j.x + 400, ancreY: j.y,
                  pv: 60, pvMax: 60, dir: 'left', cible: null,
                  recharge: 0, rechargeT: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 }];
  for (let i = 0; i < 120; i++) r.pas(0.1);
  const m = r.monstres[0];
  ok(!M.bloque(r.obstacles, m.x, m.y, M.MONSTRES.lime.rayon),
     'apres douze secondes de poursuite, le lime n est pas DANS le rocher');
  ok(m.x > bloc.x, 'il l a contourne, il ne s est pas arrete devant');
}

// ================== 5. LES PROJECTILES S'ARRETENT
{
  /* Les notres. */
  const r = new Realm({ alea: alea(3) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];
  r.obstacles = [{ i: 1, x: j.x + 150, y: j.y, r: M.OBSTACLE.rayon, t: 0 }];
  r.tire(A, 0);
  eq(r.tirs.length, 1, 'la fleche part');
  for (let i = 0; i < 40 && r.tirs.length; i++) r.pas(0.05);
  eq(r.tirs.length, 0, 'et elle s arrete dans le rocher');
  ok(!r.tirs.some((t) => t.x > r.obstacles[0].x + r.obstacles[0].r),
     'aucune ne le traverse');

  /* Les leurs. Sans cette moitie, le couvert protegerait le monstre et pas
     nous — ce qui serait pire que pas de couvert du tout. */
  const r2 = new Realm({ alea: alea(4) });
  const j2 = r2.rejoint(A, FICHE);
  r2.monstres = [];
  r2.obstacles = [{ i: 1, x: j2.x + 150, y: j2.y, r: M.OBSTACLE.rayon, t: 0 }];
  r2.tirsM = [{ id: 1, x: j2.x + 300, y: j2.y, a: Math.PI, v: 300, reste: 5,
                att: 40, sprite: 'maudit' }];
  const pvAvant = j2.pv;
  for (let i = 0; i < 40 && r2.tirsM.length; i++) r2.pas(0.05);
  eq(r2.tirsM.length, 0, 'la fleche du monstre s arrete elle aussi');
  eq(j2.pv, pvAvant, 'et le joueur derriere le rocher ne prend rien');
}

// ================== 6. PERSONNE NE NAIT DANS LA PIERRE
{
  for (let g = 1; g <= 25; g++) {
    const r = new Realm({ alea: alea(g) });
    const j = r.rejoint(A, FICHE);
    ok(!M.bloque(r.obstacles, j.x, j.y, 22),
       `graine ${g} : on n arrive pas dans un rocher`);
  }
  /* Et les monstres. Un colosse ne dans un bloc y resterait pour toujours. */
  const r = new Realm({ alea: alea(12) });
  r.rejoint(A, FICHE);
  r.repeuple(900);
  ok(r.monstres.length > 0, `la carte se peuple (${r.monstres.length} creatures)`);
  const dedans = r.monstres.filter((m) =>
    M.bloque(r.obstacles, m.x, m.y, M.MONSTRES[m.espece].rayon));
  eq(dedans.length, 0, 'et aucune n est nee dans la pierre');
}

// ================== 7. ETRE DEDANS N'EST PAS UNE PRISON
/*
 * Rien ne devrait se trouver dans un bloc — ni joueur ni monstre n'y naissent,
 * et aucun des deux ne peut y entrer. Mais si ca arrive, refuser le pas
 * donnerait une creature figee pour toujours, ou pire un joueur qui ne peut
 * plus rien faire et ne comprend pas pourquoi.
 */
{
  const r = new Realm({ alea: alea(31) });
  const j = r.rejoint(A, FICHE);
  /* On le pose de force au milieu d'un rocher. */
  const bloc = { i: 1, x: j.x, y: j.y, r: M.OBSTACLE.rayon, t: 0 };
  r.obstacles = [bloc];
  ok(!!M.bloque(r.obstacles, j.x, j.y, 22), 'le voila dans la pierre');
  const x0 = j.x;
  /* Plusieurs pas : le rayon de blocage vaut 44 + 22, donc un seul pas de 60
     ne suffit pas a en sortir. Le premier essai s'arretait la et concluait
     trop tot. */
  for (let i = 0; i < 4; i++) r.bouge(A, j.x + 60, j.y, 'right', 'run', 0.3);
  ok(j.x > x0 + 100, `il peut EN SORTIR (${Math.round(j.x - x0)} unites)`);
  ok(!M.bloque(r.obstacles, j.x, j.y, 22), 'et il est vraiment dehors');

  /* Et une fois dehors, la regle normale reprend : il ne peut plus y rentrer. */
  const dehors = j.x;
  for (let i = 0; i < 6; i++) r.bouge(A, x0, j.y, 'left', 'run', 0.3);
  ok(!M.bloque(r.obstacles, j.x, j.y, 22),
     'et une fois dehors il ne peut plus y rentrer');
  ok(j.x < dehors, 'il a bien essaye de revenir');
}

// ================== 8. LES SALLES GARDEES
/*
 * Le monde n'avait qu'une seule raison d'avancer : les monstres y frappent
 * plus fort. C'est une pente, pas une DESTINATION. Une salle en est une —
 * on la voit de loin parce que son sol change, on sait ce qu'elle contient
 * avant d'entrer, et on choisit d'y aller.
 */
{
  const B = require('./boutique');
  const tire = (rar, a) => {
    const lot = B.ITEMS_DROP.filter((o) => o.rarete === rar);
    const o = lot[Math.min(lot.length - 1, Math.floor((a ? a() : 0) * lot.length))];
    return o ? { item: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete } : null;
  };

  /* ---- LA TABLE DIT LA VERITE ----
   * Elle annonce quatre salles. Une contrainte impossible en aurait place
   * zero sans un mot — c'est exactement ce qui est arrive la premiere fois,
   * quand on exigeait les quatre coins dans le meme anneau : une salle de
   * neuf tuiles a une diagonale de 1628 et l'anneau des cendres ne fait que
   * 691 d'epaisseur. */
  const voulu = Object.keys(M.SALLE_ANNEAUX)
    .reduce((t, b) => t + M.SALLE_ANNEAUX[b], 0);
  let court = 0;
  for (let g = 1; g <= 60; g++) {
    const s = M.salles(alea(g));
    if (s.length < voulu) court++;
    ok(s.length >= voulu - 1, `graine ${g} : ${s.length} salles sur ${voulu}`);
  }
  ok(court <= 6, `la carte porte ses ${voulu} salles presque toujours (${court} graines sur 60 en manquent une)`);

  /* Deterministe comme les rochers : le serveur la construit et l'envoie. */
  eq(JSON.stringify(M.salles(alea(9))), JSON.stringify(M.salles(alea(9))),
     'la meme graine rend les memes salles');

  {
    const s = M.salles(alea(3));
    /* Chacune dans SON anneau, et le butin suit l'anneau. */
    s.forEach((q) => {
      eq(M.biomeEn(q.x, q.y), q.biome, `la salle ${q.i} est bien dans « ${q.biome} »`);
      eq(q.butin, M.SALLE_BUTIN[q.biome], `et elle garde du ${M.SALLE_BUTIN[q.biome]}`);
    });
    /* La relique se MERITE quelque part : c'est le seul endroit du jeu ou
       elle ne soit pas un tirage au sort. */
    ok(s.some((q) => q.butin === 'relique'),
       'au moins une salle garde une relique');
    /* Elles ne se touchent pas : deux salles collees n'auraient plus deux
       portes mais un couloir. */
    ok(s.every((q, i) => s.every((p, j) => i === j ||
         Math.abs(q.x - p.x) >= q.cote || Math.abs(q.y - p.y) >= q.cote)),
       'aucune n en chevauche une autre');

    /* ---- UNE SEULE PORTE ----
     * C'est ce qui fait la difference entre une salle et un enclos. Sans
     * elle, les murs ne seraient qu'une decoration au sol. */
    const o = M.obstacles(alea(3), s);
    s.forEach((q) => {
      const demi = q.cote / 2 - M.SALLE.mur;
      const d = { nord: [0, -1], sud: [0, 1], ouest: [-1, 0], est: [1, 0] }[q.porte];
      ok(!M.bloque(o, q.x + d[0] * demi, q.y + d[1] * demi, 22),
         `la salle ${q.i} a sa porte au ${q.porte}, et elle est ouverte`);
      /* Les trois autres cotes sont fermes. */
      const autres = ['nord', 'sud', 'ouest', 'est'].filter((c) => c !== q.porte);
      autres.forEach((c) => {
        const dd = { nord: [0, -1], sud: [0, 1], ouest: [-1, 0], est: [1, 0] }[c];
        ok(!!M.bloque(o, q.x + dd[0] * demi, q.y + dd[1] * demi, 22),
           `et son cote ${c} est ferme`);
      });
      /* L'interieur est libre, meme pour le plus gros du monde. */
      ok(!M.bloque(o, q.x, q.y, M.MONSTRES.gardien.rayon),
         `l interieur de la salle ${q.i} tient un gardien`);
    });

    /* Aucun rocher dedans, ni colle contre : un rocher devant la porte en
       ferait une salle sans entree, et personne ne pourrait dire pourquoi. */
    const rochers = o.filter((q) => q.t < M.MUR_BASE);
    ok(rochers.every((q) => !s.some((y) => M.dansLaSalle(y, q.x, q.y))),
       'aucun rocher dans une salle');
    /* Et les murs n'ont pas mange le quota de rochers. */
    eq(rochers.length, M.OBSTACLE.nombre,
       `les ${M.OBSTACLE.nombre} rochers sont toujours la, murs en plus`);
  }

  /* ---- CHAQUE PIECE DE MUR EST TOURNEE ----
   * La planche ne porte qu'UNE orientation de chaque. Poser le meme angle aux
   * quatre coins en laisse trois a l'envers, et le mur se lit alors comme un
   * decor colle plutot que comme une piece batie. */
  {
    const s = M.salles(alea(3))[0];
    const murs = M.mursDe(s, 1);
    const n2 = M.SALLE.cote, demi2 = (n2 * M.TUILE) / 2;
    const x0 = s.x - demi2 + M.TUILE / 2, y0 = s.y - demi2 + M.TUILE / 2;
    const at = (c, l) => murs.filter((m) =>
      Math.round(m.x) === Math.round(x0 + c * M.TUILE) &&
      Math.round(m.y) === Math.round(y0 + l * M.TUILE))[0];

    const coins = [[0, 0], [n2 - 1, 0], [0, n2 - 1], [n2 - 1, n2 - 1]].map(([c, l]) => at(c, l));
    ok(coins.every(Boolean), 'les quatre coins existent');
    ok(coins.every((m) => m.t - M.MUR_BASE === 2), 'et portent tous la piece d angle');
    eq(new Set(coins.map((m) => m.a)).size, 4,
       'chacun avec un quart de tour DIFFERENT : ' + coins.map((m) => m.a).join(','));

    /* Les segments droits, eux, sont deja dans le bon sens : les tourner
       serait du travail rendu a l'identique. */
    const hautMilieu = at(Math.floor(n2 / 2) - 2, 0);
    ok(hautMilieu && hautMilieu.t - M.MUR_BASE === 0 && !hautMilieu.a,
       'un segment horizontal ne tourne pas');
    const gaucheMilieu = at(0, Math.floor(n2 / 2) - 2);
    ok(gaucheMilieu && gaucheMilieu.t - M.MUR_BASE === 1 && !gaucheMilieu.a,
       'un segment vertical non plus');

    /* Tous les quarts de tour sont des quarts de tour. */
    ok(murs.every((m) => [0, 1, 2, 3].indexOf(m.a || 0) >= 0),
       'aucune rotation batarde');
  }

  /* ---- VIDER LA SALLE LAISSE SON BUTIN ----
   * Une fois. Sans le drapeau, un sac naitrait a chaque pas tant que la salle
   * est vide — dix par seconde. */
  {
    const r = new Realm({ alea: alea(3), tireObjet: tire });
    const j = r.rejoint(A, FICHE);
    const s = r.salles.filter((q) => q.butin === 'relique')[0];
    ok(!!s, 'une salle a relique existe');
    const dedans = r.monstres.filter((m) => m.salle === s.i);
    eq(dedans.length, M.SALLE.gardiens, `${M.SALLE.gardiens} gardiens dedans`);
    ok(dedans.every((m) => m.espece === 'gardien'), 'et ce sont des gardiens');
    ok(dedans.every((m) => !M.bloque(r.obstacles, m.x, m.y, M.MONSTRES.gardien.rayon)),
       'aucun n est ne dans un mur');

    r.sacs = [];
    r.pas(0.1);
    eq(r.sacs.length, 0, 'tant qu ils vivent, rien ne tombe');

    dedans.forEach((m) => { m.pv = 0; });
    r.pas(0.1);
    eq(r.sacs.length, 1, 'les abattre laisse UN sac');
    eq(r.sacs[0].sac, M.SAC_DE_RARETE.relique,
       `dans un sac ${M.SAC_DE_RARETE.relique}`);
    eq(B.item(r.sacs[0].contenu[0].item).rarete, 'relique',
       'et il contient bien une relique');
    ok(B.item(r.sacs[0].contenu[0].item).drop, 'qui ne se vend nulle part');
    eq(Math.round(r.sacs[0].x), Math.round(s.x), 'pose au centre de la salle');

    /* Et une seule fois. */
    for (let i = 0; i < 30; i++) r.pas(0.1);
    eq(r.sacs.length, 1, 'et il ne s en pose pas un a chaque pas');

    /* ---- LES GARDIENS REVIENNENT, MAIS PAS SUR LE DOS DU JOUEUR ----
     * Voir deux gardiens apparaitre autour de soi n'est pas un defi, c'est
     * une embuscade sans cause. */
    j.x = s.x; j.y = s.y;
    s.rearme = 0.05;
    r.pas(0.1);
    eq(r.monstres.filter((m) => m.salle === s.i && m.pv > 0).length, 0,
       'personne ne renait pendant qu on est dans la piece');
    ok(s.rearme > 0, 'le rearmement est simplement repousse');

    /* Une fois sorti, ils reviennent. */
    j.x = s.x + s.cote * 3; j.y = s.y;
    s.rearme = 0.05;
    r.pas(0.1);
    eq(r.monstres.filter((m) => m.salle === s.i && m.pv > 0).length, M.SALLE.gardiens,
       'une fois sorti, la salle se rearme');
    eq(s.vide, false, 'et elle redevient gardee');
  }
}

console.log('obstacles.test.js : ' + n + ' verifications OK');
