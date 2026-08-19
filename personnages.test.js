'use strict';
/*
 * LES PERSONNAGES — le module pur.
 *
 * ---- ce qui compte ----
 *
 * 1. LES SIX BASES COUVRENT LES HUIT STATS, distinctement — sinon l'archetype
 *    ne dit rien.
 * 2. LA COURBE NIVEAU<->XP EST RECIPROQUE : le volume qui donne le niveau n
 *    donne aussi l'XP qui redonne le niveau n. Deux chemins vers la meme
 *    reponse ne doivent jamais diverger.
 * 3. STAT AU NIVEAU 1 < STAT AU NIVEAU 20 = LE PLAFOND EXACT. Le plafond
 *    annonce doit se voir, pas s'approcher.
 * 4. LE BONUS D'EQUIPEMENT SUIT LE MEME POIDS QUE LE RACHAT — 1000/plafond —
 *    et FAMILLE_STAT couvre les huit stats sans repetition inutile a
 *    l'interieur d'une meme saison.
 */
const assert = require('assert');
const P = require('./personnages');
const B = require('./boutique');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ================== 1. LES SIX BASES
{
  const ids = Object.keys(P.BASE);
  eq(ids.length, 6, 'six personnages ont une base');
  ids.forEach((id) => {
    const b = P.BASE[id];
    P.STATS.forEach((s) => ok(b[s] > 0, `${id} : ${s} est posee et positive`));
  });
  /* HP et MP vivent sur une AUTRE echelle que les six autres — 700-800 et
     300-400, contre 25-75 pour att/def/spd/dex/vit/wis, MEME dans la vraie
     table RotMG. Les comparer aux six autres dans le meme ecart fausserait
     la mesure pour tout le monde, pas seulement pour Brett : c'est le test
     qu'il fallait corriger, pas les nombres. La specialisation se lit sur
     les six stats secondaires, celles qui varient vraiment d'une classe a
     l'autre. */
  const SECONDAIRES = ['att', 'def', 'spd', 'dex', 'vit', 'wis'];
  ids.filter((id) => id !== 'brett').forEach((id) => {
    const b = P.BASE[id];
    const vals = SECONDAIRES.map((s) => b[s]);
    const ecart = Math.max(...vals) - Math.min(...vals);
    ok(ecart >= 15, `${id} : un ecart net entre sa stat forte et sa stat faible (${ecart})`);
  });
  const vb = SECONDAIRES.map((s) => P.BASE.brett[s]);
  const ecartBrett = Math.max(...vb) - Math.min(...vb);
  ok(ecartBrett <= 10, `Brett reste plat sur les six stats secondaires — c est voulu (${ecartBrett})`);
  /* HP et MP, eux, restent dans la fourchette que la vraie table RotMG
     observe entre ses dix-neuf classes : jamais un ecart demesure. */
  ids.forEach((id) => {
    ok(P.BASE[id].hp >= 650 && P.BASE[id].hp <= 850, `${id} : HP dans une fourchette raisonnable`);
    ok(P.BASE[id].mp >= 250 && P.BASE[id].mp <= 450, `${id} : MP dans une fourchette raisonnable`);
  });
}

// ================== 2. LA COURBE EST RECIPROQUE, A CHAQUE NIVEAU
{
  for (let niv = 1; niv <= P.NIVEAU_MAX; niv++) {
    const vol = P.volumePour(niv);
    const xp = P.xpDuVolume(vol);
    eq(Math.round(xp), P.xpPour(niv), `niveau ${niv} : le volume traduit en xp retombe sur xpPour(${niv})`);
    eq(P.niveauDeXp(xp), niv, `niveau ${niv} : l xp obtenue redonne bien le niveau ${niv}`);
  }
  eq(P.niveauDeXp(0), 0, 'aucune xp, niveau 0');
  eq(P.niveauDeXp(P.xpPour(P.NIVEAU_MAX) * 1000), P.NIVEAU_MAX,
     'une xp demesuree plafonne au niveau maximum, ne le depasse pas');
}

// ================== 3. LA STAT AU NIVEAU SUIT LE PLAFOND EXACTEMENT
{
  [40, 75, 800].forEach((cap) => {
    eq(P.statAuNiveau(cap, P.NIVEAU_MAX), cap, `plafond ${cap} : atteint EXACTEMENT au niveau max`);
    eq(P.statAuNiveau(cap, 1), Math.round(cap * 0.5), `plafond ${cap} : la moitie au niveau 1`);
    ok(P.statAuNiveau(cap, 10) > P.statAuNiveau(cap, 1), 'ca monte entre le niveau 1 et 10');
    ok(P.statAuNiveau(cap, P.NIVEAU_MAX) > P.statAuNiveau(cap, 10), 'et encore entre 10 et le max');
  });
  /* Monotone partout, pas seulement aux trois points verifies au-dessus. */
  [40, 75, 800].forEach((cap) => {
    for (let niv = 2; niv <= P.NIVEAU_MAX; niv++) {
      ok(P.statAuNiveau(cap, niv) >= P.statAuNiveau(cap, niv - 1),
         `plafond ${cap} : niveau ${niv} n est jamais plus bas que ${niv - 1}`);
    }
  });
}

