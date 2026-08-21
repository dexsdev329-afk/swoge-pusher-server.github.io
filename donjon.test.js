'use strict';
/*
 * LE DONJON — une deuxieme simulation, derriere une porte.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LES DEUX MONDES NE SE VOIENT PAS. C'est toute la raison d'avoir choisi une
 *    deuxieme simulation plutot qu'un numero d'etage : l'isolation doit etre une
 *    STRUCTURE, pas une verification qu'on peut oublier dans une des six boucles
 *    de combat. Ce fichier la verifie quand meme — parce qu'une structure qu'on
 *    croit avoir et qu'on n'a pas est pire qu'une verification qu'on sait
 *    fragile.
 * 2. ON PEUT TOUJOURS SORTIR. Un donjon dont on ne ressort pas serait, sur un
 *    jeu ou la mort detruit un equipement paye en argent reel, un vol.
 * 3. LE DONJON SE VIDE. Il ne se repeuple pas : c'est ce qui en fait une
 *    expedition et non un terrain de chasse.
 * 4. LE FOND VAUT LA PORTE. Le boss du donjon doit etre plus dur que la
 *    creature qui l'ouvre — sinon on aurait traverse trois salles pour trouver
 *    du repos.
 * 5. LA FORME EST BATIE, PAS ECRITE. Les murs se deduisent du sol ; un donjon
 *    avec un trou dedans, ou un couloir bouche, ne doit pas pouvoir exister.
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
                degats: P.DEGATS_ARME.mythique,
                stats: { hp: 900, mp: 300, att: 60, def: 40, spd: 20, dex: 20 } };
const PIECE = (r) => ({ item: 1, cle: 'dj_test', nom: 'Test', rarete: r });

function donjon(graine) {
  return new Realm({ alea: alea(graine || 1),
                     plan: M.planDeDonjon('forge', alea(graine || 1)),
                     tireObjet: (r) => PIECE(r) });
}

// ================== 1. LA FORME TIENT DEBOUT
{
  const plan = M.planDonjon();
  ok(plan.sol.size > 300, `le donjon fait ${plan.sol.size} tuiles de sol`);
  eq(plan.salles.length, M.DONJON_SALLES.length, 'trois salles, comme annonce');

  /* ---- IL EST D'UN SEUL TENANT ----
   * Une salle qu'un couloir manquant isolerait serait un donjon dont le fond
   * est inaccessible : on tournerait dans les deux premieres pieces sans jamais
   * comprendre qu'il en manque une. On le verifie en MARCHANT : un remplissage
   * depuis la premiere tuile doit atteindre toutes les autres. */
  const vus = new Set();
  const file = [[...plan.sol][0]];
  vus.add(file[0]);
  while (file.length) {
    const [c, l] = file.pop().split(',').map(Number);
    for (const [dc, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = (c + dc) + ',' + (l + dl);
      if (plan.sol.has(k) && !vus.has(k)) { vus.add(k); file.push(k); }
    }
  }
  eq(vus.size, plan.sol.size, 'on atteint tout le sol depuis la premiere tuile');

  /* ---- ET IL EST FERME ----
   * Toute tuile de sol qui touche le vide doit toucher un MUR. Un trou d'une
   * seule tuile suffirait a sortir du donjon et a se retrouver dans le noir,
   * hors de toute salle, sans rien pour revenir. */
  const murs = M.mursDonjon(plan, 1);
  const parCle = new Set(murs.map((m) => Math.round(m.x / M.DONJON_TUILE - 0.5) + ',' +
                                          Math.round(m.y / M.DONJON_TUILE - 0.5)));
  let trous = 0;
  for (const k of plan.sol) {
    const [c, l] = k.split(',').map(Number);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dl = -1; dl <= 1; dl++) {
        if (!dc && !dl) continue;
        const v = (c + dc) + ',' + (l + dl);
        if (!plan.sol.has(v) && !parCle.has(v)) trous++;
      }
    }
  }
  eq(trous, 0, 'aucune tuile de sol ne donne sur le vide');

  /* ---- IL TIENT DANS LA CARTE ----
   * `bouge` borne la position a [0, MONDE] : un donjon qui deborderait aurait
   * des murs de l'autre cote d'une frontiere invisible, et l'on serait arrete
   * par du vide. */
  const dehors = murs.filter((m) => m.x < 0 || m.x > M.MONDE.w ||
                                    m.y < 0 || m.y > M.MONDE.h);
  eq(dehors.length, 0, `aucun des ${murs.length} blocs ne sort du cadre`);

  /* ---- LES BLOCS SONT DES BLOCS DE DONJON ----
   * `t` designe la planche. Au-dela de MUR_BASE on lit le mur de ruine, au-dela
   * de MUR_DONJON le mur de donjon. Un bloc mal marque se dessinerait avec la
   * pierre du dehors, et le donjon ressemblerait a une salle gardee. */
  eq(murs.filter((m) => m.t < M.MUR_DONJON || m.t >= M.MUR_DONJON + 4).length, 0,
     'chaque bloc porte une planche de donjon');
  eq(murs.filter((m) => m.a < 0 || m.a > 3).length, 0,
     'chaque quart de tour est un quart de tour');
  /* ET ILS BLOQUENT VRAIMENT. Un rayon nul aurait donne des murs qu'on
     traverse — le decor le plus decevant qui soit. */
  eq(murs.filter((m) => !(m.r > 0)).length, 0, 'et chacun a un rayon');
  /* LES PLANCHES DE DONJON NE MARCHENT PAS SUR CELLES DU MONDE. Deux `t` qui se
     recouvriraient feraient dessiner un rocher avec un morceau de mur, et
     l'inverse. */
  const monde0 = new Realm({ alea: alea(2) });
  const tMonde = new Set(monde0.obstacles.map((o) => o.t || 0));
  const tDonjon = new Set(murs.map((m) => m.t));
  eq([...tDonjon].some((t) => tMonde.has(t)), false,
     'aucune planche du donjon ne porte le numero d\'une planche du monde');
}

