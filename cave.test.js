'use strict';
/*
 * LA CAVE DES PIRATES — un deuxieme donjon, et surtout une deuxieme FORME.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. UN DONJON DE PLUS EST UNE DONNEE, PAS UNE FOURCHE. Si ajouter la cave a
 *    demande un `if (nom === 'cave')` quelque part, le troisieme donjon en
 *    demandera un deuxieme, et le cinquieme rendra le fichier illisible. Cet
 *    essai verifie que les DEUX donjons sortent du meme chemin de code.
 * 2. ON PEUT TOUJOURS ALLER DU DEPART AU BOSS. Une grotte tiree au sort peut
 *    produire une salle detachee du reste : un joueur enferme dans un donjon
 *    dont il ne peut pas atteindre le fond n'a aucun moyen de le savoir, et
 *    il tournera jusqu'a mourir ou abandonner.
 * 3. LE FOND EST LOIN DU DEPART. Sinon le donjon est un couloir de deux
 *    salles et la carte ne veut rien dire.
 * 4. ELLE EST PLUS FACILE QUE LA FONDERIE, ET ELLE RAPPORTE MOINS. C'est un
 *    PREMIER donjon. S'il rendait du mythique, il n'y aurait plus de raison
 *    d'aller plus loin — et le reste du jeu deviendrait decoratif.
 * 5. SES PIRATES NE VIVENT QUE LA. Une creature de donjon qui nait dans le
 *    monde ouvert enleve au donjon la seule chose qu'il a : etre un endroit.
 */
