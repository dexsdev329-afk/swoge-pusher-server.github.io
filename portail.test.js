'use strict';
/*
 * LE PORTAIL — ce qu'Optimus laisse en tombant.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LA PORTE NE SE TIRE PAS AU SORT. Le sac d'Optimus peut sortir vide d'un
 *    tirage malheureux ; le donjon, jamais. Un donjon qui s'ouvrirait neuf
 *    fois sur dix serait une promesse a moitie tenue, et la dixieme fois le
 *    joueur croirait avoir mal joue.
 * 2. ELLE TOMBE DERRIERE ELLE, PAS DESSOUS. C'est ce qui laisse le CHOIX : on
 *    ramasse d'abord, on entre ensuite — ou pas. Posee sur le sac, les deux
 *    gestes n'en feraient qu'un.
 * 3. UNE PORTE N'EST PAS UN SAC. Elle ne se ramasse pas, ni a la main ni
 *    automatiquement, et elle ne prend pas de place dans un inventaire.
 * 4. ELLE SE REFERME. Une porte eternelle ferait du donjon un lieu ou l'on va
 *    attendre, au lieu d'un evenement qu'on provoque.
 * 5. VINGT ET UNE CREATURES SUR VINGT-DEUX N'OUVRENT RIEN.
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
                stats: { hp: 6000, mp: 300, att: 40, def: 20 } };

/* Un endroit degage : de la place autour, dans les quatre sens, pour poser le
   joueur, la creature a quatre cents unites et la porte encore plus loin. On le
   CHERCHE plutot que de l'ecrire en dur — les rochers sont tires au sort, et
   une coordonnee choisie a la main se retrouverait un jour dans la pierre sans
   que personne ne comprenne pourquoi l'essai s'est mis a mentir. */
function degage(r, portee) {
  const d = portee || 700;
  for (let x = 1200; x < M.MONDE.w - 1200; x += 137) {
    for (let y = 1200; y < M.MONDE.h - 1200; y += 137) {
      let bon = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let t = 0; t <= d && bon; t += 60) {
          if (M.bloque(r.obstacles, x + dx * t, y + dy * t, 80)) bon = false;
        }
      }
      if (bon) return { x, y };
    }
  }
  throw new Error('aucun endroit degage sur la carte');
}

/* Poser une creature a portee du joueur et l'achever. On rend l'evenement du
   pas ou elle meurt — c'est la que la porte s'ouvre. */
function abat(r, espece, addr, dx, dy) {
  const j = r.joueurs.get(addr);
  const t = M.MONSTRES[espece];
  const m = { id: r._nouvelId(), espece, biome: 'lave',
              x: j.x + dx, y: j.y + dy, ancreX: j.x + dx, ancreY: j.y + dy,
              pv: 1, pvMax: t.pv, dir: 'down', cible: null,
              recharge: 0, rechargeT: 0, stase: 0,
              errX: 0, errY: 0, errChrono: 0 };
  r.monstres.push(m);
  const ev = { degats: [], morts: [], kills: [], touches: [], regen: [],
               butins: [], ramasses: [], expires: [], marques: [], zones: [],
               portails: [] };
  r._abat(m, j, ev);
  const i = r.monstres.indexOf(m);
  if (i >= 0) r.monstres.splice(i, 1);
  return ev;
}