// ================== 2. LA POPULATION EST ECRITE, PAS TIREE
{
  const a = M.peuplementDonjon(alea(3));
  const b = M.peuplementDonjon(alea(3));
  eq(a.length, b.length, 'le meme hasard donne le meme donjon');
  eq(JSON.stringify(a), JSON.stringify(b), 'exactement le meme');

  /* UN SEUL BOSS. Deux fonderies dans la meme salle, ce sont sept mille deux
     cents points de vie et deux cercles au sol qui se recouvrent — une salle
     qu'on ne fait pas, pas une salle difficile. */
  eq(a.filter((m) => m.espece === M.DONJON.boss).length, 1, 'un seul boss');

  /* ET RIEN QUE LES ESPECES DU DONJON. Une creature d'anneau au milieu des
     machines dirait au joueur qu'il n'est pas vraiment ailleurs. */
  const permis = new Set(M.DONJON.especes.concat([M.DONJON.boss]));
  for (const m of a) ok(permis.has(m.espece), `« ${m.espece} » a sa place ici`);

  /* ET CES ESPECES-LA NE VIVENT NULLE PART AILLEURS. Leur `biomes` est vide :
     c'est ce qui les empeche de naitre dans un anneau. */
  for (const k of M.DONJON.especes.concat([M.DONJON.boss])) {
    eq(M.MONSTRES[k].biomes.length, 0,
       `« ${M.MONSTRES[k].nom} » ne nait dans aucun anneau`);
  }

  /* LE SAS EST VIDE. Arriver dans un donjon et se faire toucher avant d'avoir
     pose le pied par terre n'est pas une difficulte, c'est un piege. */
  const plan = M.planDonjon();
  const sas = plan.salles[0];
  const demi = (sas.cote / 2) * M.DONJON_TUILE;
  const dedans = a.filter((m) => Math.abs(m.x - sas.x) < demi &&
                                 Math.abs(m.y - sas.y) < demi);
  eq(dedans.length, 0, 'personne ne nous attend a l\'arrivee');

  /* PERSONNE DANS LA PIERRE. Un colosse ne dans un mur y resterait pour
     toujours, immobile, et se lirait comme un monstre casse. */
  const murs = M.mursDonjon(plan, 1);
  for (const m of a) {
    const t = M.MONSTRES[m.espece];
    eq(!!M.bloque(murs, m.x, m.y, t.rayon), false,
       `« ${t.nom} » ne nait pas dans un mur`);
  }
}

