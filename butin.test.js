'use strict';
/*
 * LE BUTIN — les sacs au sol, et ce qu'on en tire.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. UN SEUL CHEMIN TIRE LE BUTIN. Un monstre peut mourir d'une fleche ou
 *    d'un eclair. Les deux chemins recopiaient deja le gain d'experience ; y
 *    ajouter un tirage de butin aurait fait deux taux a maintenir, et le jour
 *    ou l'un change l'autre paie encore l'ancien — sans que rien ne casse,
 *    donc sans que personne ne s'en apercoive.
 * 2. LE SAC NAIT AVEC SA MINUTE ENTIERE. Meme lecon que la tombe : « il dure
 *    soixante secondes » doit etre vrai, pas presque vrai.
 * 3. ON NE RAMASSE QU'A PORTEE, ET C'EST LE SERVEUR QUI LE DIT. Les sacs sont
 *    exactement ce qu'on aurait interet a voler depuis l'autre bout de la
 *    carte.
 * 4. UN REFUS LAISSE LE SAC AU SOL. Une potion bue a 20/20 serait perdue pour
 *    rien.
 * 5. LA POTION MONTE AU-DESSUS DU PLAFOND, ET MEURT AVEC LE PERSONNAGE.
 *    C'est le seul gain qu'aucun coffre ne peut mettre a l'abri, et c'est
 *    toute sa valeur.
 * 6. LES HUIT POTIONS VALENT A PEU PRES AUTANT. Un « +1 » partout aurait
 *    donne +36 % d'attaque et +2,8 % de vie pour le meme effort.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Realm } = require('./realm');
const { Game } = require('./game');
const M = require('./monde');
const P = require('./personnages');
const cfg = require('./config');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const leve = (f, m) => { assert.throws(f, undefined, m); n++; };

function alea(graine) {
  let s = graine >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const A = '0x' + 'a1'.repeat(20);
const FICHE = { skin: 'andy', nom: 'Dodexel', famille: 'lame',
                degats: P.DEGATS_ARME.commun,
                stats: { hp: 350, att: 28, def: 13 } };

/* Une creature posee a cote du joueur, avec juste assez de vie pour mourir
   au premier coup. */
function pose(r, espece, x, y, pv) {
  const m = { id: r._nouvelId(), espece, biome: 'terre', x, y, ancreX: x, ancreY: y,
              pv: pv === undefined ? 1 : pv, pvMax: M.MONSTRES[espece].pv,
              dir: 'down', cible: null, recharge: 0, rechargeT: 0, stase: 0,
              errX: 0, errY: 0, errChrono: 0 };
  r.monstres.push(m);
  return m;
}

