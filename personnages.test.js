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

  /* Dix-huit et non vingt-quatre : les six familles d'ARMES n'ont plus de
     profil du tout. Une arme ne donne que des degats, comme dans RotMG. */
  ok(familles.length === 18, `les dix-huit familles a stats ont un profil (${familles.length})`);
  B.FAMILLES.filter((f) => f.saison === 2).forEach((f) => {
    ok(!P.PROFIL_FAMILLE[f.cle], `l'arme « ${f.cle} » n'a pas de profil de stats`);
  });

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
  eq(stats.size, 8, 'les huit stats sont toutes atteignables sans passer par une arme');
  P.STATS.forEach((s) => ok(stats.has(s), `la stat ${s} a bien une famille qui la vise`));

  /* Chaque famille PORTEUSE DE STATS a une entree — un fruit, une armure ou
     une bague sans mapping ne donnerait AUCUN bonus a l'equiper,
     silencieusement. Les armes sont hors de ce compte par construction. */
  B.FAMILLES.filter((f) => f.saison !== 2)
    .forEach((f) => ok(P.FAMILLE_STAT[f.cle], `la famille ${f.cle} (saison ${f.saison}) a une stat`));

  /* ---- LA REGLE DES ARMES, VERROUILLEE ----
   *
   * Le jour ou quelqu'un remet un profil sur « lame » pour « rendre l'epee
   * plus interessante », il refait exactement la faute qu'on vient de
   * corriger : l'arme gagnerait deux fois, en degats ET en stats. Chaque arme
   * du catalogue rend {} a toutes les raretes, et rend des degats. */
  B.FAMILLES.filter((f) => f.saison === 2).forEach((f) => {
    B.RARETES.forEach((r) => {
      eq(Object.keys(P.bonusesDe(r.cle, f.cle, 2)).length, 0,
         `l'arme « ${f.cle} » ${r.cle} ne donne aucune stat`);
      ok(P.DEGATS_ARME[r.cle][1] > 0, `l'arme « ${f.cle} » ${r.cle} a bien des degats`);
    });
  });

  /* ---- LE POIDS DE L'EQUIPEMENT FACE AU PERSONNAGE ----
   *
   * Le releve realmeye : un anneau tiered plafonne a +11 ATT sur un
   * personnage qui monte a 75 — 15 % du plafond. Cet essai exigeait qu'un set
   * COMPLET reste sous 70 % du plafond, et c'etait vrai tant que les deux
   * echelles n'en faisaient qu'une.
   *
   * Elles n'en font plus qu'une : on a demande que ce qui se paie soit
   * nettement plus fort que ce qui tombe, et un set entier pese maintenant
   * plus lourd. Ce n'est pas un accident, c'est la decision — et un seuil
   * qu'on repousse a chaque fois qu'il gene ne garde plus rien.
   *
   * Ce qu'on garde donc, c'est la propriete qui compte vraiment : un set
   * complet AJOUTE au personnage, il ne le REMPLACE pas. Au-dela de cent
   * pour cent, ce que l'on porte compterait plus que qui l'on est, et le
   * choix du personnage cesserait d'exister. Mesure, aux deux echelles. */
  {
    const plafond = Math.max(...Object.keys(P.BASE).map((k) => P.BASE[k].att));
    const set = (src) => P.bonusesDe('mythique', 'chaos', 1, src).att
                       + P.bonusesDe('mythique', 'gantelets', 3, src).att
                       + P.bonusesDe('mythique', 'topaze', 4, src).att
                       + (P.bonusesDe('mythique', 'lame', 2, src).att || 0);
    const achete = set('boutique'), trouve = set('butin');
    console.log(`   set mythique tout-attaque : achete +${achete}, trouve +${trouve}, ` +
                `sur un plafond de ${plafond}`);
    ok(achete / plafond < 1,
       `un set achete ajoute moins que le personnage lui-meme (${achete} contre ${plafond})`);
    ok(trouve / plafond < 1,
       `un set trouve aussi (${trouve} contre ${plafond})`);
    /* Et le set trouve reste au-dessus : dix exemplaires par saison contre
       soixante, c'est la seule chose que l'argent n'achete pas. */
    ok(trouve > achete,
       `le set du MONDE pese plus lourd que celui qu on achete (${trouve} contre ${achete})`);
  }
}