// ================== 3. LE FOND VAUT LA PORTE
{
  const boss = M.MONSTRES[M.DONJON.boss];
  const ouvreur = M.MONSTRES[M.DONJON.ouvreur];
  ok(boss.pv > ouvreur.pv,
     `le fond (${boss.pv} PV) est plus dur que la porte (${ouvreur.pv} PV)`);
  ok(boss.xp > ouvreur.xp, `et il rapporte plus (${boss.xp} contre ${ouvreur.xp})`);
  /* IL FRAPPE PLUS FORT, MAIS IL EST PLUS LENT. C'est ce qui rend la salle
     jouable : on ne le distance pas en marchant, on le distance en choisissant
     quand s'arreter pour tirer. */
  ok(boss.att > ouvreur.att, 'il frappe plus fort');
  ok(boss.vitesse < ouvreur.vitesse, 'et il court moins vite');
  /* ET SON BUTIN EST PROMIS. Une expedition dont la recompense se tire au sort
     n'est pas une expedition. */
  eq(M.BUTIN_GARANTI[M.DONJON.boss], 'relique', 'le fond rend une relique');
  for (let i = 0; i < 300; i++) {
    const b = M.butinDe(M.DONJON.boss, Math.random, 'donjon');
    if (!b || !b.contenu[0] || b.contenu[0].objet !== 'relique') {
      ok(false, 'le boss a rendu autre chose qu\'une relique');
    }
  }
  ok(true, 'trois cents morts, trois cents reliques');
}

// ================== 4. LA SIMULATION SE BATIT
{
  const r = donjon(11);
  ok(r.plan, 'elle porte son plan');
  eq(r.salles.length, 0, 'un donjon n\'a pas de salles gardees : c\'en est une');
  ok(r.obstacles.length > 100, `${r.obstacles.length} blocs de mur`);
  eq(r.monstres.length, M.peuplementDonjon(alea(11)).length,
     'et exactement la population prevue');

  /* ON ARRIVE DANS LE SAS, ET PAS AU BORD DE LA CARTE. */
  const j = r.rejoint(A, FICHE);
  const sas = M.planDonjon().salles[0];
  const d = Math.hypot(j.x - sas.x, j.y - sas.y);
  ok(d < sas.cote * M.DONJON_TUILE / 2, `on arrive dans le sas (${d.toFixed(0)} u du centre)`);
  /* ET PAS DANS UN MUR. */
  eq(!!M.bloque(r.obstacles, j.x, j.y, 24), false, 'ni dans la pierre');

  /* DEUX JOUEURS ARRIVENT AU MEME ENDROIT : c'est ce qui permet de s'y donner
     rendez-vous. */
  const k = r.rejoint(B, FICHE);
  eq(Math.round(k.x), Math.round(j.x), 'le deuxieme arrive au meme endroit');
}

// ================== 5. ON PEUT TOUJOURS SORTIR
{
  const r = donjon(13);
  eq(r.portails.length, 1, 'la porte du sas existe des le premier pas');
  const p = r.portails[0];
  eq(p.retour, true, 'et c\'est une porte de retour');
  eq(p.reste, Infinity, 'qui ne se referme jamais');

  /* ELLE SURVIT AU TEMPS. Un `reste` decompte finirait par tomber a zero et
     enfermerait celui qui prend son temps. */
  for (let i = 0; i < 400; i++) r.pas(0.5);
  eq(r.portails.filter((q) => q.retour && !Number.isFinite(q.reste)).length, 1,
     'trois minutes plus tard, elle est toujours la');

  /* ET ELLE SE VOIT. Un `Infinity` traverse JSON en `null` — on le dit expres,
     plutot que de le laisser arriver. */
  const j = r.rejoint(A, FICHE);
  j.x = p.x; j.y = p.y;
  const e = r.etatPour(A, 1400).portails.find((q) => q.i === p.id);
  ok(e, 'la porte du sas part avec l\'etat');
  eq(e.r, null, 'sans compte a rebours');
  eq(e.rt, 1, 'et marquee comme un retour');
  ok(!!r.portailSousLesPieds(A), 'et on se tient dessus');

  /* ON N'ARRIVE PAS DESSUS. Le panneau proposerait de repartir a la seconde ou
     l'on arrive. */
  const r2 = donjon(14);
  r2.rejoint(B, FICHE);
  eq(r2.portailSousLesPieds(B), null, 'mais on n\'y arrive pas pose dessus');
}