// ================== 1. LE MONDE DIT QUI OUVRE QUOI
{
  ok(M.PORTAIL && M.PORTAIL_DE, 'monde.js porte la regle du portail');
  eq(M.PORTAIL_DE.optimus, 'forge', 'Optimus ouvre la forge');

  /* UNE TABLE, PAS UN DRAPEAU. La valeur nomme le donjon : c'est ce qui
     permettra a une deuxieme creature d'en ouvrir un AUTRE sans qu'un seul
     `if` ait a changer. */
  for (const k of Object.keys(M.PORTAIL_DE)) {
    ok(M.MONSTRES[k], `« ${k} » qui ouvre une porte est une vraie creature`);
    ok(typeof M.PORTAIL_DE[k] === 'string' && M.PORTAIL_DE[k],
       `et ce qu'elle ouvre porte un nom (${M.PORTAIL_DE[k]})`);
  }

  /* CELLE QUI OUVRE EST UN BOSS. Une creature commune qui laisserait une porte
     en remplirait la carte, et entrer ne voudrait plus rien dire. */
  for (const k of Object.keys(M.PORTAIL_DE)) {
    ok(M.BOSS[k], `« ${M.MONSTRES[k].nom} » est un boss`);
  }

  /* ET PRESQUE PERSONNE N'OUVRE. */
  const total = Object.keys(M.MONSTRES).length;
  const ouvreurs = Object.keys(M.PORTAIL_DE).length;
  ok(ouvreurs < total / 5, `${ouvreurs} creature sur ${total} ouvre une porte`);

  /* CE QUE DONJON.ouvreur ANNONCE EST CE QUE LA TABLE FAIT. Deux endroits qui
     disent la meme chose finissent par ne plus la dire pareil ; si un jour
     l'un des deux change, cet essai le voit. */
  ok(M.PORTAIL_DE[M.DONJON.ouvreur],
     `DONJON.ouvreur (${M.DONJON.ouvreur}) est bien dans la table des portails`);

  /* ---- LA PORTE D'ENTREE EST COURTE, ET C'EST VOULU ----
   *
   * Elle a tenu trois minutes, plus longtemps qu'un sac : entrer se decide,
   * ramasser non. Elle tient maintenant quarante secondes — assez pour
   * traverser, pas pour finir sa fouille et revenir au calme. La porte fait
   * partie de la recompense ; ce n'est pas un rendez-vous qu'on prend pour
   * plus tard.
   *
   * CONSEQUENCE ASSUMEE : elle se ferme AVANT le sac qu'Optimus laisse en
   * tombant. On choisit donc entre son butin et le donjon, au lieu de prendre
   * les deux. L'essai l'ecrit noir sur blanc pour que ce soit une decision et
   * non une derive — le jour ou l'un des deux chiffres bouge sans l'autre, il
   * le dira. */
  ok(M.PORTAIL.duree === 40, `la porte d'entree tient ${M.PORTAIL.duree} s`);
  ok(M.PORTAIL.duree < M.SAC.duree,
     `soit MOINS que le sac qu'elle accompagne (${M.PORTAIL.duree} s contre ${M.SAC.duree} s) ` +
     `— il faut choisir entre fouiller et entrer`);
  /* ---- LA PORTE DE SORTIE, ELLE, NE SE FERME JAMAIS ----
   * Un donjon dont la sortie s'evapore pendant qu'on fouille le fond
   * enfermerait un joueur qui a mal juge sa vie, et sa mort lui couterait un
   * equipement paye en argent reel. */
  ok(!Number.isFinite(M.PORTAIL.dureeRetour),
     `la porte de sortie, elle, n'a pas de fin (${M.PORTAIL.dureeRetour})`);
  /* ET ELLE EST PLUS LARGE QU'UN SAC A RAMASSER : on marche DEDANS, on ne se
     penche pas dessus. */
  ok(M.PORTAIL.rayon >= M.SAC.rayon,
     `on la franchit a ${M.PORTAIL.rayon} u (un sac se ramasse a ${M.SAC.rayon})`);
  /* LE RECUL EST PLUS GRAND QUE LE RAYON DU SAC : sinon la porte serait DANS le
     sac, et les deux gestes se confondraient. C'est le point 2. */
  ok(M.PORTAIL.recul > M.SAC.rayon,
     `elle tombe ${M.PORTAIL.recul} u plus loin, hors du sac (${M.SAC.rayon} u)`);
}

// ================== 2. OPTIMUS MEURT : UN SAC, PUIS UNE PORTE
{
  const r = new Realm({ alea: alea(7),
    tireObjet: () => ({ item: 1, cle: 'x', nom: 'Test', rarete: 'commun' }) });
  r.rejoint(A, FICHE);
  const avant = r.sacs.length;
  const ev = abat(r, 'optimus', A, 300, 0);

  eq(r.portails.length, 1, 'une porte s\'est ouverte');
  ok(r.sacs.length > avant, 'et un sac est tombe');
  ok(ev.portails && ev.portails.length === 1, 'l\'evenement l\'annonce');
  eq(ev.portails[0].donjon, 'forge', 'et il nomme le donjon');
  eq(ev.portails[0].addr, A, 'et celui qui l\'a ouverte');
  eq(ev.portails[0].espece, 'optimus', 'et ce qui l\'a laissee');

  const p = r.portails[0];
  ok(p.id > 0, 'la porte a un identifiant');
  eq(p.reste, M.PORTAIL.duree, 'et sa duree entiere');
  eq(p.donjon, 'forge', 'et le donjon qu\'elle ouvre');
  eq(p.retour, false, 'ce n\'est pas une porte de retour');
}