// ================== 1. LES TAUX SONT CEUX QU'ON ANNONCE
{
  const a = alea(20260820);
  const compte = (espece, tours) => {
    let bleu = 0, brun = 0;
    for (let i = 0; i < tours; i++) {
      const b = M.butinDe(espece, a);
      if (!b) continue;
      if (b.sac === 'bleu') bleu++; else brun++;
    }
    return { bleu: bleu / tours, brun: brun / tours };
  };

  const sq = compte('skeleton', 40000);
  ok(Math.abs(sq.bleu - 1 / 50) < 0.006,
     `un squelette laisse une potion de stat dans ${(sq.bleu * 100).toFixed(2)} % des morts (vise 2 %)`);
  ok(Math.abs(sq.brun - 1 / 6) < 0.02,
     `et un soin dans ${(sq.brun * 100).toFixed(1)} % (vise 16,7 %)`);

  /* ---- LA NUEE NE PAIE PAS UN POINT PERMANENT ----
   * Quarante-cinq points d'experience, seize exemplaires par anneau : si elle
   * donnait des potions de stat au meme taux que les autres, elle serait la
   * seule creature qu'on chasserait jamais. */
  const nu = compte('nuee', 40000);
  eq(nu.bleu, 0, 'la nuee ne laisse JAMAIS de potion de stat');
  ok(nu.brun < 0.06, `et peu de soins (${(nu.brun * 100).toFixed(1)} %) — sinon l ecran se couvre de bruns`);

  /* ---- LE BOSS, LUI, PAIE A COUP SUR ----
   * Il sort une fois par anneau de lave et porte seize cents points de vie.
   * Un boss qu'on peut abattre pour rien ne vaut pas le deplacement. */
  const ga = compte('gardien', 2000);
  eq(ga.bleu, 1, 'le gardien laisse TOUJOURS une potion de stat');

  /* Et il les donne toutes : c'est ce qui en fait une destination. On y va
     pour ce qui manque, pas pour ce qu'il a. */
  const vues = {};
  for (let i = 0; i < 4000; i++) vues[M.butinDe('gardien', a).stat] = true;
  eq(Object.keys(vues).length, P.STATS.length,
     `le gardien donne les ${P.STATS.length} stats, pas une seule`);

  /* Chaque espece a SA potion, toujours la meme : c'est ce qui donne une
     raison d'aller chercher telle creature plutot que la plus proche. */
  ['lime', 'skeleton', 'archer', 'rodeur', 'glace', 'meduse', 'oracle', 'lave'].forEach((e) => {
    const s = {};
    for (let i = 0; i < 6000; i++) { const b = M.butinDe(e, a); if (b && b.stat) s[b.stat] = true; }
    eq(Object.keys(s).length, 1, `« ${M.MONSTRES[e].nom} » ne laisse qu'une seule stat (${Object.keys(s)[0]})`);
  });
  /* Et les huit stats sont couvertes par les huit creatures : une stat sans
     source serait un plafond qu'on ne peut jamais depasser. */
  const sources = {};
  Object.keys(M.POTION_DE).forEach((e) => { if (M.POTION_DE[e] !== '*') sources[M.POTION_DE[e]] = true; });
  P.STATS.forEach((s) => ok(sources[s], `« ${s} » a bien une creature qui la donne`));
}

// ================== 2. LES DEUX CHEMINS DE MORT TIRENT LE BUTIN
{
  /* Le gardien tombe a coup sur : c'est ce qui rend la verification nette.
     Si un chemin oubliait le butin, il rendrait zero sac sur cent morts. */
  const parLaFleche = () => {
    const r = new Realm({ alea: alea(7) });
    const j = r.rejoint(A, FICHE);
    r.monstres = [];
    pose(r, 'gardien', j.x + 40, j.y, 1);
    r.tire(A, 0);
    for (let i = 0; i < 20 && !r.sacs.length; i++) r.pas(0.05);
    return r.sacs.length;
  };
  const parLEclair = () => {
    const r = new Realm({ alea: alea(7) });
    /* Le fruit ET la reserve : sans `mp` dans la fiche, `mpMax` vaut zero et
       le pouvoir est refuse faute de mana — l'essai passerait pour un butin
       manquant alors qu'aucun eclair n'a ete lance. */
    const j = r.rejoint(A, { ...FICHE, statFruit: 'att',
                             stats: { ...FICHE.stats, mp: 300 } });
    j.mp = j.mpMax;
    r.monstres = [];
    pose(r, 'gardien', j.x + 40, j.y, 1);
    r.pouvoir(A, { touches: [], kills: [] });
    return r.sacs.length;
  };
  eq(parLaFleche(), 1, 'un monstre tue AU TIR laisse son sac');
  eq(parLEclair(), 1, 'un monstre tue AU POUVOIR laisse le sien aussi');
}