// ================== 6. LE DONJON SE VIDE
{
  const r = donjon(17);
  r.rejoint(A, FICHE);
  const avant = r.monstres.length;
  eq(r.repeuple(900), 0, 'un donjon ne se repeuple pas');
  for (let i = 0; i < 50; i++) r.pas(0.1);
  eq(r.repeuple(0), 0, 'meme en insistant');
  eq(r.monstres.length, avant, 'la population n\'a pas bouge');

  /* ET LE MONDE OUVERT, LUI, SE REPEUPLE TOUJOURS. Sans cette moitie-la, le
     refus ci-dessus pourrait venir d'un `repeuple` casse pour tout le monde. */
  const monde0 = new Realm({ alea: alea(17) });
  monde0.rejoint(A, FICHE);
  monde0.monstres.splice(0, 20);
  ok(monde0.repeuple(0) > 0, 'le monde ouvert, lui, se referme');
}

// ================== 7. LES DEUX MONDES NE SE VOIENT PAS
{
  /* Le point entier de la deuxieme simulation. Deux donjons vivent aux memes
     coordonnees : si l'isolation etait une verification plutot qu'une
     structure, une fleche tiree dans l'un toucherait une creature de l'autre,
     et personne ne saurait pourquoi il perd de la vie sans etre touche. */
  const a = donjon(21);
  const b = donjon(21);
  a.rejoint(A, FICHE);
  b.rejoint(B, FICHE);

  eq(a.joueurs.has(B), false, 'le joueur de l\'un n\'est pas dans l\'autre');
  eq(b.joueurs.has(A), false, 'et reciproquement');
  eq(a.etatPour(B, 9999), null, 'l\'un ne peut pas demander l\'etat de l\'autre');

  /* MEMES COORDONNEES, ET POURTANT INVISIBLES. */
  const ja = a.joueurs.get(A), jb = b.joueurs.get(B);
  eq(Math.round(ja.x), Math.round(jb.x), 'ils sont a la meme place');
  eq(a.etatPour(A, 9999).joueurs.length, 0, 'et ne se voient pas');

  /* TIRER DANS L'UN NE TOUCHE RIEN DANS L'AUTRE. */
  const cible = b.monstres[0];
  const pvAvant = cible.pv;
  ja.x = cible.x - 200; ja.y = cible.y;
  for (let i = 0; i < 30; i++) { a.tire(A, 0); a.pas(0.1); }
  eq(b.monstres[0].pv, pvAvant, 'la creature de l\'autre donjon n\'a rien perdu');

  /* ET LE MONDE OUVERT NON PLUS. */
  const m0 = new Realm({ alea: alea(21) });
  m0.rejoint(A, FICHE);
  eq(m0.joueurs.get(A) === ja, false, 'le joueur du donjon n\'est pas celui du monde');
}