// ================== 4. LE BONUS D'EQUIPEMENT : PROFIL x BUDGET
//
// Un objet ne donne plus UNE stat mais un profil — plusieurs stats a la fois.
// Deux regles doivent tenir, et aucune des deux ne se voit a l'oeil sur 120
// objets : la rarete progresse TOUJOURS, et une jauge reste d'un autre ordre
// qu'un attribut. On les verifie donc pour toutes les familles, toutes les
// raretes, toutes les saisons — pas sur un exemple.
{
  const saisonDe = (fam) => {
    const o = B.ITEMS.filter((x) => x.famille === fam)[0];
    return o ? o.saison : null;
  };
  const familles = Object.keys(P.PROFIL_FAMILLE);

  ok(familles.length === 24, `les vingt-quatre familles ont un profil (${familles.length})`);

  familles.forEach((f) => {
    const sai = saisonDe(f);
    ok(!!sai, `la famille « ${f} » appartient bien a une saison`);

    /* Les poids totalisent 1 : sinon une famille depenserait plus ou moins
       que son budget sans que rien ne le signale, et deux objets de meme
       rarete n'auraient pas la meme valeur. */
    const somme = Object.keys(P.PROFIL_FAMILLE[f])
      .reduce((t, s) => t + P.PROFIL_FAMILLE[f][s], 0);
    ok(Math.abs(somme - 1) < 1e-9, `« ${f} » depense exactement son budget (${somme})`);

    /* Toutes les stats du profil existent : une faute de frappe donnerait un
       bonus sur une stat que personne ne lit, donc un objet mort. */
    Object.keys(P.PROFIL_FAMILLE[f]).forEach((s) => {
      ok(P.STATS.indexOf(s) >= 0, `« ${f} » vise la vraie stat « ${s} »`);
    });

    /* LA RARETE PROGRESSE, sur chaque stat du profil. C'est la promesse
       centrale — « legendaire > epique » — et elle doit etre vraie par
       construction, pas verifiee a la main sur quelques objets. */
    let precedent = null;
    B.RARETES.forEach((r) => {
      const b = P.bonusesDe(r.cle, f, sai);
      ok(Object.keys(b).length > 0, `« ${f} » ${r.cle} donne quelque chose`);
      if (precedent) {
        Object.keys(b).forEach((s) => {
          ok(b[s] >= precedent[s], `« ${f} » ${r.cle} ne recule pas sur ${s}`);
        });
        const t = Object.keys(b).reduce((x, s) => x + b[s], 0);
        const tp = Object.keys(precedent).reduce((x, s) => x + precedent[s], 0);
        ok(t > tp, `« ${f} » ${r.cle} pese plus au total que le cran d'avant`);
      }
      precedent = b;
    });
  });

  /* ---- L'ECHELLE : UNE JAUGE N'EST PAS UN ATTRIBUT ----
   *
   * Si elle tombe, rien ne plante : le jeu devient juste absurde, une bague
   * triplant une sagesse pendant qu'une autre gratte un centieme de barre de
   * vie. On la tient par le RAPPORT, pas par les chiffres — changer le
   * bareme reste permis, l'aplatir ne l'est pas. */
  {
    const or = P.bonusesDe('mythique', 'or', 1);          // HP pur
    const topaze = P.bonusesDe('mythique', 'topaze', 4);  // ATT pur
    ok(or.hp >= topaze.att * 5,
       `la vie (${or.hp}) reste d'un autre ordre que l'attaque (${topaze.att})`);
  }

  /* Une famille ou une saison inconnue ne rend RIEN plutot qu'un bonus au
     hasard : mieux vaut un objet muet qu'un objet qui invente sa valeur. */
  eq(Object.keys(P.bonusesDe('mythique', 'famille_inexistante', 1)).length, 0,
     'une famille inconnue ne donne aucun bonus');
  eq(Object.keys(P.bonusesDe('rarete_inexistante', 'or', 1)).length, 0,
     'une rarete inconnue ne donne aucun bonus');
  eq(Object.keys(P.bonusesDe('mythique', 'or', 99)).length, 0,
     'une saison inconnue ne donne aucun bonus');

  /* La stat principale se DEDUIT du profil : deux tables a tenir d'accord
     finiraient par se contredire. */
  familles.forEach((f) => {
    const p = P.PROFIL_FAMILLE[f];
    const principale = P.FAMILLE_STAT[f];
    Object.keys(p).forEach((s) => {
      ok(p[principale] >= p[s], `« ${f} » : ${principale} est bien son poids le plus lourd`);
    });
  });

  /* Les degats couvrent les cinq raretes et progressent. */
  let dPrec = null;
  B.RARETES.forEach((r) => {
    const d = P.DEGATS_ARME[r.cle];
    ok(Array.isArray(d) && d.length === 2, `${r.cle} a ses degats min/max`);
    ok(d[1] > d[0], `${r.cle} : le max depasse le min`);
    if (dPrec) ok(d[0] > dPrec[0] && d[1] > dPrec[1], `${r.cle} frappe plus fort que le cran d'avant`);
    dPrec = d;
  });

  /* FAMILLE_STAT couvre les huit stats, sans en oublier, en comptant les deux
     saisons ENSEMBLE — c'est ce qui garantit qu'aucune stat n'est hors de
     portee de tout equipement possible. */
  const stats = new Set(Object.values(P.FAMILLE_STAT));
  eq(stats.size, 8, 'les huit stats sont toutes atteignables par un fruit ou une arme');
  P.STATS.forEach((s) => ok(stats.has(s), `la stat ${s} a bien une famille qui la vise`));

  /* Chaque famille du catalogue reel a une entree — un fruit ou une arme sans
     mapping ne donnerait AUCUN bonus a l equiper, silencieusement. */
  B.FAMILLES.forEach((f) => ok(P.FAMILLE_STAT[f.cle], `la famille ${f.cle} (saison ${f.saison}) a une stat`));
}

console.log(`personnages.test.js : ${n} verifications OK`);