// ================== 3. DERRIERE ELLE, DANS LE SENS DE SA CHUTE
{
  /* Le joueur a l'ouest, la creature a l'est : la porte doit tomber PLUS A
     L'EST encore. C'est le seul « derriere » qui se lise a l'ecran. */
  const r = new Realm({ alea: alea(21) });
  const j = r.rejoint(A, FICHE);
  const c = degage(r);
  j.x = c.x; j.y = c.y;
  abat(r, 'optimus', A, 400, 0);
  const p = r.portails[0];
  const sac = r.sacs[r.sacs.length - 1];

  ok(p.x > j.x + 400,
     `la porte est au-dela de la creature (${Math.round(p.x)} > ${Math.round(j.x + 400)})`);
  if (sac) {
    const d = Math.hypot(p.x - sac.x, p.y - sac.y);
    ok(d > M.SAC.rayon, `et hors du sac : ${d.toFixed(0)} u de lui, il fait ${M.SAC.rayon}`);
    /* MAIS PAS SI LOIN QU'ON LA PERDE. Une porte hors de l'ecran serait une
       porte qu'on ne saurait pas avoir ouverte. */
    ok(d < 400, `et assez pres pour la voir : ${d.toFixed(0)} u`);
  }

  /* DEPUIS L'AUTRE COTE, ELLE TOMBE DE L'AUTRE COTE. Le decalage suit le tueur,
     ce n'est pas un decalage fixe vers l'est. */
  const r2 = new Realm({ alea: alea(21) });
  const j2 = r2.rejoint(A, FICHE);
  const c2 = degage(r2);
  j2.x = c2.x; j2.y = c2.y;
  abat(r2, 'optimus', A, -400, 0);
  ok(r2.portails[0].x < j2.x - 400, 'depuis l\'est, elle tombe a l\'ouest');

  /* ET EN DIAGONALE AUSSI : le sens est un vecteur, pas quatre cas. */
  const r3 = new Realm({ alea: alea(31) });
  const j3 = r3.rejoint(A, FICHE);
  const c3 = degage(r3);
  j3.x = c3.x; j3.y = c3.y;
  abat(r3, 'optimus', A, 0, -400);
  ok(r3.portails[0].y < j3.y - 400, 'vers le nord, elle tombe au nord');
}

// ================== 4. SANS TUEUR, ELLE S'OUVRE QUAND MEME
{
  /* Une brulure qui acheve la creature, ou un joueur parti entre le coup et la
     mort. Le donjon appartient au sol, comme le butin. */
  const r = new Realm({ alea: alea(9) });
  const j = r.rejoint(A, FICHE);
  const c = degage(r);
  j.x = c.x; j.y = c.y;
  const t = M.MONSTRES.optimus;
  const m = { id: 99, espece: 'optimus', biome: 'lave', x: j.x + 500, y: j.y,
              ancreX: j.x + 500, ancreY: j.y, pv: 0, pvMax: t.pv, dir: 'left',
              cible: null, recharge: 0, rechargeT: 0, stase: 0,
              errX: 0, errY: 0, errChrono: 0 };
  const ev = { kills: [], butins: [], portails: [] };
  r._abat(m, null, ev);
  eq(r.portails.length, 1, 'la porte s\'ouvre sans tueur');
  eq(ev.portails[0].addr, null, 'et l\'evenement ne ment pas sur qui l\'a ouverte');
  /* Elle regardait a l'ouest : la porte est a l'ouest. */
  ok(r.portails[0].x < m.x, 'elle tombe dans le sens ou la creature regardait');
}

// ================== 5. UN SAC VIDE N'EMPECHE PAS LA PORTE
{
  /* `tireObjet` qui rend null : aucune piece ne se materialise, le sac disparait
     avant d'exister. C'est exactement le cas ou l'ancien code serait sorti de
     `_abat` par son `return` — et le donjon d'Optimus se serait referme sur un
     coup de des. */
  const r = new Realm({ alea: alea(5), tireObjet: () => null });
  r.rejoint(A, FICHE);
  abat(r, 'optimus', A, 250, 0);
  eq(r.portails.length, 1, 'la porte s\'ouvre meme si rien ne se materialise');
}