// ================== 8. LA VIE TRAVERSE LA PORTE
{
  /* Sans ca, franchir une porte soigne : entrer a dix points de vie et
     ressortir plein aurait fait du donjon le plus dur du jeu un bouton de soin,
     et le meilleur usage aurait ete de ne jamais le faire. */
  const monde0 = new Realm({ alea: alea(31) });
  const j = monde0.rejoint(A, FICHE);
  j.pv = 42; j.mp = 7;
  const r = donjon(31);
  const k = r.rejoint(A, FICHE, { pv: j.pv, mp: j.mp });
  eq(k.pv, 42, 'la vie traverse');
  eq(k.mp, 7, 'et le mana aussi');

  /* JAMAIS AU-DESSUS DU MAXIMUM. Une fiche qui a change entre les deux mondes ne
     doit pas laisser un joueur a onze cents points sur une reserve de neuf
     cents — la barre deborderait, et le chiffre mentirait. */
  const l = r.rejoint(B, FICHE, { pv: 99999, mp: 99999 });
  eq(l.pv, l.pvMax, 'la vie est bornee au maximum');
  eq(l.mp, l.mpMax, 'le mana aussi');

  /* ET JAMAIS A ZERO : on n'entre pas mort. */
  const m = r.rejoint('0x' + 'c3'.repeat(20), FICHE, { pv: 0, mp: 0 });
  ok(m.pv >= 1, 'on n\'arrive pas mort de l\'autre cote');

  /* SANS ETAT, C'EST UNE ENTREE EN JEU : la vie est pleine. */
  const q = r.rejoint('0x' + 'd4'.repeat(20), FICHE);
  eq(q.pv, q.pvMax, 'entrer en jeu remplit la barre');

  /* ---- ET LA POSITION AUSSI ----
   * Ressortir a l'autre bout du monde aurait fait du donjon un aller simple. */
  const retour = monde0.rejoint(B, FICHE, { x: 3000, y: 4000 });
  eq(Math.round(retour.x), 3000, 'on ressort la ou la porte s\'est ouverte');
  eq(Math.round(retour.y), 4000, 'exactement');

  /* LES ETATS, EUX, NE TRAVERSENT PAS. Ils sont poses par une creature restee
     de l'autre cote ; les faire passer demanderait de les recopier un a un,
     donc d'en oublier un le jour ou un quatrieme s'ajoute. */
  eq(k.brulure, 0, 'on n\'arrive pas en train de bruler');
  eq(k.paralyse, 0, 'ni paralyse');
  eq(k.ralenti, 0, 'ni ralenti');
}

// ================== 9. ON Y MEURT COMME AILLEURS
{
  /* Pas une ligne du code de mort ne change : c'est le dividende de la deuxieme
     simulation. Un donjon plus doux serait le seul endroit du jeu ou porter du
     mythique ne coute rien. */
  const r = donjon(37);
  const j = r.rejoint(A, FICHE);
  j.pv = 1;
  /* On le colle au boss : le contact suffit. */
  const boss = r.monstres.find((m) => m.espece === M.DONJON.boss);
  j.x = boss.x; j.y = boss.y + 40;
  let mort = null;
  for (let i = 0; i < 200 && !mort; i++) {
    const ev = r.pas(0.1);
    if (ev.morts.length) mort = ev.morts[0];
  }
  ok(mort, 'on meurt dans un donjon');
  eq(mort.addr, A, 'et c\'est bien nous');
  /* La simulation ne retire PAS le mort : elle l'ANNONCE, et c'est server.js qui
     detruit l'equipement puis le sort du monde. C'est la meme separation que
     partout ailleurs — realm.js ne touche a rien qui compte — et c'est ce qui
     fait qu'une mort en donjon coute exactement ce qu'elle coute dehors, sans
     une ligne de code de plus. */
  eq(r.joueurs.get(A).pv <= 0, true, 'il est a terre');
  ok(r.tombes.length >= 1, 'et laisse sa pierre');
  eq(r.tombes[r.tombes.length - 1].nom, FICHE.nom, 'avec son nom dessus');
  /* ET LA PIERRE EST DANS LE DONJON, pas dans le monde ouvert : elle previent
     ceux qui y sont, et eux seuls. */
  const m0 = new Realm({ alea: alea(37) });
  eq(m0.tombes.length, 0, 'le monde ouvert n\'en sait rien');
  eq(r.quitte(A), true, 'le serveur le sort');
  eq(r.joueurs.has(A), false, 'et il n\'y est plus');
}

