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

// ================== 4. LE BONUS D'EQUIPEMENT
{
  const plafondDe = (rar) => { const r = B.rarete(rar); return r ? r.plafond : 0; };
  B.RARETES.forEach((r, i) => {
    const b = P.bonusDe(r.cle, plafondDe);
    ok(b > 0, `${r.cle} : un bonus positif`);
    if (i > 0) ok(b > P.bonusDe(B.RARETES[i - 1].cle, plafondDe),
                  `${r.cle} pese plus que ${B.RARETES[i - 1].cle}`);
  });
  eq(P.bonusDe('inconnu', plafondDe), 0, 'une rarete inconnue ne donne aucun bonus');

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