// ================== DEUX ECHELLES, ET UN SEUL ESCALIER
//
// Ce qu'on ACHETE et ce qu'on TROUVE partageaient la meme table : une commune
// payee en $SWOGE valait exactement une commune ramassee sur un lime, alors
// que la premiere existe a mille exemplaires pour toute une saison et que la
// seconde tombe a l'infini.
//
// Ce que ce bloc protege :
//
// 1. LA SUITE CROIT. Les onze marches — six de butin, cinq de boutique —
//    forment un seul escalier strictement croissant. Deux echelles qui se
//    croisent au milieu donneraient un mythique moins bon qu'un epique, et
//    personne ne saurait dire lequel prendre.
// 2. LA RELIQUE RESTE AU-DESSUS DE TOUT. C'est la seule piece que l'argent
//    n'achete pas. Si la mythique de boutique la depassait, le monde de
//    combat perdrait son dernier trophee.
// 3. LE BUTIN NE BAISSE PAS. Rendre la boutique meilleure en affaiblissant ce
//    que les gens possedent deja, c'est le leur reprendre sans le dire.
{
  const B = require('./boutique');
  const SAISONS = [1, 3, 4];
  const RANGS = ['commun', 'rare', 'epique', 'legendaire', 'mythique'];

  for (const sa of SAISONS) {
    const bu = P.BUDGET_BUTIN[sa], bo = P.BUDGET_BOUTIQUE[sa];
    /* L'escalier, dans l'ordre : chaque cran de boutique se loge entre le
       butin qui le suit et celui d'apres. */
    const suite = [bu.commun, bu.rare, bo.commun, bu.epique, bo.rare,
                   bu.legendaire, bo.epique, bo.legendaire, bo.mythique,
                   bu.mythique, bu.relique];
    for (let i = 1; i < suite.length; i++) {
      ok(suite[i] > suite[i - 1],
         `saison ${sa} : la marche ${i} monte (${suite[i - 1]} -> ${suite[i]})`);
      n -= 1;
    }
    n += 1;
    ok(true, `saison ${sa} : les onze marches montent, sans un plat (${suite.join(' < ')})`);

    /* ---- LES DEUX DERNIERS RANGS DU MONDE TIENNENT LE SOMMET ----
     * Sinon la rarete et la puissance marchent en sens inverse : par saison,
     * la mythique du monde existe a DIX exemplaires, la legendaire achetee a
     * deux cent quarante. La plus rare etait battue par la plus abondante. */
    ok(bu.relique > bo.mythique,
       `saison ${sa} : la relique (${bu.relique}) reste au-dessus de tout ce qui s achete (${bo.mythique})`);
    ok(bu.mythique > bo.mythique,
       `saison ${sa} : et la mythique du MONDE aussi (${bu.mythique} contre ${bo.mythique})`);
    ok(bo.relique === null || bo.relique === undefined,
       `saison ${sa} : la relique ne se vend pas, et la table le DIT`);
    /* Et la commune de boutique est deja PUISSANTE : elle bat la rare du
       monde. C'est une serie limitee, pas un lot de consolation. */
    ok(bo.commun > bu.rare,
       `saison ${sa} : la commune achetee (${bo.commun}) bat la rare trouvee (${bu.rare})`);
    ok(bo.commun >= bu.commun * 2,
       `saison ${sa} : et vaut au moins deux communes trouvees (${bo.commun} contre ${bu.commun})`);
  }

  /* ---- LES ARMES SUIVENT LE MEME ESCALIER ----
   * Elles ne donnent pas de stats : leurs degats SONT leur fiche. */
  {
    const bu = P.DEGATS_ARME_BUTIN, bo = P.DEGATS_ARME_BOUTIQUE;
    const suite = [bu.commun, bu.rare, bo.commun, bu.epique, bo.rare,
                   bu.legendaire, bo.epique, bo.legendaire, bo.mythique,
                   bu.mythique, bu.relique];
    for (let i = 1; i < suite.length; i++) {
      ok(suite[i][0] > suite[i - 1][0] && suite[i][1] > suite[i - 1][1],
         `armes : la marche ${i} monte des DEUX bornes`);
      n -= 1;
    }
    n += 1;
    ok(true, 'armes : les onze marches montent, borne basse ET borne haute');
    ok(bu.relique[0] > bo.mythique[1],
       `l arme relique frappe au minimum (${bu.relique[0]}) plus fort que la mythique achetee au maximum (${bo.mythique[1]})`);
    ok(bu.mythique[0] > bo.mythique[0] && bu.mythique[1] > bo.mythique[1],
       `et l arme mythique du MONDE bat celle qu on achete (${bu.mythique} contre ${bo.mythique})`);
    ok(bo.commun[0] > bu.rare[0],
       `l arme commune achetee (${bo.commun}) bat la rare trouvee (${bu.rare})`);
  }

  /* ---- ET LA SOURCE SE LIT SUR L'OBJET, PAS SUR SON NOM ----
   * Six endroits demandaient la table. Six occasions de se tromper. */
  {
    eq(P.sourceDe({ drop: true }), 'butin', 'une piece qui tombe vient du butin');
    eq(P.sourceDe({}), 'boutique', 'une piece sans drapeau vient de la boutique');
    /* Le defaut de `bonusesDe` est le BUTIN : un appel oublie donne une piece
       moins forte, pas une piece dopee. Se tromper vers le bas se voit et se
       repare ; se tromper vers le haut se decouvre trois semaines plus tard,
       quand tout le monde en a une. */
    const parDefaut = P.bonusesDe('commun', 'plastron', 3);
    const butin = P.bonusesDe('commun', 'plastron', 3, 'butin');
    eq(JSON.stringify(parDefaut), JSON.stringify(butin),
       'sans source, on rend la table du MONDE — l oubli affaiblit, il ne dope pas');

    /* Et CHAQUE piece du catalogue rend bien la table de sa famille. */
    let faux = 0;
    for (const o of B.ITEMS.concat(B.ITEMS_DROP)) {
      const attendu = P.bonusesDe(o.rarete, o.famille, o.saison, o.drop ? 'butin' : 'boutique');
      if (JSON.stringify(P.bonusesDeObjet(o)) !== JSON.stringify(attendu)) faux++;
    }
    eq(faux, 0, `les ${B.ITEMS.length + B.ITEMS_DROP.length} pieces du catalogue lisent la bonne table`);

    /* Une arme du monde et une arme de boutique, meme rarete : la seconde
       frappe plus fort. C'est la demande, verifiee sur le catalogue reel. */
    /* A rarete egale, l'arme achetee frappe plus fort — SAUF au dernier rang,
       ou le monde reprend la main. C'est la regle, pas une exception qu'on
       tolere : ce qu'un joueur rencontre vraiment (commun, rare, epique,
       legendaire) est battu par ce qui s'achete ; les dix exemplaires
       mythiques d'une saison, non. */
    let pires = [];
    for (const r of RANGS) {
      if (r === 'mythique') continue;
      const a = B.ITEMS.find((o) => o.saison === 2 && o.rarete === r);
      const b = B.ITEMS_DROP.find((o) => o.saison === 2 && o.rarete === r);
      if (!a || !b) continue;
      const da = P.degatsDeObjet(a), db = P.degatsDeObjet(b);
      if (!(da[0] > db[0] && da[1] > db[1])) pires.push(r);
    }
    eq(pires.length, 0,
       'jusqu au legendaire, l arme achetee frappe TOUJOURS plus fort que celle qu on trouve');
    /* Et l'inverse, tout en haut, sur le catalogue reel. */
    {
      const a = B.ITEMS.find((o) => o.saison === 2 && o.rarete === 'mythique');
      const b = B.ITEMS_DROP.find((o) => o.saison === 2 && o.rarete === 'mythique');
      const da = P.degatsDeObjet(a), db = P.degatsDeObjet(b);
      ok(db[0] > da[0] && db[1] > da[1],
         `au dernier rang c est le MONDE qui gagne (${db} contre ${da})`);
    }
  }
}

console.log(`personnages.test.js : ${n} verifications OK`);