// ================== 10. LE BUTIN DU DONJON
{
  /* Les creatures ordinaires rendent du mythique, comme la lave : le donjon est
     derriere elle, pas au-dessus. Ce qui fait la difference est au fond, et
     c'est BUTIN_GARANTI qui le dit. */
  eq(M.RARETE_ANNEAU.donjon, 'mythique', 'les machines rendent du mythique');

  /* ---- ET LE TIRAGE DU DONJON EST UN AUTRE TIRAGE ----
   * C'est la simulation qui a ete CONSTRUITE avec, pas un drapeau qu'on
   * promene : on le verifie en regardant quelle rarete elle demande. */
  const vus = [];
  const r = new Realm({ alea: alea(41), plan: M.planDeDonjon('forge', alea(41)),
                        tireObjet: (rar) => { vus.push(rar); return PIECE(rar); } });
  const j = r.rejoint(A, FICHE);
  const boss = r.monstres.find((m) => m.espece === M.DONJON.boss);
  const ev = { kills: [], butins: [], portails: [] };
  r._abat(boss, j, ev);
  eq(vus.length, 1, 'une seule piece tiree pour le boss');
  eq(vus[0], 'relique', 'et c\'est une relique qu\'on lui a demandee');
  eq(r.sacs.length, 1, 'le sac est tombe');
  /* SUR LUI, pas ailleurs : c'est sa depouille. */
  eq(Math.round(r.sacs[0].x), Math.round(boss.x), 'sur sa depouille');

  /* ET LA PORTE DE RETOUR EST DERRIERE, PLUS LOIN QUE LE SAC. On ne doit pas
     entrer dedans en ramassant. */
  const porte = r.portails.find((p) => p.espece === M.DONJON.boss);
  ok(porte, 'la porte de retour s\'est ouverte');
  const d = Math.hypot(porte.x - r.sacs[0].x, porte.y - r.sacs[0].y);
  ok(d > M.SAC.rayon, `et elle est hors du sac (${d.toFixed(0)} u)`);
  /* MAIS DANS LE DONJON : une porte de retour posee dans un mur ne se
     franchirait pas, et l'on serait revenu a pied pour rien. */
  eq(!!M.bloque(r.obstacles, porte.x, porte.y, M.PORTAIL.rayon * 0.5), false,
     'et pas dans la pierre');
}

// ================== 11. LES HUIT PIECES NE TOMBENT QUE LA
{
  const boutique = require('./boutique');
  const { Game } = require('./game');
  const g = new Game({});
  const dj = boutique.ITEMS_DROP.filter((o) => o.donjon);
  eq(dj.length, 8, 'huit pieces de donjon au catalogue');
  for (const o of dj) {
    ok(boutique.item(o.id), `« ${o.nom} » se retrouve par son identifiant`);
    ok(/^dj_/.test(o.cle), `et sa cle nomme son dessin (${o.cle})`);
    ok(boutique.famille(o.famille), `et sa famille existe (${o.famille})`);
    eq(o.rarete, 'relique', 'et c\'est une relique');
    eq(o.drop, true, 'elle ne s\'achete pas');
  }
  /* DES NOMS UNIQUES, ET DES IDENTIFIANTS UNIQUES. Deux pieces du meme nom se
     lisent comme un doublon d'affichage ; deux du meme identifiant se
     remplacent silencieusement dans `PAR_ID`. */
  eq(new Set(dj.map((o) => o.id)).size, 8, 'huit identifiants distincts');
  eq(new Set(dj.map((o) => o.nom)).size, 8, 'huit noms distincts');
  eq(new Set(dj.map((o) => o.cle)).size, 8, 'huit dessins distincts');

  /* LE MONDE OUVERT NE PEUT PAS LES RENDRE. Si c'etait le cas, on aurait ces
     reliques en abattant des limes et franchir le portail n'aurait servi a
     rien. Sur toutes les raretes, et sur assez de tirages pour que ca compte. */
  let fuites = 0, sorties = 0;
  for (const rar of ['commun', 'rare', 'epique', 'legendaire', 'mythique', 'relique']) {
    for (let i = 0; i < 500; i++) {
      g.boutiqueEmis = {};
      const o = g.tireButin(rar, Math.random);
      if (!o) continue;
      sorties++;
      if (/^dj_/.test(String(o.cle))) fuites++;
    }
  }
  eq(fuites, 0, `sur ${sorties} tirages du monde ouvert, aucune piece de donjon`);

  /* NI LE BUTIN GARANTI DES SALLES GARDEES : il descend les rangs en appelant
     `tireButin`, donc il herite de l'exclusion — mais on le verifie, parce
     qu'« il herite » est exactement le genre de phrase qui cesse d'etre vraie
     sans prevenir. */
  let f2 = 0;
  for (let i = 0; i < 800; i++) {
    g.boutiqueEmis = {};
    const o = g.tireButinGaranti('relique', Math.random);
    if (o && /^dj_/.test(String(o.cle))) f2++;
  }
  eq(f2, 0, 'ni le coffre d\'une salle gardee');

  /* ET LE DONJON NE REND QUE LES SIENNES. */
  let etrangeres = 0, prises = 0;
  for (let i = 0; i < 800; i++) {
    g.boutiqueEmis = {};
    const o = g.tireButinDonjon('relique', Math.random);
    if (!o) continue;
    prises++;
    if (!/^dj_/.test(String(o.cle))) etrangeres++;
  }
  eq(etrangeres, 0, `sur ${prises} tirages du donjon, que des pieces de donjon`);

  /* LE PLAFOND TIENT, ET C'EST LE MEME REGISTRE. Un donjon qui compterait ses
     exemplaires a part aurait sa propre facon de le rater. */
  g.boutiqueEmis = {};
  const plafond = boutique.rarete('relique').plafond;
  let sorti = 0;
  for (let i = 0; i < dj.length * plafond + 20; i++) {
    if (g.tireButinDonjon('relique', Math.random)) sorti++;
  }
  eq(sorti, dj.length * plafond,
     `${dj.length} pieces x ${plafond} exemplaires, et pas une de plus`);
  eq(g.tireButinDonjon('relique', Math.random), null, 'la suivante ne tombe pas');
  /* ET LE MONDE OUVERT N'EST PAS ASSECHE POUR AUTANT : les deux lots ont leurs
     propres exemplaires, meme registre mais pas memes lignes. */
  ok(g.tireButin('relique', Math.random), 'le coeur du monde en a toujours');
}