// ================== 6. LES AUTRES N'OUVRENT RIEN
{
  const r = new Realm({ alea: alea(13) });
  r.rejoint(A, FICHE);
  let ouvertes = 0;
  for (const k of Object.keys(M.MONSTRES)) {
    if (M.PORTAIL_DE[k] || M.RETOUR_DE[k]) continue;
    const avant = r.portails.length;
    abat(r, k, A, 300, 0);
    if (r.portails.length > avant) ouvertes++;
  }
  eq(ouvertes, 0, 'aucune des autres creatures n\'ouvre de porte');
  eq(r.portails.length, 0, 'et la liste est restee vide');

  /* Y COMPRIS LES AUTRES BOSS. Le gardien, le brasier, la machine et la
     carapace tombent depuis des mois sans rien ouvrir ; ce n'est pas parce
     qu'ils sont durs qu'ils ouvrent un donjon. */
  for (const k of Object.keys(M.BOSS)) {
    if (M.PORTAIL_DE[k] || M.RETOUR_DE[k]) continue;
    const avant = r.portails.length;
    abat(r, k, A, 300, 0);
    eq(r.portails.length, avant, `« ${M.MONSTRES[k].nom} » n'ouvre rien`);
  }

  /* ---- ET LES DEUX TABLES NE SE RECOUVRENT PAS ----
   * Une creature qui serait dans les deux ouvrirait une porte dont le sens
   * dependrait de l'ordre des `if` — donc du hasard de la relecture. */
  for (const k of Object.keys(M.PORTAIL_DE)) {
    eq(!!M.RETOUR_DE[k], false, `« ${k} » ouvre un donjon, donc pas une porte de retour`);
  }
}

// ================== 7. LA PORTE DE RETOUR N'EST PAS UNE PORTE DE DONJON
{
  /* Le boss du fond en laisse une, et elle ne mene NULLE PART : elle ramene.
     Confondre les deux ferait entrer dans un donjon en voulant en sortir. */
  const r = new Realm({ alea: alea(53) });
  const j = r.rejoint(A, FICHE);
  const c = degage(r);
  j.x = c.x; j.y = c.y;
  for (const k of Object.keys(M.RETOUR_DE)) {
    r.portails = [];
    const ev = abat(r, k, A, 300, 0);
    eq(r.portails.length, 1, `« ${M.MONSTRES[k].nom} » laisse une porte`);
    const p = r.portails[0];
    eq(p.retour, true, 'et c\'est une porte de retour');
    eq(p.donjon, null, 'qui n\'ouvre aucun donjon');
    eq(ev.portails[0].retour, true, 'l\'evenement le dit aussi');
    /* MEME PLACE QUE L'AUTRE : derriere la creature, au-dela de son sac. Un
       joueur qui vient d'abattre le fond du donjon ne doit pas avoir a chercher
       par ou repartir. */
    ok(p.x > j.x + 300, 'et elle tombe derriere lui, comme l\'autre');
    /* ---- ELLE, ELLE NE SE REFERME PAS ----
     *
     * Elle a eu la meme duree que l'autre, au nom d'un raccourci permanent
     * vers la salle du boss. L'argument ne tenait pas : cette porte-la va
     * DEHORS. On ne revient pas par elle, on s'en va. Ce qu'elle produisait,
     * en revanche, etait bien reel — on sortait de la salle du fond, on
     * fouillait son butin, la porte disparaissait, et le seul chemin restant
     * etait de retraverser trois salles jusqu'a l'entree. C'est le defaut qui
     * a ete signale.
     *
     * Un donjon dont la sortie s'evapore enferme un joueur qui a mal juge sa
     * vie, et sa mort lui coute un equipement paye en argent reel. La
     * difficulte d'un donjon est ce qu'on y rencontre ; jamais le fait d'en
     * repartir. */
    ok(!Number.isFinite(p.reste), `et elle ne se referme jamais (${p.reste})`);
    /* ET L'ETAT LA DISTINGUE. Sans ce bit, la page ecrirait « ENTER » sur la
       porte de sortie — le seul bouton du donjon qui compte. */
    const e = r.etatPour(A, 1400).portails.find((q) => q.i === p.id);
    eq(e.rt, 1, 'l\'etat marque la porte de retour');
    eq(e.dj, null, 'et ne lui donne aucun donjon');
  }
}

