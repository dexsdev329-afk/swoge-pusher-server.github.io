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
    let bleu = 0, brun = 0, oeuf = 0;
    for (let i = 0; i < tours; i++) {
      const b = M.butinDe(espece, a);
      if (!b) continue;
      /* L'oeuf compte a part. Il passe AVANT tout le reste de la chaine, donc
         il prend la place du butin ordinaire une fois sur mille deux cents —
         y compris chez une creature dont le butin est promis. Le fondre dans
         « brun » aurait fait mentir toutes les proportions d'un millieme, ce
         qui est petit et faux. */
      if (b.contenu && b.contenu[0] && b.contenu[0].oeuf) { oeuf++; continue; }
      if (b.sac === 'bleu') bleu++; else brun++;
    }
    return { bleu: bleu / tours, brun: brun / tours, oeuf: oeuf / tours };
  };

  /* ---- LES TAUX VIENNENT DU MOTEUR, JAMAIS RECOPIES ----
   * Ils etaient ecrits ici — « 1/50 », « 1/6 ». Le jour ou l'on baisse le
   * taux des fioles, cet essai tombe en accusant le tirage alors que c'est
   * LUI qui porte l'ancien chiffre. C'est arrive exactement comme ca.
   * Ce que l'essai doit prouver n'est pas la valeur du reglage : c'est que le
   * tirage rend bien ce que le reglage annonce. */
  const VISE_BLEU = M.CHANCE_POTION.skeleton === undefined
    ? M.CHANCE_POTION.defaut : M.CHANCE_POTION.skeleton;
  const VISE_BRUN = M.CHANCE_SOIN.skeleton === undefined
    ? M.CHANCE_SOIN.defaut : M.CHANCE_SOIN.skeleton;
  const sq = compte('skeleton', 40000);
  /* La marge suit le taux : une tolerance fixe de 0,6 point est enorme devant
     0,67 % et serree devant 2 %. On prend le plus grand de « un tiers du taux »
     et d'un plancher — sous lequel le bruit de quarante mille tirages
     dominerait la mesure. */
  const margeB = Math.max(0.004, VISE_BLEU / 3);
  ok(Math.abs(sq.bleu - VISE_BLEU) < margeB,
     `un squelette laisse une potion de stat dans ${(sq.bleu * 100).toFixed(2)} % des morts `
     + `(le monde en annonce ${(VISE_BLEU * 100).toFixed(2)} %)`);
  ok(Math.abs(sq.brun - VISE_BRUN) < Math.max(0.02, VISE_BRUN / 5),
     `et un soin dans ${(sq.brun * 100).toFixed(1)} % (le monde en annonce ${(VISE_BRUN * 100).toFixed(1)} %)`);

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
  /* ---- « TOUJOURS », SAUF L'OEUF ----
   * Le gardien promettait une potion de stat a chaque mort. Depuis que l'oeuf
   * tombe une fois sur mille deux cents et qu'il passe en TETE de la chaine,
   * il prend cette place-la de temps en temps.
   * On accepte, et voici pourquoi : le joueur ne recoit jamais MOINS. Un oeuf
   * vaut cent fois une potion de stat, et son sac est turquoise — on voit
   * immediatement que ce n'est pas la potion attendue, donc personne ne croit
   * a un butin manque. L'inverse — rendre les boss immunises a l'oeuf —
   * aurait exclu justement les creatures qu'on chasse le plus, alors que
   * « de N'IMPORTE QUELLE creature » est toute l'idee. */
  eq(ga.bleu + ga.oeuf, 1,
     `le gardien laisse TOUJOURS ce qu'il promet (potion ${(ga.bleu * 100).toFixed(1)} %` +
     ` + oeuf ${(ga.oeuf * 100).toFixed(2)} %)`);
  ok(ga.bleu > 0.99, `et c'est la potion dans la quasi-totalite des cas (${(ga.bleu * 100).toFixed(1)} %)`);

  /* Et il les donne toutes : c'est ce qui en fait une destination. On y va
     pour ce qui manque, pas pour ce qu'il a. */
  const vues = {};
  for (let i = 0; i < 4000; i++) {
    const c = M.butinDe('gardien', a).contenu[0];
    /* L'oeuf n'a pas de stat. Sans ce saut, `undefined` entrait dans la liste
       et le gardien avait NEUF stats — une de plus que le jeu n'en a. Le
       symptome ne parlait pas de l'oeuf : il disait « le gardien donne les 8
       stats, pas une seule », ce qui est exactement le contraire du
       probleme. */
    if (c.oeuf) continue;
    vues[c.stat] = true;
  }
  eq(Object.keys(vues).length, P.STATS.length,
     `le gardien donne les ${P.STATS.length} stats, pas une seule`);

  /* Chaque espece a SA potion, toujours la meme : c'est ce qui donne une
     raison d'aller chercher telle creature plutot que la plus proche. */
  ['lime', 'skeleton', 'archer', 'rodeur', 'glace', 'meduse', 'oracle', 'lave'].forEach((e) => {
    const s = {};
    for (let i = 0; i < 6000; i++) {
      const b = M.butinDe(e, a);
      if (b && b.contenu[0].stat) s[b.contenu[0].stat] = true;
    }
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
    { id: 1, x: j.x + M.SAC.rayon * 3, y: j.y, sac: 'brun', contenu: [{ potion: 'vie' }], reste: 60 },
    { id: 2, x: j.x + 10, y: j.y, sac: 'bleu', contenu: [{ stat: 'att' }], reste: 60 },
    { id: 3, x: j.x + 40, y: j.y, sac: 'brun', contenu: [{ potion: 'mana' }], reste: 60 },
  ];
  eq(r.sacSousLesPieds(A).id, 2, 'on ouvre le PLUS PROCHE, pas le premier de la liste');
  const pris = r.ramasse(A, null, () => true, 2, 0);
  eq(pris && pris.stat, 'att', 'et on prend bien ce qu il contenait');
  eq(r.sacs.length, 2, 'un sac vide disparait, les autres restent au sol');

  /* ---- ON PREND UNE PLACE, PAS LE SAC ----
   * Un sac a deux objets dont un qu'on ne peut pas porter doit pouvoir etre
   * vide a moitie. Sans ca, le joueur perdrait la trouvaille en la trouvant. */
  r.sacs = [{ id: 5, x: j.x + 10, y: j.y, sac: 'or', reste: 60,
              contenu: [{ stat: 'def' }, { potion: 'vie' }] }];
  const un = r.ramasse(A, null, () => true, 5, 1);
  eq(un && un.potion, 'vie', 'on prend la place qu on a nommee, pas la premiere');
  eq(r.sacs.length, 1, 'et le sac reste, puisqu il lui reste quelque chose');
  eq(r.sacs[0].contenu.length, 1, 'avec une place de moins');
  eq(r.sacs[0].contenu[0].stat, 'def', 'et c est bien l autre qui reste');
  /* Un identifiant qui ne correspond pas ne prend rien : un sac expire
     pendant que le doigt descend ne doit pas faire prendre son voisin. */
  eq(r.ramasse(A, null, () => true, 999, 0), null, 'un sac qu on ne nomme pas juste ne rend rien');
  eq(r.ramasse(A, null, () => true, 5, 7), null, 'une place vide non plus');

  /* Celui qui est hors de portee ne se ramasse pas, meme s'il est seul. */
  r.sacs = [{ id: 9, x: j.x + M.SAC.rayon * 3, y: j.y, sac: 'brun', contenu: [{ potion: 'vie' }], reste: 60 }];
  eq(r.ramasse(A, null, () => true, 9, 0), null, 'un sac hors de portee ne se ramasse pas');
  eq(r.sacSousLesPieds(A), null, 'et il ne s ouvre meme pas');
  eq(r.sacs.length, 1, 'et il reste ou il est');

  /* ---- UN REFUS LAISSE LE SAC AU SOL ----
   * Sans ca, une potion d'attaque ramassee a 20/20 serait bue pour rien et le
   * sac aurait disparu — le joueur perdrait la trouvaille en la trouvant. */
  r.sacs = [{ id: 4, x: j.x + 10, y: j.y, sac: 'bleu', contenu: [{ stat: 'att' }], reste: 60 }];
  const refus = r.ramasse(A, null, () => 'plein', 4, 0);
  ok(refus && refus.refuse, 'un refus se dit');
  eq(refus.raison, 'plein', 'et il dit POURQUOI');
  eq(r.sacs.length, 1, 'le sac refuse reste au sol et finira sa minute');
  eq(r.sacs[0].contenu.length, 1, 'avec son contenu intact');
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
  /* ---- A DEUX NIVEAUX, ET C'EST NEUF ----
   * Ce bloc ne mesurait qu'au NIVEAU MAXIMUM, du temps ou le maximum ETAIT le
   * palier. Depuis que le plafond monte a cent, le maximum n'est plus le cas
   * le plus dur : au palier la defense vaut encore sa valeur de naissance, et
   * quelques points de potion y font basculer tout un anneau contre le
   * plancher de degats. Ne garder que le niveau cent aurait donc AFFAIBLI ce
   * garde-fou en silence — on mesure aux DEUX bouts. */
  [['le palier', P.NIVEAU_PALIER], ['le niveau maximum', P.NIVEAU_MAX]].forEach(([ou, niv]) => {
    const cap = {};
    P.STATS.forEach((s) => { cap[s] = P.statAuNiveau(P.BASE.andy[s], niv); });
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
         `a ${ou}, contre « ${M.MONSTRES[e].nom} » (att ${att}) : defense +${(parDef * 100).toFixed(0)} %, ` +
         `vie +${(parHp * 100).toFixed(0)} % — aucune ne double la survie`);
      if (!plusDur || att > plusDur.att) plusDur = { att, nom: M.MONSTRES[e].nom, parHp, parDef };
    });
    /* ---- ET LE CHOIX RESTE UN CHOIX ----
     * Contre la creature qui frappe le plus fort, l'armure ne remplace pas la
     * vie : elle y vaut moins. Une armure qui gagnerait partout aurait fait
     * des sept autres potions du decor. */
    ok(plusDur.parDef < plusDur.parHp,
       `a ${ou}, contre « ${plusDur.nom} », le plus dur du monde, la vie ` +
       `(+${(plusDur.parHp * 100).toFixed(0)} %) bat l armure ` +
       `(+${(plusDur.parDef * 100).toFixed(0)} %) : on choisit vraiment`);
  });

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