// ================== 12. LE PLAN NE MENT PAS
{
  const p = M.planDeDonjon('forge', alea(5));
  eq(p.nom, 'forge', 'le plan porte le nom du donjon');
  ok(p.entree && Number.isFinite(p.entree.x), 'il a une entree');
  ok(p.sortie && Number.isFinite(p.sortie.x), 'et une sortie');
  ok(p.obstacles.length > 0, 'des murs');
  ok(p.peuplement.length > 0, 'des creatures');
  ok(p.tuiles.length > 0, 'et un sol, tuile par tuile');
  eq(p.salles.length, 0, 'pas de salles gardees');

  /* UN SEUL ANNEAU, QUI COUVRE TOUT. C'est ce qui evite d'apprendre au client un
     deuxieme mode de dessin : `biomeEn` rend 'donjon' partout, sans une ligne de
     plus nulle part. */
  eq(p.anneaux.length, 1, 'un seul anneau');
  eq(p.anneaux[0].biome, 'donjon', 'et c\'est le donjon');
  eq(p.anneaux[0].jusqua, Infinity, 'jusqu\'au bout');

  /* L'ENTREE ET LA SORTIE SONT DANS LE SAS, ET PAS AU MEME ENDROIT. */
  const d = Math.hypot(p.entree.x - p.sortie.x, p.entree.y - p.sortie.y);
  ok(d > M.PORTAIL.rayon, `on n'arrive pas sur la porte (${d.toFixed(0)} u)`);

  /* CHAQUE TUILE EST UN COUPLE D'ENTIERS. Une seule tuile mal formee et la page
     dessinerait un carre de sol a NaN, NaN — c'est-a-dire nulle part, en
     silence. */
  for (const t of p.tuiles) {
    if (!Array.isArray(t) || t.length !== 2 ||
        !Number.isInteger(t[0]) || !Number.isInteger(t[1])) {
      ok(false, 'une tuile mal formee : ' + JSON.stringify(t));
    }
  }
  ok(true, `${p.tuiles.length} tuiles, toutes bien formees`);

  /* LE MEME HASARD DONNE LE MEME DONJON. Deux joueurs qui franchissent la meme
     porte doivent trouver la meme chose derriere — mais surtout, un essai qui
     n'est pas reproductible ne prouve rien. */
  eq(JSON.stringify(M.planDeDonjon('forge', alea(9)).peuplement),
     JSON.stringify(M.planDeDonjon('forge', alea(9)).peuplement),
     'deux fois le meme tirage, deux fois le meme donjon');
}

console.log(`donjon.test.js — ${n} verifications, 0 echec`);