// ================== 8. ON SE TIENT DESSUS, OU PAS
{
  const r = new Realm({ alea: alea(3) });
  const j = r.rejoint(A, FICHE);
  r.portails.push({ id: 1, x: j.x + 30, y: j.y, donjon: 'forge',
                    retour: false, espece: 'optimus', reste: 120 });
  const p = r.portailSousLesPieds(A);
  ok(p && p.id === 1, 'a trente unites, on est dessus');

  r.portails[0].x = j.x + M.PORTAIL.rayon + 40;
  eq(r.portailSousLesPieds(A), null, 'a cent unites, on n\'y est plus');

  /* UN INCONNU N'EST NULLE PART. */
  eq(r.portailSousLesPieds(B), null, 'et qui n\'est pas dans le monde non plus');

  /* LA PLUS PROCHE, S'IL Y EN A DEUX. Deux portes cote a cote et c'est celle de
     derriere qu'on franchirait. */
  r.portails = [
    { id: 1, x: j.x + 60, y: j.y, donjon: 'forge', retour: false, espece: 'optimus', reste: 120 },
    { id: 2, x: j.x + 10, y: j.y, donjon: 'forge', retour: false, espece: 'optimus', reste: 120 },
  ];
  eq(r.portailSousLesPieds(A).id, 2, 'c\'est la plus proche qu\'on prend');
}

// ================== 9. UNE PORTE N'EST PAS UN SAC
{
  const r = new Realm({ alea: alea(17),
    tireObjet: () => ({ item: 1, cle: 'x', nom: 'Test', rarete: 'commun' }) });
  r.rejoint(A, FICHE);
  abat(r, 'optimus', A, 200, 0);
  const p = r.portails[0];

  /* On se met DESSUS et on demande un sac : il ne doit pas y en avoir un a cet
     endroit-la. Sinon marcher vers la porte ramasserait la porte. */
  r.bouge(A, p.x, p.y, 'right', 'walk', 0.1);
  const dessus = r.sacSousLesPieds(A);
  if (dessus) {
    ok(dessus.x !== p.x || dessus.y !== p.y, 'le sac sous les pieds n\'est pas la porte');
  }
  /* Et la porte n'a jamais rejoint la liste des sacs. */
  eq(r.sacs.some((s) => s.id === p.id), false, 'la porte n\'est pas dans les sacs');
  /* Elle n'a pas de contenu : rien a en sortir, donc rien a ramasser. */
  eq(p.contenu, undefined, 'et elle ne contient rien');
}

// ================== 10. ELLE SE REFERME
{
  const r = new Realm({ alea: alea(23) });
  r.rejoint(A, FICHE);
  abat(r, 'optimus', A, 300, 0);
  const p = r.portails[0];

  /* ELLE PART AVEC SA DUREE ENTIERE. Comme les tombes et les sacs : le pas ou
     elle nait ne doit pas lui en retirer. */
  eq(p.reste, M.PORTAIL.duree, 'elle part avec sa duree entiere');
  /* Un demi-pas, parce que `pas` borne dt a 0.5 : un pas d'une seconde entiere
     n'existe pas dans cette simulation. */
  r.pas(0.5);
  ok(Math.abs(p.reste - (M.PORTAIL.duree - 0.5)) < 1e-9,
     'un demi-pas plus tard, il lui en reste un demi de moins');

  /* AU BOUT, ELLE DISPARAIT. */
  let t = 0.5;   // le demi-pas ci-dessus compte
  while (r.portails.length && t < M.PORTAIL.duree + 5) { r.pas(0.5); t += 0.5; }
  eq(r.portails.length, 0, 'elle s\'est refermee');
  ok(t >= M.PORTAIL.duree, `apres ${t} s, pas avant`);
}

// ================== 11. ELLE PART AVEC L'ETAT, ET SEULEMENT DE PRES
{
  const r = new Realm({ alea: alea(29) });
  const j = r.rejoint(A, FICHE);
  abat(r, 'optimus', A, 200, 0);

  const e = r.etatPour(A, 1400);
  ok(Array.isArray(e.portails), 'l\'etat porte les portes');
  eq(e.portails.length, 1, 'et celle-ci en fait partie');
  const q = e.portails[0];
  ok(Number.isInteger(q.x) && Number.isInteger(q.y), 'sa position est ronde');
  eq(q.dj, 'forge', 'le donjon part avec elle');
  eq(q.rt, 0, 'et ce n\'est pas une porte de retour');
  ok(q.r > 0, 'et le temps restant, pour dessiner la fermeture');

  /* PAS CELLES DE L'AUTRE BOUT DE LA CARTE. Une liste sans portee voyagerait en
     entier vers chaque client, dix fois par seconde. */
  r.portails.push({ id: 999, x: j.x + 4000, y: j.y, donjon: 'forge',
                    retour: false, espece: 'optimus', reste: 120 });
  eq(r.etatPour(A, 1400).portails.length, 1, 'celle de l\'autre bout ne voyage pas');

  /* UN INCONNU N'A PAS D'ETAT DU TOUT. */
  eq(r.etatPour(B, 1400), null, 'et qui n\'est pas dans le monde n\'a rien');
}

