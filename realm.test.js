'use strict';
/*
 * LE MONDE VIVANT — la simulation qui tourne sur le SERVEUR.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE CLIENT NE PEUT PAS TRICHER. Ni se teleporter, ni tirer plus vite que
 *    son arme, ni s'attribuer de l'XP. C'est la raison d'etre du fichier :
 *    des objets payes en vrai $SWOGE disparaissent a la mort.
 * 2. LES MONSTRES POURSUIVENT, PUIS S'ARRETENT AU CONTACT. Un monstre qui
 *    pousse le joueur devant lui transforme la poursuite en remorquage.
 * 3. ON BLESSE, ON MEURT, ON GAGNE DE L'XP — et chaque evenement est RENDU,
 *    jamais applique ici : les soldes appartiennent a game.js.
 * 4. ON ARRIVE PAR LE BORD, jamais au milieu de la lave.
 * 5. LA CARTE NE SE VIDE PAS, et rien ne nait dans le dos du joueur.
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
/* Un personnage de reference : niveau 1, arme commune. */
const FICHE = { skin: 'andy', nom: 'Dodexel', famille: 'lame',
                degats: P.DEGATS_ARME.commun,
                stats: { hp: 350, att: 28, def: 13 } };

// ================== 1. ON ARRIVE PAR LE BORD
{
  for (let g = 1; g <= 40; g++) {
    const r = new Realm({ alea: alea(g) });
    const j = r.rejoint(A, FICHE);
    eq(M.biomeEn(j.x, j.y), 'terre', 'on arrive toujours sur la terre, jamais dans la lave');
  }
}

// ================== 2. ON NE PEUT PAS SE TELEPORTER
{
  const r = new Realm({ alea: alea(5) });
  const j = r.rejoint(A, FICHE);
  const x0 = j.x, y0 = j.y;

  // un pas honnete passe tel quel
  ok(r.bouge(A, x0 + 20, y0, 'right', 'run', 0.15), 'un pas normal est accepte');
  eq(Math.round(j.x), Math.round(x0 + 20), 'et la position annoncee est prise telle quelle');

  // un bond a l'autre bout de la carte est RAMENE
  const avant = { x: j.x, y: j.y };
  ok(!r.bouge(A, j.x + 4000, j.y, 'right', 'run', 0.15), 'un bond de 4000 unites est refuse');
  const parcouru = Math.sqrt((j.x - avant.x) ** 2 + (j.y - avant.y) ** 2);
  ok(parcouru <= M.VITESSE_JOUEUR * 0.15 * 1.7,
    'on n avance que de ce que la vitesse permet (a ' + Math.round(parcouru) + ' unites)');
  ok(j.x < avant.x + 4000, 'on n est PAS arrive a la position demandee');

  // et jamais hors de la carte
  r.bouge(A, -9999, -9999, 'left', 'run', 99);
  ok(j.x >= 0 && j.y >= 0, 'on ne sort pas de la carte par la gauche');
  r.bouge(A, 1e9, 1e9, 'right', 'run', 99);
  ok(j.x <= M.MONDE.w && j.y <= M.MONDE.h, 'ni par la droite');
}

// ================== 2 bis. SE TAIRE N'ACHETE PAS DE DISTANCE
{
  /* ---- LE TROU QUE CET ESSAI FERME ----
   *
   * Le `dt` d'un mouvement est mesure par le SERVEUR comme le temps ecoule
   * depuis le dernier message de ce client. Il portait un plancher et aucun
   * plafond : le budget de deplacement s'accumulait donc pendant qu'on se
   * taisait, et un client trafique traversait la carte en une seule annonce.
   *
   * Les deux verifications d'au-dessus ne l'attrapaient pas : elles eprouvent
   * le bond a `dt` normal, et leurs deux appels a `dt: 99` ne regardent que
   * les bornes de la carte — ils EXECUTAIENT la teleportation et la
   * declaraient bonne.
   *
   * Le trajet n'est pas non plus verifie : `_glisse` ne teste que le point
   * d'arrivee, donc un bond assez long passe AU TRAVERS des rochers. Borner
   * le pas est ce qui rend la collision fiable, pas seulement la vitesse.
   */
  const r = new Realm({ alea: alea(5) });
  const j = r.rejoint(A, FICHE);

  /* La borne est DEMANDEE au moteur. L'ecrire ici en dur ferait passer
     l'essai le jour ou la constante change et ou la borne ne s'applique plus. */
  const R = require('./realm');
  const dep = (dt) => {
    j.x = 3000; j.y = 3000;
    const de = { x: j.x, y: j.y };
    /* On vise TRES loin sur un seul axe : la distance parcourue est alors
       exactement ce que la borne autorise, et rien d'autre ne la limite. */
    r.bouge(A, j.x + 100000, j.y, 'right', 'run', dt);
    return Math.sqrt((j.x - de.x) ** 2 + (j.y - de.y) ** 2);
  };

  const court = dep(R.PAS_MAX);
  const long = dep(R.PAS_MAX * 100);
  ok(court > 0, 'un pas plein avance (a ' + Math.round(court) + ' unites)');
  eq(Math.round(long), Math.round(court),
     'cent fois plus de silence n avance pas d un pouce de plus');

  /* Et la borne vaut bien celle du simulateur : un joueur ne peut pas
     reclamer plus de temps que le monde n'en rattrape en un tour. */
  const enorme = dep(3600);
  eq(Math.round(enorme), Math.round(court), 'une heure de silence non plus');

  /* Le plancher tient toujours : le corriger ne devait pas l'emporter. Un
     `dt` minuscule ne doit pas figer un joueur dont la page envoie vite. */
  const minuscule = dep(0.000001);
  ok(minuscule > 0, 'et un pas tres rapproche avance quand meme (' + Math.round(minuscule) + ')');
  ok(minuscule < court, 'sans pour autant valoir un pas plein');
}

// ================== 3. LA CADENCE EST TENUE PAR LE SERVEUR
{
  const r = new Realm({ alea: alea(9) });
  r.rejoint(A, FICHE);
  const a = M.ARMES.lame;

  eq(r.tire(A, 0), a.tirs, 'le premier tir part');
  let refuses = 0;
  for (let i = 0; i < 50; i++) if (r.tire(A, 0) === 0) refuses++;
  eq(refuses, 50, 'cinquante demandes immediates ne donnent AUCUN projectile de plus');

  /* Apres le temps de recharge REEL — celui de l'arme divise par la
     dexterite du personnage, depuis qu'elle compte. Attendre `1/cadence`
     comme avant reviendrait a supposer une dexterite de 50 chez tout le
     monde. */
  const dext = M.cadenceDe(FICHE.stats.dex || 0);
  /* En PETITS pas : `pas()` borne chaque appel a une demi-seconde — c'est la
     protection contre un onglet endormi — et une recharge plus longue que ca
     ne s'ecoule donc pas en une fois. */
  const attente = 1 / (a.cadence * dext) + 0.02;
  for (let t = 0; t < attente; t += 0.1) r.pas(0.1);
  eq(r.tire(A, 0), a.tirs, 'une fois recharge, le tir repart');

  /* ---- LA DEXTERITE FAIT TIRER PLUS VITE ----
     Elle etait affichee, elle montait avec les niveaux, elle se payait en
     equipement — et elle ne changeait rien. On compte les projectiles de
     deux personnages sur la meme duree, avec la meme arme. */
  const compte = (dex) => {
    const rr = new Realm({ alea: alea(90) });
    rr.monstres = [];
    rr.rejoint(B, { ...FICHE, stats: { ...FICHE.stats, dex } });
    let n = 0;
    for (let i = 0; i < 60; i++) { n += rr.tire(B, 0); rr.pas(0.05); }
    return n;
  };
  const lent = compte(20), vif = compte(75);
  ok(vif > lent,
     `75 de dexterite tire plus que 20 (${vif} projectiles contre ${lent})`);

  /* ---- LA VITESSE FAIT COURIR PLUS VITE ----
     Meme histoire. On mesure le PLAFOND que le serveur accorde, seul endroit
     ou le serveur ait son mot a dire sur le deplacement. */
  {
    const plafond = (spd) => {
      const rr = new Realm({ alea: alea(91) }); rr.monstres = [];
      const jj = rr.rejoint(B, { ...FICHE, stats: { ...FICHE.stats, spd } });
      const x0 = jj.x;
      rr.bouge(B, jj.x + 1e6, jj.y, 'right', 'run', 0.1);
      return jj.x - x0;
    };
    const lourd = plafond(23), coureur = plafond(94);
    ok(coureur > lourd,
       `94 de vitesse va plus loin que 23 (${coureur.toFixed(0)} contre ${lourd.toFixed(0)} unites)`);
    ok(Math.abs(coureur / lourd - M.vitesseDe(94) / M.vitesseDe(23)) < 0.02,
       'et l ecart suit exactement la table des vitesses');
    /* ---- FUIR RESTE UNE OPTION ----
     * Le plus lent des personnages doit distancer le plus rapide des
     * monstres, sinon fuir cesse d'exister comme choix. La marge n'a pas
     * besoin d'etre enorme : un rodeur du marais a 150 contre un personnage a
     * 202, c'est une poursuite longue et tendue, et c'est exactement ce qu'on
     * veut de lui. */
    const plusRapide = Math.max(...Object.keys(M.MONSTRES).map((k) => M.MONSTRES[k].vitesse));
    ok(M.vitesseDe(23) > plusRapide * 1.3,
       `meme le plus lourd distance le plus rapide des monstres ` +
       `(${M.vitesseDe(23).toFixed(0)} contre ${plusRapide})`);

    /* ---- ET LE PIEGE QUI COMPTE VRAIMENT ----
     *
     * Ralenti de moitie, le personnage le plus lent tombe a 101 — plus lent
     * que le rodeur. Un anneau qui contiendrait A LA FOIS une creature qui
     * ralentit et une creature assez rapide pour rattraper un joueur ralenti
     * donnerait une mort sans aucune sortie : on est freine, puis rattrape,
     * puis mordu jusqu'a la fin.
     *
     * Ce n'est pas une question de reglage mais de PEUPLEMENT : les deux ne
     * doivent jamais habiter le meme anneau. Le test le verifie anneau par
     * anneau, pour que personne ne les reunisse un jour sans s'en rendre
     * compte. */
    const ralentie = M.vitesseDe(23) * M.EFFETS.ralenti.facteur;
    Object.keys(M.PEUPLEMENT).forEach((b) => {
      const especes = M.PEUPLEMENT[b].especes.map((e) => M.MONSTRES[e]);
      const ralentit = especes.filter((t) => t.tir && t.tir.effet === 'ralenti');
      const rattrape = especes.filter((t) => t.vitesse >= ralentie);
      ok(!(ralentit.length && rattrape.length),
         `« ${b} » ne reunit pas un ralentisseur et un poursuivant trop rapide ` +
         `(${ralentit.map((t) => t.nom).join(',') || 'aucun ralentisseur'} / ` +
         `${rattrape.map((t) => t.nom).join(',') || 'aucun trop rapide'})`);
    });
  }

  /* En une seconde de jeu, on ne peut pas depasser la cadence annoncee.
     C'est LE verrou : sans lui, un client modifie viderait la carte. */
  const r2 = new Realm({ alea: alea(10) });
  r2.rejoint(A, FICHE);
  let partis = 0;
  for (let i = 0; i < 100; i++) { partis += r2.tire(A, 0); r2.pas(0.01); }
  ok(partis <= Math.ceil(a.cadence) * a.tirs + a.tirs,
    'en une seconde on ne depasse pas la cadence de l arme (a ' + partis + ' projectiles)');
}