// ================== 7. L'ECHANGE : ON DEPOSE AUTANT QU'ON PREND
/*
 * Un sac au sol n'est pas seulement une source. On y depose, ce qui rend
 * l'echange possible — poser son epee commune, prendre celle qu'on vient de
 * trouver — et c'est aussi comment on donne : le sac est visible de tous.
 *
 * Le risque de toute cette moitie tient en une phrase : UN OBJET NE DOIT
 * JAMAIS DISPARAITRE DES DEUX COTES. Il est dans le sac du joueur, ou il est
 * au sol, jamais entre les deux et jamais nulle part.
 */
{
  const g = new Game();
  const p = g._p(A);
  p.balance = ethers.utils.parseUnits('999999', cfg.DECIMALS);
  p.hasDeposited = true;
  g.acheteSkin(A, 'andy');

  const boutique = require('./boutique');
  const unObjet = boutique.itemsDeSaison(2)[0].id;   // une arme quelconque
  const autre = boutique.itemsDeSaison(3)[0].id;

  const r = new Realm({ alea: alea(21) });
  const j = r.rejoint(A, FICHE);
  r.monstres = [];

  /* ---- SANS SAC DESSOUS, IL EN NAIT UN BRUN ----
   * Brun, et pas dore : un objet depose ne doit pas ressembler a un butin
   * rare, sinon on traverserait la carte pour une epee commune que quelqu'un
   * a jetee. */
  p.sac = {}; p.sac[unObjet] = 1;
  eq(g.sacRempli(A), 1, 'l objet est bien dans le sac du joueur');
  g.poseAuSol(A, unObjet);
  const ne = r.depose(A, unObjet, null);
  ok(ne && !ne.refuse, 'deposer sans rien sous les pieds cree un sac');
  eq(r.sacs.length, 1, 'un seul');
  eq(r.sacs[0].sac, 'brun', 'et il est BRUN, pas dore');
  eq(r.sacs[0].reste, M.SAC.duree, `avec sa minute entiere (${M.SAC.duree} s)`);
  eq(r.sacs[0].contenu[0].item, unObjet, 'il contient bien la piece deposee');
  eq(g.sacRempli(A), 0, 'et elle n est plus dans le sac du joueur');

  /* ---- UN DEUXIEME DEPOT REJOINT LE MEME SAC ----
   * Sinon on couvrirait le sol de sacs a un objet, et il faudrait marcher
   * dessus un par un. */
  p.sac[autre] = 1;
  g.poseAuSol(A, autre);
  r.depose(A, autre, null);
  eq(r.sacs.length, 1, 'un deuxieme depot rejoint le sac deja la');
  eq(r.sacs[0].contenu.length, 2, 'qui porte maintenant deux places');

  /* ---- ET ON REPREND ----
   * Le meme geste dans l'autre sens : c'est ca, l'echange. */
  const repris = r.ramasse(A, null, () => true, r.sacs[0].id, 0);
  eq(repris.item, unObjet, 'on reprend la piece qu on avait posee');
  g.prendDuSol(A, repris.item);
  eq(g.sacRempli(A), 1, 'elle revient dans le sac du joueur');
  eq(r.sacs[0].contenu.length, 1, 'et le sac au sol n en a plus qu une');

  /* ---- UN SAC AU SOL PLEIN REFUSE ----
   * Et c'est le cas dangereux : le serveur sort la piece du sac du joueur
   * AVANT de savoir si le sol en veut. Sans le retour, elle disparaitrait. */
  r.sacs[0].contenu = [];
  for (let i = 0; i < M.SAC.cases; i++) r.sacs[0].contenu.push({ potion: 'vie' });
  const refus = r.depose(A, autre, null);
  ok(refus && refus.refuse, `un sac au sol plein (${M.SAC.cases} places) refuse`);
  eq(r.sacs[0].contenu.length, M.SAC.cases, 'et son contenu ne bouge pas');
  eq(r.sacs.length, 1, 'aucun sac de secours ne nait a cote');

  /* ---- LE SAC DU JOUEUR PLEIN REFUSE AUSSI ----
   * L'objet doit rester AU SOL. Le sortir du sac au sol pour decouvrir
   * ensuite qu'il n'a nulle part ou aller le ferait disparaitre. */
  r.sacs = [{ id: 60, x: j.x + 10, y: j.y, sac: 'or', reste: 60,
              contenu: [{ item: autre }] }];
  const bloque = r.ramasse(A, null, (o) => (o.item ? 'sac-plein' : true), 60, 0);
  ok(bloque && bloque.refuse, 'un sac de joueur plein refuse la piece');
  eq(r.sacs[0].contenu.length, 1, 'et elle reste au sol, intacte');
  eq(r.sacs[0].contenu[0].item, autre, 'la meme');

  /* ---- LE PLAFOND DU SAC EST BIEN CELUI DU JEU ----
   * Il vit dans game.js (SAC_CASES) et pas dans un chiffre recopie ici : le
   * refus et l'affichage doivent compter les memes cases. */
  p.sac = {};
  const pieces = boutique.itemsDeSaison(2).slice(0, 9).map((o) => o.id);
  let poses = 0;
  for (const id of pieces) {
    try { g.prendDuSol(A, id); poses++; } catch (e) { break; }
  }
  eq(poses, 8, `le sac du joueur s arrete a huit places (${poses} acceptees)`);
  leve(() => g.prendDuSol(A, pieces[8]), 'et la neuvieme est refusee');
}