const assert = require('assert');
const M = require('./monde');
const { Realm } = require('./realm');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; console.log('  ok   ' + m); };
function alea(g) { let s = g >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const GRAINES = [1, 2, 3, 5, 8, 13, 21, 34];

// ================== 1. LA TABLE, ET RIEN QUE LA TABLE
console.log('\n-- deux donjons, une seule table --');
{
  ok(M.DONJONS.forge && M.DONJONS.cave, 'les deux donjons sont dans la table');
  /* PORTAIL_DE et RETOUR_DE sont DERIVES d'elle. Recopies a cote, l'un des
     deux aurait fini par oublier la cave — et une cave sans ouvreur ne
     s'ouvre jamais, sans qu'aucune erreur ne le dise. */
  for (const k of Object.keys(M.DONJONS)) {
    const D = M.DONJONS[k];
    eq(M.PORTAIL_DE[D.ouvreur], k, `${D.ouvreur} ouvre bien « ${k} »`);
    ok(M.RETOUR_DE[D.boss], `et ${D.boss} y ouvre la porte du retour`);
    ok(M.BOSS[D.boss], `${D.boss} compte comme un boss`);
    ok(M.MONSTRES[D.ouvreur], `son ouvreur est une vraie creature`);
    for (const e of D.especes) ok(M.MONSTRES[e], `${e} existe`);
  }
}

// ================== 2. SES PIRATES NE VIVENT QUE LA
console.log('\n-- des creatures qu on ne croise nulle part ailleurs --');
{
  const sauvages = new Set();
  for (const b of Object.keys(M.PEUPLEMENT)) {
    for (const e of M.PEUPLEMENT[b].especes) sauvages.add(e);
  }
  for (const e of M.DONJONS.cave.especes.concat([M.DONJONS.cave.boss])) {
    eq(sauvages.has(e), false, `${e} ne nait PAS dans le monde ouvert`);
  }
}

// ================== 3. LA FORME : UN RESEAU, PAS UN COULOIR
console.log('\n-- la forme de la grotte --');
{
  for (const g of GRAINES.slice(0, 4)) {
    const p = M.planCave(alea(g));
    ok(p.salles.length >= 8, `graine ${g} : ${p.salles.length} salles`);
    const e = p.salles.find((s) => s.role === 'entree');
    const f = p.salles.find((s) => s.role === 'fond');
    ok(e && f, 'une entree et un fond');
    ok(f.rayon > e.rayon, `le fond est plus grand que l entree (${f.rayon} > ${e.rayon})`);
    const d = Math.hypot(f.c - e.c, f.l - e.l);
    ok(d > 20, `et il en est LOIN (${Math.round(d)} tuiles)`);
    /* Des salles qui se touchent ne font plus des salles. */
    let colles = 0;
    for (let i = 0; i < p.salles.length; i++) {
      for (let j = i + 1; j < p.salles.length; j++) {
        const a = p.salles[i], b = p.salles[j];
        if (Math.hypot(a.c - b.c, a.l - b.l) <= a.rayon + b.rayon) colles++;
      }
    }
    eq(colles, 0, 'et aucune paire de salles ne se chevauche');
    /* Tout est dans le positif : le plan pousse dans les quatre sens depuis
       zero, il faut donc l'avoir ramene. */
    ok(p.salles.every((s) => s.c - s.rayon >= 0 && s.l - s.rayon >= 0),
       'le plan entier est en coordonnees positives');
  }
}

// ================== 4. ON PEUT ALLER DU DEPART AU BOSS
console.log('\n-- on atteint toujours le fond --');
{
  /* Un remplissage par proche-en-proche sur le SOL. C'est la seule preuve qui
     vaille : « je les ai reliees en les posant » decrit l'intention, pas le
     resultat — un passage peut tres bien avoir ete creuse a cote. */
  for (const g of GRAINES) {
    const p = M.planCave(alea(g));
    const e = p.salles.find((s) => s.role === 'entree');
    const f = p.salles.find((s) => s.role === 'fond');
    const vu = new Set([e.c + ',' + e.l]);
    const pile = [[e.c, e.l]];
    while (pile.length) {
      const [c, l] = pile.pop();
      for (const [dc, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = (c + dc) + ',' + (l + dl);
        if (!p.sol.has(k) || vu.has(k)) continue;
        vu.add(k); pile.push([c + dc, l + dl]);
      }
    }
    ok(vu.has(f.c + ',' + f.l),
       `graine ${g} : le fond est atteignable a pied depuis l entree`);
    /* Et TOUT le sol est d'un seul tenant : une poche isolee serait des
       creatures qu'on ne peut pas atteindre, donc un donjon qu'on ne peut
       pas finir. */
    eq(vu.size, p.sol.size,
       `et aucune poche detachee (${vu.size} sur ${p.sol.size} tuiles)`);
  }
}

// ================== 5. LES DEUX DONJONS SORTENT DU MEME CHEMIN
console.log('\n-- le meme code pour les deux --');
{
  for (const nom of ['forge', 'cave']) {
    const p = M.planDeDonjon(nom, alea(4));
    eq(p.nom, nom, `planDeDonjon rend « ${nom} »`);
    ok(p.entree && Number.isFinite(p.entree.x), 'avec une entree');
    ok(p.sortie && Number.isFinite(p.sortie.x), 'et une sortie');
    ok(p.obstacles.length > 50, `des murs (${p.obstacles.length})`);
    ok(p.tuiles.length > 100, `un sol (${p.tuiles.length} tuiles)`);
    ok(Number.isFinite(p.anneaux[0].jusqua),
       'et une borne d anneau FINIE : Infinity ne traverse pas JSON');
    const boss = p.peuplement.filter((m) => m.boss);
    eq(boss.length, 1, 'un seul boss');
    eq(boss[0].espece, M.DONJONS[nom].boss, `et c est ${M.DONJONS[nom].boss}`);
  }
  /* Un nom inconnu retombe sur la Fonderie plutot que de fabriquer un donjon
     vide : un plan sans sol enfermerait le joueur dans le noir. */
  eq(M.planDeDonjon('nawak', alea(1)).nom, 'forge',
     'un donjon inconnu retombe sur la Fonderie');
}

// ================== 6. PLUS FACILE, ET MOINS PAYANTE
console.log('\n-- un PREMIER donjon --');
{
  const cave = M.DONJONS.cave, forge = M.DONJONS.forge;
  const bc = M.MONSTRES[cave.boss], bf = M.MONSTRES[forge.boss];
  ok(bc.pv < bf.pv, `son boss tient moins (${bc.pv} contre ${bf.pv})`);
  ok(bc.att < bf.att, `et frappe moins fort (${bc.att} contre ${bf.att})`);
  for (const e of cave.especes) {
    ok(M.MONSTRES[e].pv < Math.min(...forge.especes.map((x) => M.MONSTRES[x].pv)),
       `${e} tient moins que la moindre machine de la Fonderie`);
  }
  /* ---- ET ELLE RAPPORTE MOINS ----
   * C'est le point qui empeche le premier donjon de rendre le reste du jeu
   * decoratif. Le mot « donjon » ne vaut rien en soi : c'est ce qu'on a du
   * abattre pour y entrer qui fixe le prix. */
  const rangs = M.RARETES ? null : null;
  eq(M.RARETE_ANNEAU.cave, 'rare', 'ses pirates rendent du rare');
  eq(M.RARETE_ANNEAU.donjon, 'mythique', 'la Fonderie, du mythique');
  eq(M.BUTIN_GARANTI.dreadstump, 'epique', 'son fond garantit de l epique');
  eq(M.BUTIN_GARANTI.fonderie, 'relique', 'celui de la Fonderie, une relique');

  /* ---- LA TABLE NE SUFFIT PAS : C'EST L'ETIQUETTE QUI EST LUE ----
   * Les quatre lignes du dessus etaient vertes pendant que les pirates
   * rendaient du mythique : `butinDe` lit RARETE_ANNEAU[m.biome], et chaque
   * creature de donjon naissait avec `biome: 'donjon'`. `cave: 'rare'` n'etait
   * lu par personne. Mesure du 12/10/2026 avant correction, avec Math.random
   * comme le Realm (500 plans, 2.10^6 morts) : 0,726 % de mythique par pirate
   * abattu, 54,6 pirates par cave, 0,40 mythique par cave videe — contre 4
   * mythiques a 10 exemplaires dans tout le monde ouvert, et un lot que le
   * rachat recycle (RACHAT_RECYCLE) remplissait a mesure : environ 19 800
   * $SWOGE de rachat ouvert par cave, verrou de volume mis a part. Ce
   * fichier tire avec un generateur fixe (`alea`) pour etre reproductible :
   * ses propres comptes different de ceux-la de quelques pour cent.
   * On mesure donc sur les creatures que le PLAN fait naitre, par le vrai
   * tirage, et plus sur la table. */
  const tirePar = (cle) => {
    const compte = {}; let morts = 0;
    for (const g of GRAINES) {
      const a = alea(g * 7 + 1);
      for (const m of M.planDeDonjon(cle, alea(g)).peuplement) {
        if (m.boss) continue;
        for (let k = 0; k < 2500; k++) {
          const b = M.butinDe(m.espece, a, m.biome);
          morts++;
          const o = b && b.contenu[0] && b.contenu[0].objet;
          if (o) compte[o] = (compte[o] || 0) + 1;
        }
      }
    }
    return { compte, morts };
  };
  const tc = tirePar('cave');
  eq(tc.compte.mythique || 0, 0,
     `aucun mythique sur ${tc.morts} pirates abattus (rare : ${tc.compte.rare || 0})`);
  ok((tc.compte.rare || 0) > 0 && Object.keys(tc.compte).every((k) => k === 'rare'),
     `ils rendent du rare, et seulement du rare (${JSON.stringify(tc.compte)})`);
  const tf = tirePar('forge');
  ok((tf.compte.mythique || 0) > 0,
     `et les machines de la Fonderie gardent leur mythique (${tf.compte.mythique || 0} sur ${tf.morts})`);

  /* ---- CHAQUE DONJON PORTE UNE ETIQUETTE QUI SE LIT ----
   * L'etiquette est maintenant le sol du donjon, pour les QUATRE : le
   * Sanctuaire et l'Arene portent 'sanctuaire' et 'arena', absents de
   * RARETE_ANNEAU. Sans effet le 12/10 — ils n'ont aucune espece ordinaire,
   * leurs invocations sont sansButin et leur boss tire dans BUTIN_GARANTI. Le
   * jour ou l'on y ajoute des creatures, `butinDe` lirait une rarete
   * `undefined` et elles ne lacheraient plus rien, sans un mot. On l'affirme
   * donc pour chaque porte, et on le mesure sur le plan : chaque creature
   * ordinaire nee dans un donjon a une rarete a tirer. */
  for (const [cle, D] of Object.entries(M.DONJONS)) {
    const sol = D.sol || 'donjon';
    const ordinaires = M.planDeDonjon(cle, alea(3)).peuplement.filter((m) => !m.boss);
    ok(!!M.RARETE_ANNEAU[sol] || ((D.especes || []).length === 0 && ordinaires.length === 0),
       `${cle} : son sol « ${sol} » a une rarete (${M.RARETE_ANNEAU[sol] || 'aucune'}), ` +
       `ou il ne fait naitre aucune creature ordinaire (${ordinaires.length})`);
    ok(ordinaires.every((m) => m.biome === sol),
       `${cle} : ses creatures portent le sol du donjon (${[...new Set(ordinaires.map((m) => m.biome))].join(', ') || 'aucune'})`);
  }
}

// ================== 7. ELLE TOURNE VRAIMENT
console.log('\n-- la simulation tourne --');
{
  const R = new Realm({ alea: alea(9), plan: M.planDeDonjon('cave', alea(9)),
                        tireObjet: () => ({ item: 1, cle: 'x', nom: 'X', rarete: 'epique' }) });
  ok(R.monstres.length > 20, `la cave est peuplee (${R.monstres.length} creatures)`);
  ok(R.monstres.some((m) => m.espece === 'dreadstump'), 'Dreadstump est dedans');
  /* La porte du sas existe des le premier pas : un donjon dont la sortie se
     meriterait enfermerait un joueur qui a mal juge sa vie. */
  ok(R.portails.some((p) => p.retour && !Number.isFinite(p.reste)),
     'et la porte de sortie est la, sans compte a rebours');
  /* Aucune creature dans un mur : elle y resterait pour toujours, immobile,
     et se lirait comme un monstre casse plutot que coince. */
  const dansLeMur = R.monstres.filter(
    (m) => M.bloque(R.obstacles, m.x, m.y, M.MONSTRES[m.espece].rayon * 0.5));
  eq(dansLeMur.length, 0, 'et aucune n est nee dans la pierre');
  for (let i = 0; i < 40; i++) R.pas(0.1);
  eq(R.repeuple(900), 0, 'un donjon ne se repeuple pas : il se VIDE');
}

console.log(`\ncave.test.js — ${n} verifications, 0 echec(s)`);