// ================== 4. LES MONSTRES POURSUIVENT ET S'ARRETENT AU CONTACT
{
  const r = new Realm({ alea: alea(3) });
  const j = r.rejoint(A, FICHE);
  /* ---- ON CHERCHE UNE PLACE LIBRE, ON NE LA SUPPOSE PAS ----
   * Le lime etait plante a `j.x + 300`, en dur. Ca marchait tant que le
   * peuplement ne bougeait pas : le meme germe donnait la meme carte et le
   * meme point de naissance. Le jour ou l'anneau du debut est passe de
   * quarante a cent dix creatures, le tirage a consomme plus de nombres, tout
   * a glisse — et le lime s'est retrouve DANS un rocher, immobile. L'essai
   * disait alors « il ne se rapproche pas », ce qui etait vrai et n'avait
   * rien a voir avec ce qu'il verifie.
   * On essaie donc les quatre directions et l'on garde la premiere qui soit
   * libre pour le monstre ET pour le chemin qu'il doit parcourir. */
  const RAY = M.MONSTRES.lime.rayon;
  let px = null, py = null;
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    let bon = true;
    for (let k = 40; k <= 300; k += 20) {
      if (M.bloque(r.obstacles, j.x + dx * k, j.y + dy * k, RAY)) { bon = false; break; }
    }
    if (bon) { px = j.x + dx * 300; py = j.y + dy * 300; break; }
  }
  ok(px !== null, 'on trouve une direction degagee autour du joueur');
  r.monstres = [{ id: 99, espece: 'lime', biome: 'terre',
                  x: px, y: py, ancreX: px, ancreY: py,
                  pv: 60, pvMax: 60, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  const d0 = 300;
  for (let i = 0; i < 20; i++) r.pas(0.1);
  const m = r.monstres[0];
  const d1 = Math.hypot(m.x - j.x, m.y - j.y);
  ok(d1 < d0, 'le monstre s est rapproche (de ' + d0 + ' a ' + Math.round(d1) + ')');
  eq(m.cible, A, 'et il a bien pris le joueur pour cible');

  // il finit au contact et s y ARRETE, sans traverser
  for (let i = 0; i < 80; i++) r.pas(0.1);
  const d2 = Math.sqrt((r.monstres[0].x - j.x) ** 2 + (r.monstres[0].y - j.y) ** 2);
  ok(d2 >= M.MONSTRES.lime.rayon, 'il ne rentre pas DANS le joueur (a ' + Math.round(d2) + ')');
  ok(d2 <= M.MONSTRES.lime.rayon + 40, 'mais il reste colle (a ' + Math.round(d2) + ')');
}

// ================== 5. AU CONTACT, IL BLESSE — ET ON PEUT EN MOURIR
{
  const r = new Realm({ alea: alea(11) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [{ id: 1, espece: 'skeleton', biome: 'neige',
                  x: j.x + 10, y: j.y, ancreX: j.x, ancreY: j.y,
                  pv: 180, pvMax: 180, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  const pv0 = j.pv;
  let contact = 0, tirs = 0, mort = null;
  for (let i = 0; i < 400 && !mort; i++) {
    const ev = r.pas(0.1);
    ev.degats.forEach((d) => { if (d.quoi === 'contact') contact++; else if (d.quoi === 'tir') tirs++; });
    if (ev.morts.length) mort = ev.morts[0];
  }
  ok(contact > 0, 'le squelette a bien frappe au contact');
  ok(j.pv < pv0, 'les points de vie ont baisse');
  ok(mort && mort.addr === A, 'et le joueur a fini par mourir');
  eq(j.pv, 0, 'a zero point de vie exactement');
  eq(mort.par, 'skeleton', 'l evenement dit QUI a tue');

  /* ---- IL FRAPPE ET IL TIRE ----
     Depuis que toutes les creatures decochent, « par: skeleton » ne distingue
     plus la morsure de l os lance. C'est `quoi` qui le fait, et sans lui ce
     test comptait les deux ensemble en croyant compter le contact. */
  ok(tirs > 0, 'et il a aussi decoche des os (' + tirs + ')');
  ok(M.MONSTRES.skeleton.tir.att < M.MONSTRES.skeleton.att,
     'son tir frappe moins fort que son contact');
}

// ================== 6. ON TUE, ET L'XP EST RENDUE — PAS APPLIQUEE
{
  const r = new Realm({ alea: alea(21) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [{ id: 7, espece: 'lime', biome: 'terre',
                  x: j.x + 120, y: j.y, ancreX: j.x + 120, ancreY: j.y,
                  pv: 60, pvMax: 60, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  let kills = [], touches = 0, tours = 0;
  while (!kills.length && tours < 400) {
    tours++;
    r.tire(A, 0);                 // plein est, vers le lime
    const ev = r.pas(0.05);
    touches += ev.touches.length;
    kills = kills.concat(ev.kills);
  }
  eq(kills.length, 1, 'le lime est mort');
  eq(kills[0].espece, 'lime', 'et l evenement dit laquelle');
  eq(kills[0].xp, M.MONSTRES.lime.xp, 'l XP rendue est celle du catalogue');
  eq(kills[0].addr, A, 'creditee au bon joueur');
  ok(touches >= 2, 'il a fallu plusieurs coups pour l abattre (a ' + touches + ')');
  eq(r.monstres.length, 0, 'le cadavre a quitte la carte');
  eq(j.xpGagnee, M.MONSTRES.lime.xp, 'le compteur du joueur suit');
}

// ================== 7. UN TIR NE PORTE PAS PLUS LOIN QUE SON ARME
{
  const r = new Realm({ alea: alea(31) });
  const j = r.rejoint(A, FICHE);
  const portee = M.ARMES.lame.portee;
  // un monstre JUSTE hors de portee
  r.monstres = [{ id: 3, espece: 'lime', biome: 'terre',
                  x: j.x + portee + 90, y: j.y, ancreX: j.x + portee + 90, ancreY: j.y,
                  pv: 60, pvMax: 60, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  r.tire(A, 0);
  let touches = 0;
  for (let i = 0; i < 60; i++) touches += r.pas(0.02).touches.length;
  eq(touches, 0, 'le projectile meurt avant d atteindre un monstre trop loin');
  eq(r.tirs.length, 0, 'et il ne reste aucun projectile en vol');
}

// ================== 8. ON NE VOIT QUE CE QUI EST AUTOUR DE SOI
{
  const r = new Realm({ alea: alea(41) });
  const j = r.rejoint(A, FICHE);
  const etat = r.etatPour(A, 1000);
  ok(etat, 'un joueur present a un etat');
  ok(etat.monstres.length < r.monstres.length,
    'on ne recoit pas les quarante monstres de la carte (' +
    etat.monstres.length + ' sur ' + r.monstres.length + ')');
  const loin = etat.monstres.filter((m) => {
    const dx = m.x - j.x, dy = m.y - j.y;
    return Math.sqrt(dx * dx + dy * dy) > 1000;
  });
  eq(loin.length, 0, 'et aucun de ceux recus n est hors de portee');
  eq(r.etatPour('0xinconnu', 1000), null, 'un absent n a pas d etat');

  // deux joueurs se voient, chacun depuis son point de vue
  const k = r.rejoint(B, FICHE);
  k.x = j.x + 100; k.y = j.y;
  const vueA = r.etatPour(A, 1000);
  eq(vueA.joueurs.length, 1, 'A voit B');
  eq(vueA.joueurs[0].a, B, 'et c est bien B');
  ok(!vueA.joueurs.some((o) => o.a === A), 'A ne se voit pas dans la liste des autres');
  ok(vueA.moi.pv > 0, 'A recoit SES points de vie a part');
}

// ================== 9. LA CARTE NE SE VIDE PAS, ET RIEN NE NAIT DANS LE DOS
{
  const r = new Realm({ alea: alea(51) });
  const j = r.rejoint(A, FICHE);
  const plein = r.monstres.length;
  /* Les gardiens de SALLE ne repeuplent pas : ils se rearment sur leur propre
     horloge, six minutes apres qu'on a vide la piece. Les couper ici aurait
     demande a `repeuple` de les remplacer, ce qui aurait fait revenir un boss
     dans une salle qu'on vient de nettoyer. On ne touche donc qu'au sauvage. */
  const sauvages = r.monstres.filter((m) => !m.salle);
  const gardiens = r.monstres.filter((m) => m.salle);
  ok(gardiens.length > 0, `la carte porte des gardiens de salle (${gardiens.length})`);
  r.monstres = sauvages.slice(0, sauvages.length - 12).concat(gardiens);
  const nes = r.repeuple(900);
  ok(nes > 0, 'des monstres reviennent (' + nes + ')');
  eq(r.monstres.length, plein, 'la carte retrouve son compte');
  eq(r.monstres.filter((m) => m.salle).length, gardiens.length,
     'et aucun gardien de salle n a ete ajoute au passage');
  const tropPres = r.monstres.filter((m) => {
    const dx = m.x - j.x, dy = m.y - j.y;
    return Math.sqrt(dx * dx + dy * dy) < 900;
  });
  /* Les anciens peuvent etre pres — ils etaient la avant. Ce sont les
     NOUVEAUX qui ne doivent pas apparaitre sous le nez du joueur. */
  const nouveaux = r.monstres.slice(plein - 12);
  const nouveauxPres = nouveaux.filter((m) => {
    const dx = m.x - j.x, dy = m.y - j.y;
    return Math.sqrt(dx * dx + dy * dy) < 900;
  });
  eq(nouveauxPres.length, 0, 'aucun nouveau monstre ne nait a moins de 900 unites du joueur');
  ok(tropPres.length >= 0, 'les anciens, eux, peuvent etre la ou ils sont');
}

// ================== 10. UN MORT NE JOUE PLUS
{
  const r = new Realm({ alea: alea(61) });
  const j = r.rejoint(A, FICHE);
  j.pv = 0;
  eq(r.tire(A, 0), 0, 'un joueur a zero point de vie ne tire pas');
  // et il ne sert plus de cible
  r.monstres = [{ id: 5, espece: 'lime', biome: 'terre',
                  x: j.x + 50, y: j.y, ancreX: j.x + 50, ancreY: j.y,
                  pv: 60, pvMax: 60, dir: 'down', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  const ev = r.pas(0.1);
  eq(ev.degats.length, 0, 'et plus personne ne le frappe');
  eq(r.monstres[0].cible, null, 'il a cesse d etre une cible');

  // quitter le monde le retire vraiment
  r.quitte(A);
  eq(r.etatPour(A, 1000), null, 'apres avoir quitte, plus d etat');
  eq(r.tire(A, 0), 0, 'et plus de tir');
}

// ================== 11. LE MONDE EST REPRODUCTIBLE
{
  const a = new Realm({ alea: alea(77) });
  const b = new Realm({ alea: alea(77) });
  eq(JSON.stringify(a.monstres), JSON.stringify(b.monstres),
    'meme graine, meme monde — la simulation ne depend d aucun hasard cache');
}

// ================== 12. L'ARCHER TIRE, ET SES FLECHES BLESSENT
{
  const r = new Realm({ alea: alea(101) });
  const j = r.rejoint(A, FICHE);
  const t = M.MONSTRES.archer;
  /* On le pose A PORTEE mais pas au contact : c'est la ou il doit decocher
     au lieu de s'approcher. */
  r.monstres = [{ id: 42, espece: 'archer', biome: 'neige',
                  x: j.x + t.tir.portee * 0.7, y: j.y,
                  ancreX: j.x, ancreY: j.y,
                  pv: t.pv, pvMax: t.pv, dir: 'left', cible: null, recharge: 0,
                  errX: 0, errY: 0, errChrono: 0 }];
  const pv0 = j.pv;
  let touche = null, tirsVus = 0;
  for (let i = 0; i < 400 && !touche; i++) {
    const ev = r.pas(0.05);
    if (r.tirsM.length > tirsVus) tirsVus = r.tirsM.length;
    if (ev.degats.length) touche = ev.degats[0];
  }
  ok(tirsVus > 0, 'l archer a decoche (' + tirsVus + ' fleches en vol au plus)');
  ok(touche, 'et une fleche a touche');
  eq(touche.par, 'archer', 'l evenement nomme l archer');
  ok(j.pv < pv0, 'les points de vie ont baisse');
  eq(touche.perte, M.degatsSubis(t.att, 13), 'la perte suit la meme regle que le contact');

  /* IL GARDE SES DISTANCES. Un archer colle au joueur ne serait qu'un
     squelette mal dessine : toute sa raison d'etre est l'ecart. */
  const d = Math.sqrt((r.monstres[0].x - j.x) ** 2 + (r.monstres[0].y - j.y) ** 2);
  ok(d > t.rayon + 60, 'il ne vient pas au corps a corps (a ' + Math.round(d) + ')');

  /* SES FLECHES NE TOUCHENT PAS LES MONSTRES, et les notres ne touchent pas
     les joueurs : deux listes, deux collisions. */
  const avantM = r.monstres[0].pv;
  for (let i = 0; i < 60; i++) r.pas(0.05);
  eq(r.monstres[0].pv, avantM, 'ses propres fleches ne le blessent pas');
}

// ================== 13. L'ETAT PORTE LES DEUX SORTES DE PROJECTILES
{
  const r = new Realm({ alea: alea(103) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];
  r.tire(A, 0);
  r.tirsM.push({ id: 999, espece: 'archer', x: j.x + 40, y: j.y, a: Math.PI,
                 v: 300, reste: 1, att: 45, sprite: 'maudit' });
  const e = r.etatPour(A, 1400);
  ok(e.tirs.length > 0, 'nos projectiles sont la');
  ok(e.tirsM.length > 0, 'ceux des monstres aussi');
  ok(e.tirs[0].mien === true, 'les notres sont marques comme notres');
  eq(e.tirsM[0].f, 'maudit', 'et les leurs portent leur propre dessin');
}

// ================== 14. LA VIE ET LE MANA QUI REMONTENT
//
// Le coefficient vient de monde.js (celui de RotMG). Ce qui se verifie ici,
// c'est ce que realm.js en fait : que les points soient reellement VERSES.
// La faute qui guette est bete et invisible — a 4.9 PV/s, un pas de 100 ms
// vaut 0.49 PV, arrondi a zero dix fois par seconde. La formule serait juste
// et la barre ne bougerait jamais.
{
  const FR = { ...FICHE, stats: { hp: 400, mp: 200, att: 28, def: 13, vit: 40, wis: 50 } };
  const r = new Realm({ alea: alea(200) });
  r.monstres = [];
  const j = r.rejoint(A, FR);
  j.pv = 100; j.mp = 0;

  /* Une seconde de simulation, en pas de 100 ms comme le vrai serveur. */
  for (let i = 0; i < 10; i++) r.pas(0.1);
  ok(j.pv > 100, `un point de vie est bien verse en une seconde (${j.pv})`);
  ok(j.mp > 0, `du mana aussi (${j.mp})`);

  /* Le DEBIT suit la vitalite. On ne compare pas a un chiffre en dur — le
     coefficient a le droit de changer — mais deux vitalites differentes ne
     peuvent pas donner le meme resultat, sinon la stat ne sert a rien. */
  const lent = new Realm({ alea: alea(201) }); lent.monstres = [];
  const jl = lent.rejoint(B, { ...FR, stats: { ...FR.stats, vit: 0 } });
  jl.pv = 100;
  for (let i = 0; i < 30; i++) { lent.pas(0.1); r.pas(0.1); }
  ok((j.pv - 100) > (jl.pv - 100) * 2,
     `40 de vitalite soigne bien plus vite que 0 (${j.pv - 100} contre ${jl.pv - 100})`);
}

// ================== 15. LE REPOS DOUBLE, TIRER ET COURIR CASSENT LE REPOS
//
// C'est la seule chose qui rend la vitalite lisible en jeu. Si bouger ne
// cassait pas le repos, la regeneration doublee s'appliquerait en plein
// combat et annulerait les degats recus — c'est-a-dire rendrait les monstres
// inoffensifs.
{
  const FR = { ...FICHE, stats: { hp: 900, mp: 200, att: 28, def: 13, vit: 40, wis: 50 } };

  const calme = new Realm({ alea: alea(202) }); calme.monstres = [];
  const jc = calme.rejoint(A, FR); jc.pv = 100;
  for (let i = 0; i < 60; i++) calme.pas(0.1);   // six secondes sans rien faire

  const actif = new Realm({ alea: alea(203) }); actif.monstres = [];
  const ja = actif.rejoint(A, FR); ja.pv = 100;
  for (let i = 0; i < 60; i++) {
    /* On avance de deux unites a chaque pas : loin d'etre une triche de
       vitesse, mais assez pour que ce ne soit plus du repos. */
    actif.bouge(A, ja.x + 2, ja.y, 'down', 'walk', 0.1);
    actif.pas(0.1);
  }
  ok((jc.pv - 100) > (ja.pv - 100) * 1.5,
     `six secondes de calme soignent bien plus que six secondes de course ` +
     `(${jc.pv - 100} contre ${ja.pv - 100})`);

  /* Rester immobile en continuant d'ANNONCER sa position ne casse rien : le
     client parle dix fois par seconde meme a l'arret. */
  const immobile = new Realm({ alea: alea(204) }); immobile.monstres = [];
  const ji = immobile.rejoint(A, FR); ji.pv = 100;
  for (let i = 0; i < 60; i++) {
    immobile.bouge(A, ji.x, ji.y, 'down', 'idle', 0.1);
    immobile.pas(0.1);
  }
  eq(ji.pv, jc.pv, 'annoncer la meme position ne casse pas le repos');

  /* Un mort ne se releve pas tout seul. */
  const mort = new Realm({ alea: alea(205) }); mort.monstres = [];
  const jm = mort.rejoint(A, FR); jm.pv = 0;
  for (let i = 0; i < 60; i++) mort.pas(0.1);
  eq(jm.pv, 0, 'un mort ne regenere pas');

  /* Ni la vie ni le mana ne depassent la reserve. */
  const plein = new Realm({ alea: alea(206) }); plein.monstres = [];
  const jp = plein.rejoint(A, FR);
  jp.pv = jp.pvMax - 1; jp.mp = jp.mpMax - 1;
  for (let i = 0; i < 100; i++) plein.pas(0.1);
  eq(jp.pv, jp.pvMax, 'la vie s arrete au plafond');
  eq(jp.mp, jp.mpMax, 'le mana aussi');
}

// ================== 16. LE POUVOIR DU FRUIT : CE QUI LE REFUSE
//
// Chaque refus est RENDU, jamais silencieux : une barre d'espace qui ne
// repond pas se lit comme un bug, pas comme un manque de mana.
{
  const SANS = { ...FICHE, stats: { hp: 400, mp: 200, att: 28, def: 13, vit: 10, wis: 10 } };
  const r = new Realm({ alea: alea(210) }); r.monstres = [];
  r.rejoint(A, SANS);
  eq(r.pouvoir(A, null).refus, 'aucun', 'sans fruit, pas de pouvoir');

  const AVEC = { ...SANS, statFruit: 'att' };   // -> foudre
  const r2 = new Realm({ alea: alea(211) }); r2.monstres = [];
  const j2 = r2.rejoint(A, AVEC);
  eq(j2.pouvoir, 'foudre', 'un fruit d attaque donne la foudre');

  j2.mp = 0;
  const refus = r2.pouvoir(A, null);
  eq(refus.refus, 'mana', 'sans mana, refus explicite');
  ok(refus.manque === M.POUVOIRS.foudre.cout, 'et il dit combien il manque');

  j2.mp = j2.mpMax;
  const ok1 = r2.pouvoir(A, { touches: [], kills: [] });
  ok(!ok1.refus, 'avec du mana, il part');
  eq(j2.mp, j2.mpMax - M.POUVOIRS.foudre.cout, 'et le mana est bien preleve');

  const ok2 = r2.pouvoir(A, { touches: [], kills: [] });
  eq(ok2.refus, 'recharge', 'deux fois de suite : refuse, la recharge tient');

  /* La recharge descend avec le temps, pas toute seule. */
  for (let i = 0; i < Math.ceil(M.POUVOIRS.foudre.recharge / 0.1) + 2; i++) r2.pas(0.1);
  ok(!r2.pouvoir(A, { touches: [], kills: [] }).refus,
     'la recharge ecoulee, il repart');

  /* Un mort ne lance rien. */
  j2.pv = 0;
  eq(r2.pouvoir(A, null), null, 'un mort ne lance pas de pouvoir');
}

// ================== 17. LA FOUDRE FRAPPE, ET SON XP PASSE PAR LE MEME CHEMIN
{
  const r = new Realm({ alea: alea(212) });
  const j = r.rejoint(A, { ...FICHE, statFruit: 'att',
                           stats: { hp: 400, mp: 300, att: 28, def: 13, vit: 10, wis: 10 } });
  const t = M.MONSTRES.lime;
  r.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: j.x + 120, y: j.y,
                  ancreX: j.x + 120, ancreY: j.y, pv: t.pv, pvMax: t.pv,
                  dir: 'down', cible: null, recharge: 0, stase: 0,
                  errX: 0, errY: 0, errChrono: 0 }];

  const ev = { touches: [], kills: [] };
  const s = r.pouvoir(A, ev);
  eq(s.cle, 'foudre', 'c est bien la foudre');
  ok(s.perte > 0, `elle enleve quelque chose (${s.perte})`);
  eq(ev.touches.length, 1, 'et ca passe par ev.touches, comme une fleche');

  /* PLUS FORT QU'UN TIR ORDINAIRE — sinon soixante mana et six secondes de
     recharge ne servent a rien. */
  const ordinaire = M.degatsInfliges(28, P.DEGATS_ARME.commun[1], t.def);
  ok(s.perte > ordinaire * 2, `elle frappe bien plus fort qu un tir (${s.perte} contre ${ordinaire})`);

  /* Elle ne frappe RIEN hors de portee : un pouvoir qui touche a l autre
     bout de la carte n aurait pas de portee du tout. */
  const loin = new Realm({ alea: alea(213) });
  const jl = loin.rejoint(A, { ...FICHE, statFruit: 'att',
                               stats: { hp: 400, mp: 300, att: 28, def: 13 } });
  loin.monstres = [{ id: 1, espece: 'lime', biome: 'terre',
                     x: jl.x + M.POUVOIRS.foudre.portee + 200, y: jl.y,
                     ancreX: 0, ancreY: 0, pv: t.pv, pvMax: t.pv, dir: 'down',
                     cible: null, recharge: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 }];
  const sl = loin.pouvoir(A, { touches: [], kills: [] });
  ok(sl.vide === true, 'hors de portee, elle part dans le vide');
  eq(loin.monstres[0].pv, t.pv, 'et le monstre lointain n a rien');

  /* Elle TUE, et l XP remonte par ev.kills — pas par un raccourci. */
  const mortel = new Realm({ alea: alea(214) });
  const jm = mortel.rejoint(A, { ...FICHE, statFruit: 'att',
                                 stats: { hp: 400, mp: 300, att: 55, def: 13 } });
  mortel.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: jm.x + 60, y: jm.y,
                       ancreX: 0, ancreY: 0, pv: 3, pvMax: t.pv, dir: 'down',
                       cible: null, recharge: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 }];
  const evm = { touches: [], kills: [] };
  mortel.pouvoir(A, evm);
  eq(evm.kills.length, 1, 'un eclair qui tue rend bien un kill');
  eq(evm.kills[0].xp, t.xp, 'avec l XP de l espece, la meme qu une fleche');
  eq(jm.xpGagnee, t.xp, 'et elle est portee au compte du joueur');
}

// ================== 18. LA STASE FIGE VRAIMENT
//
// Cinq secondes pendant lesquelles un monstre ne bouge pas, ne frappe pas et
// ne tire pas. La faute a eviter : le laisser flaner doucement, ce qui
// donnerait l impression que le pouvoir n a pas pris.
{
  const r = new Realm({ alea: alea(220) });
  /* ---- LE FRUIT QUI DONNE LA STASE, DEMANDE AU MONDE ----
   * C'etait « garde », ecrit en dur. La garde donne desormais l'egide — deux
   * stats pour la stase etaient une place perdue — et cet essai est tombe en
   * accusant le moteur alors que c'est LUI qui portait l'ancienne reponse.
   * On cherche donc la stat qui mene a la stase, plutot que de parier sur
   * laquelle c'est. */
  const STAT_STASE = Object.keys(M.POUVOIR_PAR_STAT)
    .find((k) => M.POUVOIR_PAR_STAT[k] === 'stase');
  ok(!!STAT_STASE, `« ${STAT_STASE} » mene a la stase`);
  const j = r.rejoint(A, { ...FICHE, statFruit: STAT_STASE,
                           stats: { hp: 900, mp: 300, att: 28, def: 13 } });
  eq(r.joueurs.get(A).pouvoir, 'stase', 'et le joueur la porte');

  const t = M.MONSTRES.lime;
  r.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: j.x + 100, y: j.y,
                  ancreX: j.x + 100, ancreY: j.y, pv: t.pv, pvMax: t.pv,
                  dir: 'down', cible: null, recharge: 0, stase: 0,
                  errX: 1, errY: 0, errChrono: 99 }];

  const s = r.pouvoir(A, { touches: [], kills: [] });
  eq(s.cle, 'stase', 'c est bien la stase');
  eq(s.figes.length, 1, 'le monstre a portee est fige');
  eq(s.duree, 5, 'pendant cinq secondes, la duree demandee');

  const x0 = r.monstres[0].x, y0 = r.monstres[0].y, pv0 = j.pv;
  for (let i = 0; i < 40; i++) r.pas(0.1);   // quatre secondes
  eq(r.monstres[0].x, x0, 'il n a pas bouge d un pouce');
  eq(r.monstres[0].y, y0, 'ni en hauteur');
  eq(j.pv, pv0, 'et il n a pas frappe');

  /* On le voit dans l etat, sinon quatre secondes de monstres immobiles se
     lisent comme un serveur qui a lache. */
  const e = r.etatPour(A, 1400);
  ok(e.monstres[0].st > 0, 'la stase se voit dans l etat');

  /* Elle FINIT. Un monstre fige pour toujours serait un monstre mort.
     On mesure le depart depuis la position OU IL ETAIT FIGE : deux secondes
     de plus suffisent au lime pour couvrir les cent unites qui le separent
     du joueur et se coller au contact, ou il s'arrete de nouveau — comparer
     deux positions apres coup ne prouverait donc rien. */
  for (let i = 0; i < 20; i++) r.pas(0.1);
  ok(!r.monstres[0].stase, 'la stase finit par tomber');
  ok(Math.abs(r.monstres[0].x - x0) > 20,
     `et le monstre repart (de ${Math.round(x0)} a ${Math.round(r.monstres[0].x)})`);

  /* Un monstre fige reste une CIBLE : il encaisse les fleches. */
  const rr = new Realm({ alea: alea(221) });
  const jj = rr.rejoint(A, { ...FICHE, statFruit: STAT_STASE,
                             stats: { hp: 900, mp: 300, att: 28, def: 13 } });
  rr.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: jj.x + 100, y: jj.y,
                   ancreX: 0, ancreY: 0, pv: t.pv, pvMax: t.pv, dir: 'down',
                   cible: null, recharge: 0, stase: 0, errX: 0, errY: 0, errChrono: 99 }];
  rr.pouvoir(A, { touches: [], kills: [] });
  rr.tire(A, 0);
  for (let i = 0; i < 10; i++) rr.pas(0.05);
  ok(rr.monstres[0].pv < t.pv, 'un monstre fige encaisse quand meme les tirs');

  /* Hors du rayon, rien n est fige. */
  const rl = new Realm({ alea: alea(222) });
  const jl = rl.rejoint(A, { ...FICHE, statFruit: STAT_STASE,
                             stats: { hp: 900, mp: 300, att: 28, def: 13 } });
  rl.monstres = [{ id: 1, espece: 'lime', biome: 'terre',
                   x: jl.x + M.POUVOIRS.stase.rayon + 150, y: jl.y,
                   ancreX: 0, ancreY: 0, pv: t.pv, pvMax: t.pv, dir: 'down',
                   cible: null, recharge: 0, stase: 0, errX: 0, errY: 0, errChrono: 99 }];
  eq(rl.pouvoir(A, { touches: [], kills: [] }).figes.length, 0,
     'hors du rayon, rien n est fige');
}

// ================== 19. LA RAFALE ACCELERE LA CADENCE, ET SEULEMENT ELLE
{
  const FR = { ...FICHE, statFruit: 'dex',
               stats: { hp: 400, mp: 300, att: 28, def: 13 } };
  const compte = (avecRafale) => {
    const r = new Realm({ alea: alea(230) });
    r.monstres = [];
    const j = r.rejoint(A, FR);
    if (avecRafale) r.pouvoir(A, { touches: [], kills: [] });
    let tirs = 0;
    /* Deux secondes : on demande a tirer a chaque pas, le serveur refuse ce
       que la cadence ne permet pas. */
    for (let i = 0; i < 40; i++) { tirs += r.tire(A, 0); r.pas(0.05); }
    return { tirs, j };
  };
  const sans = compte(false);
  const avec = compte(true);
  eq(sans.j.pouvoir, 'rafale', 'un fruit de dexterite donne la rafale');
  ok(avec.tirs > sans.tirs,
     `la rafale fait partir plus de projectiles (${avec.tirs} contre ${sans.tirs})`);

  /* Elle ne change PAS le nombre de projectiles par tir : c'est la main qui
     va plus vite, pas l arme qui se dedouble. Une lame tire 1, elle continue. */
  const r = new Realm({ alea: alea(231) }); r.monstres = [];
  r.rejoint(A, FR);
  r.pouvoir(A, { touches: [], kills: [] });
  eq(r.tire(A, 0), M.ARMES.lame.tirs, 'un tir reste un tir');

  /* Elle FINIT. */
  const rf = new Realm({ alea: alea(232) }); rf.monstres = [];
  const jf = rf.rejoint(A, FR);
  rf.pouvoir(A, { touches: [], kills: [] });
  ok(jf.rafale > 0, 'la rafale est active');
  for (let i = 0; i < Math.ceil(M.POUVOIRS.rafale.duree / 0.1) + 2; i++) rf.pas(0.1);
  eq(jf.rafale, 0, 'et elle retombe apres sa duree');
}

// ================== 20. L'ETAT PORTE LE MANA ET L'ETAT DU POUVOIR
//
// Le bouton doit pouvoir s eteindre a la seconde ou le mana manque, pas
// quand le joueur appuie pour rien.
{
  const r = new Realm({ alea: alea(240) }); r.monstres = [];
  const j = r.rejoint(A, { ...FICHE, statFruit: 'wis',
                           stats: { hp: 400, mp: 250, att: 28, def: 13, vit: 20, wis: 30 } });
  const e = r.etatPour(A, 1400);
  eq(e.moi.mpMax, 250, 'la reserve de mana part avec l etat');
  eq(e.moi.mp, 250, 'et ce qu il en reste');
  eq(e.moi.po, 'stase', 'le pouvoir aussi');
  eq(e.moi.poR, 0, 'et sa recharge');

  r.pouvoir(A, { touches: [], kills: [] });
  const e2 = r.etatPour(A, 1400);
  ok(e2.moi.mp < 250, 'le mana depense se voit tout de suite');
  ok(e2.moi.poR > 0, 'la recharge aussi');

  /* Sans fruit, le client doit savoir qu il n y a rien a montrer. */
  const r2 = new Realm({ alea: alea(241) }); r2.monstres = [];
  r2.rejoint(B, FICHE);
  eq(r2.etatPour(B, 1400).moi.po, null, 'sans fruit, aucun pouvoir annonce');
}

// ================== 21. LA MEDUSE : ON PERD LES JAMBES, PAS LES BRAS
//
// C'est le seul monstre qui retire une CAPACITE plutot que de la vie. Trois
// choses doivent tenir, et les trois sont des questions de justice plus que
// de code : le refus vient du SERVEUR, on peut encore tirer, et on ne peut
// pas etre cloue au sol indefiniment.
{
  const FR = { ...FICHE, stats: { hp: 900, mp: 200, att: 28, def: 13, vit: 10, wis: 10 } };
  const t = M.MONSTRES.meduse;
  ok(!!t, 'la meduse existe');
  ok(!t.contact && t.tir && t.tir.effet === 'paralyse', 'elle paralyse a distance');

  const pose = (r, j) => {
    r.tirsM.push({ id: 900, espece: 'meduse', x: j.x + 10, y: j.y, a: 0,
                   v: 1, reste: 5, att: t.tir.att, sprite: 'oeil', effet: 'paralyse' });
  };

  /* ---- LE REFUS VIENT DU SERVEUR ----
     Une paralysie qui ne serait que dessinee se contournerait en ouvrant la
     console du navigateur. On envoie donc un deplacement PARFAITEMENT
     honnete — un pas normal, a la bonne vitesse — et il doit etre refuse. */
  {
    const r = new Realm({ alea: alea(300) }); r.monstres = [];
    const j = r.rejoint(A, FR);
    pose(r, j);
    r.pas(0.05);
    ok(j.paralyse > 0, 'le tir paralysant cloue le joueur');

    const x0 = j.x, y0 = j.y;
    const accepte = r.bouge(A, j.x + 12, j.y, 'right', 'run', 0.1);
    eq(accepte, false, 'le serveur REFUSE le deplacement');
    eq(j.x, x0, 'et la position ne bouge pas d un pouce');
    eq(j.y, y0, 'ni en hauteur');
    eq(j.anim, 'idle', 'le personnage ne fait meme pas semblant de courir');

    /* Se retourner n'est pas se deplacer : un personnage fige qui tire dans
       le dos de ce qu'il vise serait absurde. */
    r.bouge(A, j.x, j.y, 'left', 'run', 0.1);
    eq(j.dir, 'left', 'mais il peut encore se tourner');

    /* ON PEUT ENCORE TIRER. C'est toute la difference entre paralyser et
       etourdir, et c'est la seule chose qui laisse une reponse au joueur. */
    ok(r.tire(A, 0) > 0, 'et surtout : il peut encore TIRER');
  }

  /* ---- ELLE FINIT, ET ON REPART ---- */
  {
    const r = new Realm({ alea: alea(301) }); r.monstres = [];
    const j = r.rejoint(A, FR);
    pose(r, j);
    r.pas(0.05);
    const pas = Math.ceil(M.EFFETS.paralyse.duree / 0.1) + 2;
    for (let i = 0; i < pas; i++) r.pas(0.1);
    eq(j.paralyse, 0, 'la paralysie finit');
    const x0 = j.x;
    ok(r.bouge(A, j.x + 12, j.y, 'right', 'run', 0.1), 'et on peut repartir');
    ok(j.x > x0, 'la position avance de nouveau');
  }

  /* ---- ON NE PEUT PAS ETRE CLOUE INDEFINIMENT ----
   *
   * C'est LA verification qui compte. Dans un jeu ou la mort detruit
   * l'equipement paye en vrai $SWOGE, une mort sans aucune action possible
   * n'est pas une difficulte, c'est un vol. On simule donc le pire cas
   * imaginable — un tir paralysant qui arrive a CHAQUE pas, comme si dix
   * meduses tiraient sans interruption — et on mesure la part du temps
   * passee immobile. Elle doit rester minoritaire. */
  {
    const r = new Realm({ alea: alea(302) }); r.monstres = [];
    const j = r.rejoint(A, FR);
    j.pv = 1e9; j.pvMax = 1e9;      // on mesure la paralysie, pas la survie
    let fige = 0, total = 0;
    for (let i = 0; i < 400; i++) {          // quarante secondes
      pose(r, j);
      r.pas(0.1);
      total++;
      if (j.paralyse > 0) fige++;
    }
    const part = fige / total;
    ok(part < 0.5,
       `sous un tir paralysant permanent, on passe moins de la moitie du temps fige (${Math.round(part * 100)} %)`);
    /* Et la propriete exacte qu'on a voulue : l'immunite est plus longue que
       la paralysie, donc on bouge toujours plus qu'on ne subit. */
    ok(M.EFFETS.paralyse.immunite > M.EFFETS.paralyse.duree,
       'l immunite dure plus longtemps que la paralysie elle-meme');
  }

  /* ---- UN MORT NE SE FAIT PAS PARALYSER ----
     Le compteur survivrait a la reapparition, et le joueur reviendrait au
     Nexus incapable de bouger sans comprendre pourquoi. */
  {
    const r = new Realm({ alea: alea(303) }); r.monstres = [];
    const j = r.rejoint(A, { ...FR, stats: { ...FR.stats, hp: 10 } });
    pose(r, j);
    r.pas(0.05);
    eq(j.pv, 0, 'le tir l a tue');
    eq(j.paralyse, 0, 'et un mort ne se fait pas paralyser');
  }

  /* ---- L EFFET VOYAGE AVEC LE PROJECTILE ----
     Une fleche deja en vol quand la meduse meurt garde son pouvoir : tuer le
     lanceur n annule pas un coup deja porte. */
  {
    const r = new Realm({ alea: alea(304) });
    const j = r.rejoint(A, FR);
    r.monstres = [];                          // plus aucune meduse en vie
    pose(r, j);
    r.pas(0.05);
    ok(j.paralyse > 0, 'la fleche en vol paralyse meme sans son lanceur');
  }

  /* ---- LA PAGE EST PREVENUE ---- */
  {
    const r = new Realm({ alea: alea(305) }); r.monstres = [];
    const j = r.rejoint(A, FR);
    eq(r.etatPour(A, 1400).moi.par, 0, 'l etat porte la paralysie, a zero au repos');
    pose(r, j);
    const ev = r.pas(0.05);
    ok(r.etatPour(A, 1400).moi.par > 0, 'et elle apparait des qu on est cloue');
    const d = ev.degats.filter((x) => x.paralyse > 0)[0];
    ok(d, 'le coup annonce lui-meme qu il paralyse');
    eq(d.paralyse, M.EFFETS.paralyse.duree, 'avec sa duree, pour que la page puisse le dire');
    eq(d.effet, 'paralyse', 'et il nomme l etat pose');
  }

  /* ---- ELLE N EST PAS SUR LA TERRE ----
     L anneau exterieur est celui ou l on apprend. Perdre le controle de son
     personnage avant d avoir compris qu on peut encore tirer ferait
     abandonner. */
  ok(M.PEUPLEMENT.terre.especes.indexOf('meduse') < 0,
     'la meduse ne nait pas sur la terre, l anneau des debutants');
  ok(M.PEUPLEMENT.neige.especes.indexOf('meduse') >= 0, 'mais bien dans la neige');
}

// ================== 22. MOURIR LAISSE UNE PIERRE
//
// Elle ne sert pas a decorer : c'est la seule facon dont un joueur apprend
// qu'un endroit est dangereux AVANT d'y aller. Trois choses doivent tenir :
// elle nait a l'endroit exact, elle SURVIT a celui qui la laisse, et elle
// finit par s'effacer.
{
  const FR = { ...FICHE, nom: 'Dodexel',
               stats: { hp: 10, mp: 100, att: 28, def: 0, vit: 10, wis: 10 } };
  const t = M.MONSTRES.archer;

  const tue = (graine) => {
    const r = new Realm({ alea: alea(graine) });
    r.monstres = [];
    const j = r.rejoint(A, FR);
    r.tirsM.push({ id: 800, espece: 'archer', x: j.x + 10, y: j.y, a: 0,
                   v: 1, reste: 5, att: 500, sprite: 'maudit' });
    const ev = r.pas(0.05);
    return { r, j, ev };
  };

  {
    const { r, j, ev } = tue(400);
    eq(j.pv, 0, 'le joueur est mort');
    eq(ev.morts.length, 1, 'la mort est annoncee');
    eq(r.tombes.length, 1, 'et elle laisse UNE pierre');
    const tb = r.tombes[0];
    eq(tb.x, j.x, 'a l endroit exact ou il est tombe');
    eq(tb.y, j.y, 'y compris en hauteur');
    eq(tb.nom, 'Dodexel', 'elle porte son nom — « quelqu un est mort ici » ne vaut rien');
    eq(tb.par, 'archer', 'et ce qui l a tue');
    eq(tb.reste, M.TOMBE.duree, 'elle part avec sa minute entiere');

    /* ---- ELLE SURVIT A CELUI QUI LA LAISSE ----
       Le serveur sort le mort du monde juste apres : une tombe rangee dans le
       joueur disparaitrait avec lui, ce qui est exactement le contraire de ce
       qu on veut. */
    r.quitte(A);
    eq(r.joueurs.size, 0, 'le mort a quitte le monde');
    eq(r.tombes.length, 1, 'la pierre, elle, est toujours la');
  }

  /* ---- ELLE S EFFACE ----
     Un monde pave de pierres eternelles ne raconte plus rien. */
  {
    const { r } = tue(401);
    r.quitte(A);
    /* Juste avant l echeance, elle est encore la. */
    const presque = Math.floor((M.TOMBE.duree - 1) / 0.5);
    for (let i = 0; i < presque; i++) r.pas(0.5);
    eq(r.tombes.length, 1, `elle tient encore a ${M.TOMBE.duree - 1} s`);
    for (let i = 0; i < 6; i++) r.pas(0.5);
    eq(r.tombes.length, 0, 'et elle a disparu apres sa minute');
  }

  /* ---- ELLE NE PERD PAS LE PAS OU ELLE EST NEE ----
     Les pierres vieillissent AVANT les morts du pas. Dans l ordre inverse —
     c est ce que j avais ecrit d abord, et ce test l a attrape — une tombe
     posee a l instant partait avec 59,95 s au lieu de 60. */
  {
    const r = new Realm({ alea: alea(402) });
    r.monstres = [];
    const j = r.rejoint(A, FR);
    r.tirsM.push({ id: 801, espece: 'archer', x: j.x + 10, y: j.y, a: 0,
                   v: 1, reste: 5, att: 500, sprite: 'maudit' });
    r.pas(0.4);
    eq(r.tombes[0].reste, M.TOMBE.duree, 'la minute est entiere au pas de sa naissance');
  }

  /* ---- ON VOIT CELLES DES AUTRES ----
     Une pierre qu on serait seul a voir ne previendrait personne. */
  {
    const r = new Realm({ alea: alea(403) });
    r.monstres = [];
    const mort = r.rejoint(A, FR);
    const vivant = r.rejoint(B, { ...FICHE, nom: 'Temoin',
                                  stats: { hp: 900, mp: 100, att: 28, def: 13 } });
    vivant.x = mort.x + 60; vivant.y = mort.y;
    r.tirsM.push({ id: 802, espece: 'archer', x: mort.x + 10, y: mort.y, a: 0,
                   v: 1, reste: 5, att: 500, sprite: 'maudit' });
    r.pas(0.05);
    r.quitte(A);
    const vue = r.etatPour(B, 1400);
    eq(vue.tombes.length, 1, 'le temoin voit la pierre du mort');
    eq(vue.tombes[0].nom, 'Dodexel', 'avec son nom');
    ok(vue.tombes[0].r > 0, 'et le temps qu il lui reste');

    /* Mais pas celles du bout de la carte : la vue est bornee comme le reste. */
    r.tombes.push({ id: 999, x: mort.x + 9000, y: mort.y, nom: 'Loin',
                    skin: null, par: 'lime', reste: 30 });
    eq(r.etatPour(B, 1400).tombes.length, 1, 'une pierre hors de portee ne voyage pas');
  }

  /* ---- LE PLAFOND ----
     Rien n empeche en principe cent morts dans la meme minute, et une liste
     sans borne finit par voyager en entier vers chaque client. */
  {
    const r = new Realm({ alea: alea(404) });
    r.monstres = [];
    for (let i = 0; i < M.TOMBE.plafond + 25; i++) {
      const j = r.rejoint('0x' + String(i).padStart(40, '0'), FR);
      r._meurt(j, 'lime', { morts: [] });
    }
    eq(r.tombes.length, M.TOMBE.plafond, 'la liste est bornee');
    /* C est la PLUS VIEILLE qui part : la plus recente est celle qui a encore
       quelque chose a apprendre a quelqu un. */
    ok(r.tombes[r.tombes.length - 1].reste === M.TOMBE.duree, 'la derniere posee est gardee');
  }
}

// ================== 23. TOUT LE MONDE TIRE, ET CHACUN SON ETAT
//
// Six creatures, six facons de gener. Ce qui se verifie ici n'est pas que le
// code tourne — c'est que chaque monstre reste JOUABLE : on peut toujours
// riposter, et aucun etat ne peut etre enchaine indefiniment.
{
  const FR = { ...FICHE, nom: 'Dodexel',
               stats: { hp: 4000, mp: 200, att: 28, def: 13, vit: 10, wis: 10 } };

  /* ---- CHAQUE ESPECE A UN TIR ---- */
  Object.keys(M.MONSTRES).forEach((k) => {
    const t = M.MONSTRES[k];
    ok(t.tir && t.tir.portee > 0, `« ${t.nom} » decoche (portee ${t.tir && t.tir.portee})`);
    ok(t.tir.sprite, `« ${t.nom} » a un dessin de projectile (${t.tir.sprite})`);
    /* LE TIR FRAPPE MOINS FORT QUE LE CONTACT. Sans cette regle, donner une
       attaque a distance a six creatures doublait la difficulte du monde d'un
       coup. Les deux creatures qui ne touchent pas au contact en sont
       exemptees : le tir EST leur seule attaque. */
    if (t.contact !== false) {
      const attTir = t.tir.att === undefined ? t.att : t.tir.att;
      ok(attTir < t.att,
         `« ${t.nom} » : son tir (${attTir}) frappe moins fort que son contact (${t.att})`);
    }
  });

  /* Les dessins de projectiles sont TOUS DIFFERENTS d'une famille a l'autre —
     sinon deux monstres qu'on ne distingue pas au projectile se jouent
     pareil, et l'effet arrive sans prevenir. */
  {
    const vus = {};
    Object.keys(M.MONSTRES).forEach((k) => {
      const sp = M.MONSTRES[k].tir.sprite;
      ok(!vus[sp] || M.MONSTRES[k].tir.effet === M.MONSTRES[vus[sp]].tir.effet,
         `« ${sp} » n'est partage que par des creatures au meme effet`);
      vus[sp] = k;
    });
  }

  /* ---- IL FRAPPE ET IL TIRE, PAS L'UN OU L'AUTRE ----
     Deux recharges separees : un monstre qui vient de decocher doit pouvoir
     mordre dans la seconde. */
  {
    const r = new Realm({ alea: alea(500) });
    const j = r.rejoint(A, FR);
    const t = M.MONSTRES.lime;
    r.monstres = [{ id: 1, espece: 'lime', biome: 'terre', x: j.x + 20, y: j.y,
                    ancreX: j.x, ancreY: j.y, pv: 1e9, pvMax: 1e9, dir: 'left',
                    cible: null, recharge: 0, rechargeT: 0, stase: 0,
                    errX: 0, errY: 0, errChrono: 0 }];
    let contact = 0, tirs = 0;
    for (let i = 0; i < 200; i++) {
      const ev = r.pas(0.1);
      ev.degats.forEach((d) => { if (d.quoi === 'contact') contact++; else if (d.quoi === 'tir') tirs++; });
    }
    ok(contact > 0, `le lime mord (${contact} fois)`);
    ok(tirs > 0, `et il crache (${tirs} fois)`);
  }

  /* ---- LE RALENTISSEMENT EST APPLIQUE PAR LE SERVEUR ----
   * Une page qui accepterait poliment de bouger moins vite se corrigerait en
   * ouvrant la console. On envoie donc un deplacement a la vitesse NORMALE —
   * parfaitement honnete en temps ordinaire — et il doit etre ramene. */
  {
    const r = new Realm({ alea: alea(501) }); r.monstres = [];
    const j = r.rejoint(A, FR);
    const t = M.MONSTRES.glace;
    eq(t.tir.effet, 'ralenti', 'le revenant de glace ralentit');

    /* ---- ON MESURE LE PLAFOND, PAS UN PAS ORDINAIRE ----
     * Le serveur BORNE ce qu'un client annonce ; il ne le deplace pas. Un pas
     * honnete de vitesse normale passe donc sans etre touche, ralenti ou non,
     * tant qu'il reste sous le plafond — c'est la marge de tolerance reseau
     * (1,6) qui laisse cette place, et elle existe pour qu'un joueur honnete
     * ne begaye pas.
     *
     * Ce qui doit baisser de moitie, c'est le PLAFOND. On demande donc un
     * deplacement impossible dans les deux cas et on compare ce qui est
     * accorde. C'est la seule mesure qui dit quelque chose du serveur. */
    const enorme = M.VITESSE_JOUEUR * 10;
    const x0 = j.x;
    r.bouge(A, j.x + enorme, j.y, 'right', 'run', 0.1);
    const plafondLibre = j.x - x0;

    r.tirsM.push({ id: 901, espece: 'glace', x: j.x + 10, y: j.y, a: 0,
                   v: 1, reste: 5, att: t.tir.att, sprite: 'gel', effet: 'ralenti' });
    r.pas(0.05);
    ok(j.ralenti > 0, 'le tir de glace ralentit');

    const x1 = j.x;
    r.bouge(A, j.x + enorme, j.y, 'right', 'run', 0.1);
    const plafondFreine = j.x - x1;
    const rapport = plafondFreine / plafondLibre;
    ok(Math.abs(rapport - M.EFFETS.ralenti.facteur) < 0.02,
       `le plafond du serveur tombe au facteur exact (${rapport.toFixed(2)} pour ` +
       `${M.EFFETS.ralenti.facteur} attendu)`);

    /* ON PEUT ENCORE TIRER : on perd les jambes, jamais les bras. */
    ok(r.tire(A, 0) > 0, 'et on peut toujours tirer');

    /* ELLE FINIT. */
    for (let i = 0; i < Math.ceil(M.EFFETS.ralenti.duree / 0.1) + 2; i++) r.pas(0.1);
    eq(j.ralenti, 0, 'le ralentissement finit');
    const x2 = j.x;
    r.bouge(A, j.x + enorme, j.y, 'right', 'run', 0.1);
    ok(Math.abs((j.x - x2) - plafondLibre) < 0.5, 'et le plafond revient a son entier');
  }

  /* ---- LA BRULURE RONGE, ET IGNORE L'ARMURE ----
   * C'est la seule chose du jeu qu'une armure ne bloque pas : la seule raison
   * de reculer quand on est bien protege. */
  {
    const r = new Realm({ alea: alea(502) }); r.monstres = [];
    const j = r.rejoint(A, { ...FR, stats: { ...FR.stats, def: 60 } });
    const t = M.MONSTRES.lave;
    eq(t.tir.effet, 'brulure', 'le golem de magma brule');

    r.tirsM.push({ id: 902, espece: 'lave', x: j.x + 10, y: j.y, a: 0,
                   v: 1, reste: 5, att: t.tir.att, sprite: 'braise', effet: 'brulure' });
    r.pas(0.05);
    ok(j.brulure > 0, 'le tir de magma met le feu');
    const pv0 = j.pv;
    let ticks = 0;
    for (let i = 0; i < Math.ceil(M.EFFETS.brulure.duree / 0.1); i++) {
      const ev = r.pas(0.1);
      ticks += ev.degats.filter((d) => d.quoi === 'brulure').length;
    }
    ok(ticks > 0, `la brulure ronge (${ticks} fois)`);
    const perdu = pv0 - j.pv;
    /* Le total colle a ce que la table annonce, a la regeneration pres. */
    const attendu = M.EFFETS.brulure.duree * M.EFFETS.brulure.parSeconde;
    ok(perdu > attendu * 0.6 && perdu < attendu * 1.2,
       `elle enleve environ ${attendu} points (${perdu} releves)`);
    ok(perdu > 0, 'et une defense de 60 n y change rien : elle ignore l armure');
    for (let i = 0; i < 20; i++) r.pas(0.1);
    eq(j.brulure, 0, 'elle finit par s eteindre');
  }

  /* ---- LES IMMUNITES SONT SEPAREES ----
   * Sortir d'une paralysie ne doit PAS proteger d'une brulure. Sinon un seul
   * monstre suffirait a rendre tous les autres inoffensifs, et le joueur
   * apprendrait a se faire toucher expres. */
  {
    const r = new Realm({ alea: alea(503) }); r.monstres = [];
    const j = r.rejoint(A, FR);
    r.tirsM.push({ id: 903, espece: 'meduse', x: j.x + 10, y: j.y, a: 0, v: 1,
                   reste: 5, att: 10, sprite: 'oeil', effet: 'paralyse' });
    r.pas(0.05);
    ok(j.paralyse > 0, 'paralyse');
    r.tirsM.push({ id: 904, espece: 'lave', x: j.x + 10, y: j.y, a: 0, v: 1,
                   reste: 5, att: 10, sprite: 'braise', effet: 'brulure' });
    r.pas(0.05);
    ok(j.brulure > 0, 'et pourtant la brulure prend : les immunites ne se partagent pas');
  }

  /* ---- AUCUN ETAT NE S'ENCHAINE INDEFINIMENT ----
   *
   * Le pire cas imaginable : un tir du meme genre a CHAQUE pas, comme si dix
   * creatures tiraient sans interruption. On mesure ce que ca donne.
   *
   * La regle n'est PAS la meme pour tous, et c'est deliberé. Les deux etats
   * qui retirent le CONTROLE doivent rester minoritaires dans le temps :
   * au-dela, le joueur ne joue plus, il regarde. La brulure ne prend le
   * controle de rien — elle fait des degats, et des degats, c'est le metier
   * des monstres. Ce qu'on borne pour elle, c'est son cout par seconde.
   *
   * (Ma premiere version passait les trois au meme tamis et le
   * ralentissement echouait a 55 %. Il aurait ete facile de deplacer le
   * seuil ; c'est l'immunite qui a bouge.) */
  ['paralyse', 'ralenti'].forEach((cle) => {
    const r = new Realm({ alea: alea(510) }); r.monstres = [];
    const j = r.rejoint(A, FR);
    j.pv = 1e9; j.pvMax = 1e9;
    let subi = 0, total = 0;
    for (let i = 0; i < 400; i++) {
      r.tirsM.push({ id: 1000 + i, espece: 'meduse', x: j.x + 10, y: j.y, a: 0,
                     v: 1, reste: 5, att: 1, sprite: 'oeil', effet: cle });
      r.pas(0.1);
      total++;
      if (j[cle] > 0) subi++;
    }
    const part = subi / total;
    ok(part < 0.5,
       `« ${cle} » retire le controle moins de la moitie du temps sous un tir ` +
       `permanent (${Math.round(part * 100)} %)`);
    ok(M.EFFETS[cle].immunite > M.EFFETS[cle].duree,
       `« ${cle} » : l immunite dure plus longtemps que l etat`);
  });

  /* La brulure, elle, se mesure en degats. */
  {
    const r = new Realm({ alea: alea(511) }); r.monstres = [];
    const j = r.rejoint(A, { ...FR, stats: { ...FR.stats, hp: 1e9, vit: 0 } });
    j.pv = 1e9; j.pvMax = 1e9;
    const pv0 = j.pv;
    for (let i = 0; i < 400; i++) {
      r.tirsM.push({ id: 2000 + i, espece: 'lave', x: j.x + 10, y: j.y, a: 0,
                     v: 1, reste: 5, att: 0, sprite: 'braise', effet: 'brulure' });
      r.pas(0.1);
    }
    const parSeconde = (pv0 - j.pv) / 40;    // quarante secondes
    ok(parSeconde < M.EFFETS.brulure.parSeconde * 0.75,
       `sous un feu permanent, la brulure coute ${parSeconde.toFixed(1)} PV/s ` +
       `— moins que son plein regime de ${M.EFFETS.brulure.parSeconde}`);
    /* Et surtout : elle ne peut pas tuer un personnage a elle seule plus vite
       qu'il ne fuit. Vingt secondes pour percer une reserve de niveau 1. */
    ok(350 / parSeconde > 20,
       `elle laisse au moins vingt secondes pour reagir (${Math.round(350 / parSeconde)} s)`);
  }

  /* ---- LE SQUELETTE TIRE EN EVENTAIL ----
     Trois os d'un coup : on ne les esquive pas en reculant, seulement en se
     decalant. C'est le seul monstre qui punit la fuite en ligne droite. */
  {
    const t = M.MONSTRES.skeleton;
    eq(t.tir.tirs, 3, 'le squelette lance trois os');
    ok(t.tir.ecart > 0, 'en eventail, pas en file');
    const r = new Realm({ alea: alea(520) });
    const j = r.rejoint(A, FR);
    r.monstres = [{ id: 1, espece: 'skeleton', biome: 'neige',
                    x: j.x + t.tir.portee * 0.6, y: j.y, ancreX: j.x, ancreY: j.y,
                    pv: 1e9, pvMax: 1e9, dir: 'left', cible: null,
                    recharge: 0, rechargeT: 0, stase: 0, errX: 0, errY: 0, errChrono: 0 }];
    r.pas(0.05);
    eq(r.tirsM.length, 3, 'les trois partent ensemble');
    const angles = r.tirsM.map((x) => x.a);
    ok(new Set(angles.map((a) => a.toFixed(3))).size === 3, 'et sur trois angles differents');
  }

  /* ---- L'ETAT PART AVEC LA VUE ---- */
  {
    const r = new Realm({ alea: alea(530) }); r.monstres = [];
    const j = r.rejoint(A, FR);
    const e = r.etatPour(A, 1400);
    eq(e.moi.ral, 0, 'l etat porte le ralentissement');
    eq(e.moi.feu, 0, 'et la brulure');
    j.ralenti = 2; j.brulure = 3;
    const e2 = r.etatPour(A, 1400);
    ok(e2.moi.ral > 0 && e2.moi.feu > 0, 'les deux se voient des qu ils sont poses');
  }
}

console.log('realm.test.js : ' + n + ' verifications OK');