// ================== 8. L'EQUIPEMENT QUI TOMBE
/*
 * L'anneau decide de la rarete, et la couleur du sac dit de loin ce qu'on
 * abandonne si l'on n'y va pas. Ce fichier-ci ne choisit pas la piece — il
 * ne connait pas la boutique et n'a aucune raison de la connaitre.
 */
{
  const a = alea(31415);
  const releve = (espece, biome, tours) => {
    const c = {};
    for (let i = 0; i < tours; i++) {
      const b = M.butinDe(espece, a, biome);
      if (!b) continue;
      const o = b.contenu[0];
      const k = o.objet ? 'objet:' + o.objet + ':' + b.sac : (o.stat ? 'stat' : 'soin');
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  };

  /* ---- CHAQUE ANNEAU DONNE SA RARETE, ET RIEN D'AUTRE ----
   * Un mythique qui tomberait sur la terre viderait la pente de son sens :
   * on lirait le sol pour savoir ou l'on est, pas ce qu'on peut gagner. */
  const attendu = { terre: 'commun', marais: 'rare', neige: 'epique',
                    cendres: 'legendaire', lave: 'mythique' };
  Object.keys(attendu).forEach((b) => {
    const c = releve('lime', b, 30000);
    const objets = Object.keys(c).filter((k) => k.indexOf('objet:') === 0);
    /* La relique est a part : elle ne depend pas de l'anneau mais du coeur,
       et elle a son propre essai plus bas. */
    const raretes = new Set(objets.map((k) => k.split(':')[1]).filter((r) => r !== 'relique'));
    ok(raretes.size === 1 && raretes.has(attendu[b]),
       `l anneau « ${b} » ne donne que du ${attendu[b]} (${[...raretes].join(',')})`);
  });

  /* ---- LA COULEUR DU SAC EST LE PRIX ----
   * Un sac dore qui contiendrait du commun apprendrait au joueur a ne plus
   * traverser la carte pour un sac dore. */
  const couleur = { commun: 'brun', rare: 'brun', epique: 'violet',
                    legendaire: 'or', mythique: 'rouge', relique: 'blanc' };
  Object.keys(couleur).forEach((r) => {
    eq(M.SAC_DE_RARETE[r], couleur[r], `le ${r} tombe dans un sac ${couleur[r]}`);
  });

  /* ---- LA PENTE DES TAUX ----
   * Au bord on s'equipe, au coeur on complete. Un mythique aussi frequent
   * qu'un commun aurait rendu la boutique inutile en une soiree. */
  const rangs = ['commun', 'rare', 'epique', 'legendaire', 'mythique'];
  for (let i = 1; i < rangs.length; i++) {
    ok(M.CHANCE_EQUIP[rangs[i]] < M.CHANCE_EQUIP[rangs[i - 1]],
       `le ${rangs[i]} tombe moins souvent que le ${rangs[i - 1]} ` +
       `(1/${Math.round(1 / M.CHANCE_EQUIP[rangs[i]])} contre 1/${Math.round(1 / M.CHANCE_EQUIP[rangs[i - 1]])})`);
  }

  /* ---- LA RELIQUE NE TOMBE QUE DANS LA LAVE ----
   * Et le gardien en donne bien plus souvent que le reste : c'est ce qui fait
   * de lui une destination plutot qu'un gros monstre. */
  ['terre', 'marais', 'neige', 'cendres'].forEach((b) => {
    const c = releve('lime', b, 40000);
    ok(!Object.keys(c).some((k) => k.indexOf('objet:relique') === 0),
       `aucune relique dans « ${b} »`);
  });
  {
    const ordinaire = releve('lave', 'lave', 60000);
    const rel = Object.keys(ordinaire).filter((k) => k.indexOf('objet:relique') === 0)
      .reduce((t, k) => t + ordinaire[k], 0);
    ok(rel > 0, `la relique tombe dans la lave (${rel} fois sur 60000)`);
    const boss = releve('gardien', 'lave', 20000);
    const relBoss = Object.keys(boss).filter((k) => k.indexOf('objet:relique') === 0)
      .reduce((t, k) => t + boss[k], 0);
    ok(relBoss / 20000 > (rel / 60000) * 20,
       `le gardien en donne bien plus (${(relBoss / 200).toFixed(1)} % contre ${(rel / 600).toFixed(2)} %)`);
  }

  /* ---- LA RELIQUE PASSE AVANT TOUT LE RESTE ----
   * Un seul tirage par mort : ce qui passe en premier obtient son vrai taux,
   * ce qui passe apres n'a que ce qui reste. Elle est la plus rare, donc elle
   * tire en tete — sinon son 1/1500 deviendrait 1/1800 en silence. */
  {
    const b = alea(2718);
    let vues = 0;
    const N = 300000;
    for (let i = 0; i < N; i++) {
      const r = M.butinDe('lave', b, 'lave');
      if (r && r.contenu[0].objet === 'relique') vues++;
    }
    const taux = vues / N;
    ok(Math.abs(taux - M.CHANCE_RELIQUE.lave) < M.CHANCE_RELIQUE.lave * 0.35,
       `elle sort a 1/${Math.round(1 / taux)}, le taux annonce est 1/${Math.round(1 / M.CHANCE_RELIQUE.lave)}`);
  }

  /* ---- REALM TRANSFORME UNE RARETE EN PIECE, OU NE FAIT RIEN ----
   * `monde.js` dit la rarete, la simulation ne connait pas le catalogue. Sans
   * tireur, aucun sac ne doit naitre avec une place vide : on le ramasserait
   * sans rien recevoir, et on croirait avoir rate son geste. */
  {
    /* On abat mille limes dans la terre, avec et sans tireur. La graine est la
       meme : les deux mondes tirent exactement le meme butin. */
    const abat = (tireur) => {
      const r = new Realm({ alea: alea(9), tireObjet: tireur });
      const j = r.rejoint(A, FICHE);
      r.monstres = [];
      const ev = { kills: [], touches: [], butins: [] };
      for (let i = 0; i < 1500; i++) {
        r.sacs = [];
        r._abat({ id: 1, espece: 'lime', biome: 'terre', x: j.x, y: j.y }, j, ev);
        if (r.sacs.length && r.sacs[0].contenu.some((o) => o.item)) return r.sacs[0];
      }
      return null;
    };
    const sans = abat(null);
    eq(sans, null, 'sans tireur, aucune piece ne tombe — et surtout aucun sac vide');

    const avec = abat((rarete) => {
      const lot = require('./boutique').ITEMS_DROP.filter((o) => o.rarete === rarete);
      const o = lot[0];
      return o ? { item: o.id, cle: o.cle, nom: o.nom, rarete: o.rarete } : null;
    });
    ok(avec, 'avec un tireur, la piece tombe');
    if (avec) {
      const piece = avec.contenu.filter((o) => o.item)[0];
      const o = require('./boutique').item(piece.item);
      ok(o && o.drop, `et c est une TROUVAILLE (« ${piece.nom} »), jamais une piece de boutique`);
      eq(o.rarete, 'commun', 'de la rarete de son anneau');
      ok(piece.cle && piece.nom, 'avec son nom et sa clef d image, portes par la piece');
    }

    /* Le sac ne nait jamais avec une place vide : on le ramasserait sans rien
       recevoir, et le joueur croirait avoir rate son geste. */
    const r2 = new Realm({ alea: alea(4), tireObjet: () => null });
    const j2 = r2.rejoint(A, FICHE);
    r2.monstres = [];
    const ev2 = { kills: [], touches: [], butins: [] };
    for (let i = 0; i < 3000; i++) {
      r2._abat({ id: 1, espece: 'lime', biome: 'terre', x: j2.x, y: j2.y }, j2, ev2);
    }
    ok(r2.sacs.length > 0, `des sacs sont bien tombes (${r2.sacs.length})`);
    ok(r2.sacs.every((s) => s.contenu.length > 0),
       'et aucun n a de place vide, meme quand le tireur ne rend rien');
  }
}

// ================== 9. LE PLAFOND VAUT AUSSI POUR CE QUI TOMBE
/*
 * `RARETES` annonce quatre exemplaires de chaque relique. Ce chiffre ne
 * voulait rien dire tant que rien ne comptait les pieces TROUVEES : la table
 * promettait une rarete que le monde pouvait produire sans fin.
 */
{
  const boutique = require('./boutique');
  const g = new Game();
  /* Les reliques DU MONDE OUVERT. Celles de la Forge sont dans la meme liste —
     meme registre, meme plafond — mais `tireButin` ne peut pas les rendre : si
     le monde ouvert pouvait les faire tomber, on aurait les memes reliques en
     abattant des limes et franchir le portail n'aurait servi a rien. Les
     compter ici ferait attendre a cet essai un plafond que ce tirage-la
     n'atteint jamais. */
  const rel = boutique.ITEMS_DROP.filter((o) => o.rarete === 'relique' && !o.donjon);
  const plafond = boutique.rarete('relique').plafond;
  const total = rel.length * plafond;

  /* ---- ON INSCRIT AU MOMENT OU CA TOMBE, PAS AU RAMASSAGE ----
   * Entre les deux il y a une minute pendant laquelle la piece existe deja au
   * sol : deux joueurs qui courent vers le meme sac ne doivent pas pouvoir
   * emporter la derniere relique chacun. */
  let x = 4242;
  const a = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  const sorties = [];
  for (let i = 0; i < total + 20; i++) {
    const p = g.tireButin('relique', a);
    if (p) sorties.push(p.item);
  }
  eq(sorties.length, total,
     `le monde ne peut sortir que ${total} reliques (${rel.length} pieces x ${plafond})`);
  eq(g.tireButin('relique', a), null, 'la suivante ne tombe pas du tout');
  rel.forEach((o) => {
    eq(g.boutiqueEmis[o.id], plafond, `« ${o.nom} » est sorti ${plafond} fois, pas plus`);
  });

  /* ---- ET CE QUI N'EST PAS RAMASSE REVIENT ----
   * Sans ce retour, quatre reliques tombees dans un coin desert videraient le
   * plafond pour toujours, alors que personne n'en a recu une. */
  g.rendButin(rel[0].id);
  const revenue = g.tireButin('relique', a);
  ok(revenue && revenue.item === rel[0].id,
     'une relique rendue au pool peut retomber');
  eq(g.tireButin('relique', a), null, 'et une seule : le plafond tient toujours');

  /* Le commun ne bloque pas pour autant : son plafond est de mille. */
  const g2 = new Game();
  let sortiesC = 0;
  for (let i = 0; i < 200; i++) if (g2.tireButin('commun', a)) sortiesC++;
  eq(sortiesC, 200, 'deux cents communs sortent sans probleme');

  /* Et on ne tire JAMAIS dans la boutique : une piece vendue qui tomberait
     par terre casserait son propre plafond, puisque rien ne l'aurait comptee
     a l'achat. */
  const g3 = new Game();
  const vus = {};
  for (let i = 0; i < 400; i++) {
    const p = g3.tireButin('legendaire', a);
    if (p) vus[p.item] = true;
  }
  ok(Object.keys(vus).length > 0, 'des legendaires tombent');
  ok(Object.keys(vus).every((id) => boutique.item(Number(id)).drop),
     'et ce sont TOUJOURS des trouvailles, jamais des pieces de boutique');

  /* ---- LE SAC QUI EXPIRE ANNONCE CE QU'IL EMPORTE ----
   * C'est realm.js qui le dit, et server.js qui rend au registre : la
   * simulation ne connait pas la boutique, et le registre ne connait pas le
   * sol. */
  {
    const r = new Realm({ alea: alea(77) });
    const j = r.rejoint(A, FICHE);
    r.monstres = [];
    r.sacs = [{ id: 1, x: j.x, y: j.y, sac: 'blanc', reste: 0.2,
                contenu: [{ item: rel[0].id, nom: rel[0].nom }] }];
    const ev = r.pas(0.3);
    eq(r.sacs.length, 0, 'le sac a fini sa minute');
    eq(ev.expires.length, 1, 'et il annonce ce qu il emporte');
    eq(ev.expires[0].item, rel[0].id, 'nommement');

    /* Un sac qui ne contient qu'une potion n'annonce rien : il n'y a rien a
       rendre, et une liste pleine de riens serait du bruit. */
    r.sacs = [{ id: 2, x: j.x, y: j.y, sac: 'brun', reste: 0.2,
                contenu: [{ potion: 'vie' }] }];
    const ev2 = r.pas(0.3);
    eq(ev2.expires.length, 0, 'une potion perdue ne rend rien au registre');
  }
}


// ================== UNE SALLE GARDEE DONNE TOUJOURS QUELQUE CHOSE
//
// « Il y a quatre boss ou il y a des coffres proteges ; parfois j'ouvre le
// coffre et il n'y a rien dedans. »
//
// C'etait vrai, et c'etait mecanique. La saison ne porte que seize reliques.
// Les deux salles a relique en donnent une par nettoyage et se rearment
// toutes les six minutes : le stock part en trois quarts d'heure. Ensuite,
// tuer deux gardiens de seize cents points de vie ne donnait plus RIEN.
{
  const { Game } = require('./game');
  const g = new Game();
  const r5 = alea(31415);

  /* D'abord : tant qu'il y a des reliques, on donne des reliques. */
  const p1 = g.tireButinGaranti('relique', r5);
  ok(p1 && p1.rarete === 'relique', 'la salle a relique donne une relique');
  ok(!p1.repli, 'et elle ne dit pas avoir replie — elle a tenu sa promesse');

  /* On vide le stock de reliques de la saison, par le chemin normal. */
  let sorties = 1;
  for (let i = 0; i < 200; i++) {
    const q = g.tireButin('relique', r5);
    if (!q) break;
    sorties++;
  }
  console.log('   la saison porte ' + sorties + ' reliques en tout');
  ok(sorties >= 4 && sorties <= 64, `un stock fini, et petit (${sorties})`);
  eq(g.tireButin('relique', r5), null, 'apres quoi il n en reste plus une seule');

  /* ---- ET C'EST LA QUE LA SALLE DEVENAIT MUETTE ---- */
  const p2 = g.tireButinGaranti('relique', r5);
  ok(p2, 'la salle donne QUAND MEME quelque chose');
  ok(p2.rarete !== 'relique', `mais plus une relique (${p2.rarete})`);
  eq(p2.repli, 'relique', 'et elle dit ce qu elle n a pas pu donner');
  /* Elle descend d'UN cran, pas jusqu'en bas : le joueur qui a nettoye une
     salle a relique ne repart pas avec un objet commun. */
  const rangs = require("./boutique").RARETES.map((x) => x.cle);
  eq(rangs[rangs.indexOf('relique') - 1], p2.rarete,
     'exactement le cran en dessous');

  /* La rarete reste RARE : on n'a pas fabrique de reliques en plus. */
  eq(g.tireButin('relique', r5), null, 'et le stock de reliques est toujours vide');

  /* Le repli descend AUTANT QUE NECESSAIRE : on vide aussi le cran d'en
     dessous, et la salle trouve encore. */
  for (let i = 0; i < 4000; i++) if (!g.tireButin(p2.rarete, r5)) break;
  const p3 = g.tireButinGaranti('relique', r5);
  ok(p3, 'deux crans plus bas, elle donne encore');
  ok(p3.rarete !== 'relique' && p3.rarete !== p2.rarete,
     `et c est encore un cran en dessous (${p3.rarete})`);
  eq(p3.repli, 'relique', 'en disant toujours ce qui etait promis');

  /* Un monstre ordinaire, lui, a le droit de ne rien donner : c'est meme le
     cas normal. On ne veut pas que le repli s'applique partout, sinon la
     moindre nuee finirait par lacher des legendaires. */
  eq(g.tireButin('relique', r5), null,
     'le butin ORDINAIRE, lui, rend toujours rien quand il n y a plus rien');
}

console.log('butin.test.js : ' + n + ' verifications OK');