// ================== 3. UNE MINUTE, ENTIERE, PUIS PLUS JAMAIS
{
  const r = new Realm({ alea: alea(11) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];
  pose(r, 'gardien', j.x + 40, j.y, 1);
  r.tire(A, 0);
  for (let i = 0; i < 20 && !r.sacs.length; i++) r.pas(0.05);
  eq(r.sacs.length, 1, 'le sac est la');
  /* ---- IL NAIT AVEC SA MINUTE ENTIERE ----
   * Dans l'autre ordre, un sac ne a l'instant se voyait retirer le temps du
   * pas ou il venait de naitre. Trois centiemes ne changent rien en jeu — mais
   * « il dure une minute » est une phrase qu'on peut verifier. */
  eq(r.sacs[0].reste, M.SAC.duree,
     `il part avec ses ${M.SAC.duree} secondes entieres, pas ${M.SAC.duree} moins un pas`);

  let t = 0;
  while (r.sacs.length && t < 90) { r.pas(0.1); t += 0.1; }
  ok(t >= M.SAC.duree - 0.2 && t <= M.SAC.duree + 0.2,
     `il disparait a ${t.toFixed(1)} s (annonce : ${M.SAC.duree})`);
  eq(r.sacs.length, 0, 'et il ne revient jamais');
}

// ================== 4. ON NE RAMASSE QU'A PORTEE, ET LE PLUS PROCHE
{
  const r = new Realm({ alea: alea(13) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];

  /* Deux sacs, un loin, un pres. */
  r.sacs = [
    { id: 1, x: j.x + M.SAC.rayon * 3, y: j.y, sac: 'brun', potion: 'vie', reste: 60 },
    { id: 2, x: j.x + 10, y: j.y, sac: 'bleu', stat: 'att', reste: 60 },
    { id: 3, x: j.x + 40, y: j.y, sac: 'brun', potion: 'mana', reste: 60 },
  ];
  const pris = r.ramasse(A, null, () => true);
  eq(pris && pris.id, 2, 'on ramasse le PLUS PROCHE, pas le premier de la liste');
  eq(r.sacs.length, 2, 'et les autres restent au sol');

  /* Celui qui est hors de portee ne se ramasse pas, meme s'il est seul. */
  r.sacs = [{ id: 9, x: j.x + M.SAC.rayon * 3, y: j.y, sac: 'brun', potion: 'vie', reste: 60 }];
  eq(r.ramasse(A, null, () => true), null, 'un sac hors de portee ne se ramasse pas');
  eq(r.sacs.length, 1, 'et il reste ou il est');

  /* ---- UN REFUS LAISSE LE SAC AU SOL ----
   * Sans ca, une potion d'attaque ramassee a 20/20 serait bue pour rien et le
   * sac aurait disparu — le joueur perdrait la trouvaille en la trouvant. */
  r.sacs = [{ id: 4, x: j.x + 10, y: j.y, sac: 'bleu', stat: 'att', reste: 60 }];
  const refus = r.ramasse(A, null, () => 'plein');
  ok(refus && refus.refuse, 'un refus se dit');
  eq(refus.raison, 'plein', 'et il dit POURQUOI');
  eq(r.sacs.length, 1, 'le sac refuse reste au sol et finira sa minute');
}

// ================== 5. LA POTION DE STAT
{
  const g = new Game();
  const p = g._p(A);
  p.balance = ethers.utils.parseUnits('999999', cfg.DECIMALS);
  p.hasDeposited = true;
  g.acheteSkin(A, 'andy');

  const avant = g.personnageEtat(A, 'andy').stats;
  const maxAtt = P.supMaxDe('att', P.BASE.andy.att);
  eq(g.supRestant(A, 'andy', 'att'), maxAtt,
     `on peut boire ${maxAtt} potions d attaque (plafond ${P.BASE.andy.att})`);

  /* ---- ELLE MONTE AU-DESSUS DU PLAFOND ----
   * `statAuNiveau` est le maximum que la naissance autorise. La potion passe
   * par-dessus : c'est la seule chose qui le permette et qui ne se retire
   * pas. */
  for (let i = 0; i < maxAtt; i++) g.boitStat(A, 'andy', 'att');
  const fiche = g.personnageEtat(A, 'andy');
  eq(fiche.stats.att, avant.att + maxAtt,
     `l attaque passe de ${avant.att} a ${fiche.stats.att}, au-dessus du plafond`);
  eq(g.supRestant(A, 'andy', 'att'), 0, 'et il n en reste plus a boire');
  leve(() => g.boitStat(A, 'andy', 'att'), 'une de plus est refusee');
  eq(fiche.sup.att.potions, maxAtt, 'la fiche dit combien ont ete bues');
  eq(fiche.sup.att.max, maxAtt, 'et jusqu ou on peut aller');
  /* Le plafond part meme a zero potion : sans lui la page ecrirait « 0 / 20 »
     sur la defense, et le joueur decouvrirait la vraie borne en se faisant
     refuser une potion qu'il vient de traverser la carte pour prendre. */
  ok(fiche.sup.def && fiche.sup.def.max > 0 && fiche.sup.def.max < P.SUP_MAX,
     `la defense annonce son propre plafond (${fiche.sup.def.max}), pas ${P.SUP_MAX}`);

  /* ---- LES HUIT VALENT A PEU PRES AUTANT ----
   * L'attaque tourne autour de 55, les points de vie autour de 700. Un « +1 »
   * partout aurait donne +36 % et +2,8 % pour le meme effort : la potion de
   * vie n'aurait pas valu la peine d'etre ramassee. */
  const gains = P.STATS.map((s) => {
    const cap = P.BASE.andy[s];
    const mx = P.supMaxDe(s, cap);
    return { s, mx, part: P.supDe(s, mx, cap) / cap };
  });
  const mini = Math.min(...gains.map((x) => x.part));
  const maxi = Math.max(...gains.map((x) => x.part));
  ok(maxi <= P.SUP_PART + 0.001,
     'aucune ne depasse le quart du plafond de naissance : ' +
     gains.map((x) => `${x.s} +${(x.part * 100).toFixed(0)} %`).join(', '));
  ok(maxi / mini < 2,
     `et la plus forte ne vaut pas le double de la plus faible (${(maxi * 100).toFixed(0)} % contre ${(mini * 100).toFixed(0)} %)`);

  /* ---- ET LA MESURE QUI COMPTE VRAIMENT : LA SURVIE ----
   * « +20 DEF = +80 % » etait vrai et ne voulait rien dire. Ce qui se joue,
   * c'est le nombre de coups qu'on encaisse — et `degatsSubis` a un plancher
   * qui rend la defense discontinue. Vingt points poussaient le joueur contre
   * ce plancher au milieu du jeu et nulle part ailleurs : +200 % de survie
   * contre un squelette, +0 % contre un lime, +17 % contre le gardien.
   * On verifie donc que le gain de defense reste du meme ordre que celui de
   * la vie, contre TOUTES les creatures — pas seulement en moyenne. */
  {
    const cap = {};
    P.STATS.forEach((s) => { cap[s] = P.statAuNiveau(P.BASE.andy[s], P.NIVEAU_MAX); });
    const survie = (hp, def, att) => hp / Math.max(1, M.degatsSubis(att, def));
    const gainHp = P.supDe('hp', P.supMaxDe('hp', P.BASE.andy.hp), P.BASE.andy.hp);
    const gainDef = P.supDe('def', P.supMaxDe('def', P.BASE.andy.def), P.BASE.andy.def);
    /* La defense vaut BEAUCOUP contre ce qui frappe faiblement et PEU contre
       ce qui frappe fort. C'est ce qu'une armure doit faire, et c'est la forme
       naturelle d'une soustraction — on ne cherche pas a l'aplatir. Ce qu'on
       verifie, c'est qu'elle ne DEBORDE pas. */
    let plusDur = null;
    Object.keys(M.MONSTRES).forEach((e) => {
      const att = M.MONSTRES[e].att;
      const nu = survie(cap.hp, cap.def, att);
      const parHp = survie(cap.hp + gainHp, cap.def, att) / nu - 1;
      const parDef = survie(cap.hp, cap.def + gainDef, att) / nu - 1;
      /* Rien ne DOUBLE la survie. Avec vingt points de defense, le squelette
         passait a +200 % : une seule serie de potions rendait tout un anneau
         inoffensif, et le reste du jeu sans interet. */
      ok(parDef < 1 && parHp < 1,
         `contre « ${M.MONSTRES[e].nom} » (att ${att}) : defense +${(parDef * 100).toFixed(0)} %, ` +
         `vie +${(parHp * 100).toFixed(0)} % — aucune ne double la survie`);
      if (!plusDur || att > plusDur.att) plusDur = { att, nom: M.MONSTRES[e].nom, parHp, parDef };
    });
    /* ---- ET LE CHOIX RESTE UN CHOIX ----
     * Contre la creature qui frappe le plus fort, l'armure ne remplace pas la
     * vie : elle y vaut moins. Une armure qui gagnerait partout aurait fait
     * des sept autres potions du decor. */
    ok(plusDur.parDef < plusDur.parHp,
       `contre « ${plusDur.nom} », le plus dur du monde, la vie (+${(plusDur.parHp * 100).toFixed(0)} %) ` +
       `bat l armure (+${(plusDur.parDef * 100).toFixed(0)} %) : on choisit vraiment`);
  }

  /* ---- ET ELLE MEURT AVEC LE PERSONNAGE ----
   * Il n'existe aucun moyen de la mettre a l'abri : ni coffre, ni sac. C'est
   * ce qui la rend chere. */
  for (let i = 0; i < 5; i++) g.boitStat(A, 'andy', 'def');
  const bilan = g.meurt(A, 'andy');
  eq(bilan.supPerdu.att, maxAtt, 'le bilan de mort nomme les potions perdues');
  eq(bilan.supPerdu.def, 5, 'toutes, pas seulement la derniere stat');
  const apres = g.personnageEtat(A, 'andy');
  /* Les huit lignes restent — la page a besoin des plafonds pour ecrire
     « 0 / 6 ». Ce qui doit etre a zero, c'est le COMPTE. */
  eq(P.STATS.filter((s) => apres.sup[s].potions > 0).length, 0, 'et il ne reste rien de bu');
  ok(apres.stats.att < fiche.stats.att, 'l attaque est retombee');

  /* ---- LE SOIN, LUI, EST DU STOCK ----
   * Il entre dans la MEME pile que celles de la boutique : deux piles
   * separees auraient demande au joueur de savoir laquelle il boit. */
  const av = g.potionsPour(A).filter((x) => x.cle === 'vie')[0].quantite;
  g.donnePotion(A, 'vie');
  eq(g.potionsPour(A).filter((x) => x.cle === 'vie')[0].quantite, av + 1,
     'une potion trouvee rejoint la pile achetee');
  const maxPot = g.potionsPour(A).filter((x) => x.cle === 'vie')[0].max;
  p.potions.vie = maxPot;
  leve(() => g.donnePotion(A, 'vie'), `on n en porte pas plus de ${maxPot}`);
}

// ================== 6. TOUT SURVIT AU REDEMARRAGE
{
  /* Les potions bues sont un ACQUIS. Seule la mort du personnage les efface —
     pas un incident d'exploitation. */
  const g = new Game();
  const p = g._p(A);
  p.balance = ethers.utils.parseUnits('999999', cfg.DECIMALS);
  p.hasDeposited = true;
  g.acheteSkin(A, 'andy');
  for (let i = 0; i < 6; i++) g.boitStat(A, 'andy', 'wis');
  const avant = g.personnageEtat(A, 'andy').stats.wis;

  const g2 = new Game();
  g2.remplace(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2.personnageEtat(A, 'andy').stats.wis, avant,
     'les potions bues traversent un redemarrage');
  eq(g2.personnageEtat(A, 'andy').sup.wis.potions, 6, 'avec leur compte exact');
}

console.log('butin.test.js : ' + n + ' verifications OK');