// ================== 12. LE PLAFOND TIENT
{
  const r = new Realm({ alea: alea(37) });
  r.rejoint(A, FICHE);
  for (let i = 0; i < M.PORTAIL.plafond + 12; i++) abat(r, 'optimus', A, 300, 0);
  ok(r.portails.length <= M.PORTAIL.plafond,
     `${r.portails.length} portes au plus, le plafond est ${M.PORTAIL.plafond}`);
  ok(r.portails.length > 0, 'et il en reste');
}

// ================== 13. ELLE NE TOMBE PAS DANS LA PIERRE
{
  /* On acheve la creature juste devant un rocher : le recul l'y enverrait. La
     porte doit se rapprocher plutot que de se poser dedans — une porte dans un
     rocher se verrait sans pouvoir se franchir. */
  const r = new Realm({ alea: alea(41) });
  const j = r.rejoint(A, FICHE);
  const roc = r.obstacles[0];
  const ang = 0.7;
  const mx = roc.x - Math.cos(ang) * (roc.r + 40);
  const my = roc.y - Math.sin(ang) * (roc.r + 40);
  j.x = mx - Math.cos(ang) * 300; j.y = my - Math.sin(ang) * 300;
  const t = M.MONSTRES.optimus;
  const m = { id: 77, espece: 'optimus', biome: 'lave', x: mx, y: my,
              ancreX: mx, ancreY: my, pv: 0, pvMax: t.pv, dir: 'down',
              cible: null, recharge: 0, rechargeT: 0, stase: 0,
              errX: 0, errY: 0, errChrono: 0 };
  r._abat(m, j, { kills: [], butins: [], portails: [] });
  const p = r.portails[0];
  ok(p, 'la porte s\'est ouverte quand meme');
  eq(!!M.bloque(r.obstacles, p.x, p.y, M.PORTAIL.rayon * 0.5), false,
     'et elle n\'est pas dans le rocher');
}

// ================== 14. ELLE RESTE DANS LA CARTE
{
  /* Une creature achevee contre le bord : le recul la mettrait hors du monde,
     ou personne ne peut aller. */
  const r = new Realm({ alea: alea(43) });
  const j = r.rejoint(A, FICHE);
  const t = M.MONSTRES.optimus;
  for (const coin of [[40, 40, 'right'], [M.MONDE.w - 40, M.MONDE.h - 40, 'down'],
                      [40, M.MONDE.h - 40, 'left'], [M.MONDE.w - 40, 40, 'up']]) {
    r.portails = [];
    j.x = coin[0] - 200; j.y = coin[1];
    const m = { id: 88, espece: 'optimus', biome: 'lave', x: coin[0], y: coin[1],
                ancreX: coin[0], ancreY: coin[1], pv: 0, pvMax: t.pv,
                dir: coin[2], cible: null, recharge: 0, rechargeT: 0, stase: 0,
                errX: 0, errY: 0, errChrono: 0 };
    r._abat(m, j, { kills: [], butins: [], portails: [] });
    const p = r.portails[0];
    ok(p.x >= 0 && p.x <= M.MONDE.w && p.y >= 0 && p.y <= M.MONDE.h,
       `au coin ${coin[0]},${coin[1]} : la porte est dans la carte (${Math.round(p.x)},${Math.round(p.y)})`);
  }
}

// ================== 15. DEUX MORTS, DEUX PORTES
{
  /* Chacun la sienne. Une porte qui se reutiliserait ferait du deuxieme Optimus
     une creature sans recompense. */
  const r = new Realm({ alea: alea(47) });
  r.rejoint(A, FICHE);
  abat(r, 'optimus', A, 300, 0);
  abat(r, 'optimus', A, -300, 0);
  eq(r.portails.length, 2, 'deux creatures, deux portes');
  ok(r.portails[0].id !== r.portails[1].id, 'et deux identifiants');
}

console.log(`portail.test.js — ${n} verifications, 0 echec`);
