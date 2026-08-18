'use strict';
/*
 * Les missions du jour, jeu par jeu.
 *
 * Une quete globale se remplit toute seule : un joueur de Plinko finissait
 * « lachez 300 pieces » sans jamais avoir ouvert autre chose. Une mission
 * NOMME un jeu, et le jeu change chaque jour.
 *
 * Ce qui compte ici, dans l'ordre :
 *
 *  1. le compteur. La mise du jour doit se ranger sous LE BON jeu — un
 *     compteur qui deborde d'un jeu sur l'autre paierait une mission qu'on n'a
 *     pas faite. On les traverse donc tous, un par un.
 *  2. la rotation. Elle doit etre la meme pour tout le monde, ne pas tourner
 *     quand on recharge, et ne pas oublier un jeu pendant des semaines.
 *  3. l'argent. Ce que la mission rapporte doit rester tres en dessous de ce
 *     que la maison prend sur la mise exigee, sinon on paie quelqu'un pour ne
 *     rien risquer.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, m + ` (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const riche = (g, a, v) => { g._p(a).balance = ethers.utils.parseUnits(String(v), cfg.DECIMALS); };
const mise = (g, a, jeu) => ((g._p(a).miseJour || {})[jeu] || 0);

// =============================================== 1. le compteur, jeu par jeu
/* On appelle le point de passage directement : ce qui est teste ici est le
   RANGEMENT, pas chaque jeu — les jeux sont couverts par leurs propres
   fichiers. Ce qu'on veut savoir, c'est qu'une mise ne se range jamais sous
   le mauvais nom. */
{
  const g = new Game();
  const p = g._p(A);
  g._markWager(p, ethers.utils.parseUnits('700', cfg.DECIMALS), 'mines');
  g._markWager(p, ethers.utils.parseUnits('300', cfg.DECIMALS), 'mines');
  g._markWager(p, ethers.utils.parseUnits('50', cfg.DECIMALS), 'plinko');
  eq(mise(g, A, 'mines'), 1000, 'les mises du meme jeu s additionnent');
  eq(mise(g, A, 'plinko'), 50, 'et ne debordent pas sur le voisin');
  eq(mise(g, A, 'crash'), 0, 'un jeu jamais ouvert reste a zero');
  /* Une mise sans nom de jeu ne doit rien ranger du tout — plutot que de la
     ranger sous un nom par defaut, ce qui remplirait une mission au hasard. */
  g._markWager(p, ethers.utils.parseUnits('9999', cfg.DECIMALS));
  eq(Object.keys(p.miseJour).length, 2, 'une mise sans jeu ne cree aucune ligne');
}

// ------------------------------------ chaque jeu range sous son propre nom
/* Le vrai controle : on joue pour de bon, jeu par jeu, et on regarde ou la
   mise atterrit. Un jeu ajoute demain qui oublierait de se nommer se verrait
   ici, et non trois mois plus tard sur une mission qui n'avance jamais. */
{
  const g = new Game();
  /* Un joueur par jeu : plusieurs de ces jeux gardent une main ouverte, et
     deux mains ouvertes sur le meme compte se refusent l'une l'autre. */
  let s = 0;
  const joueur = () => { const a = '0x' + (10 + (s++)).toString(16).padStart(2, '0').repeat(20);
                         riche(g, a, 5000000); return a; };

  const jPl = joueur(); g.plinkoDrop(jPl, 1000, 16, 'low');
  eq(mise(g, jPl, 'plinko'), 1000, 'plinko');

  const jMi = joueur(); g.minesStart(jMi, 1000, 3);
  eq(mise(g, jMi, 'mines'), 1000, 'mines');

  const jHi = joueur(); g.hiloStart(jHi, 1000);
  eq(mise(g, jHi, 'hilo'), 1000, 'hi-lo');

  const jBj = joueur(); g.bjBet(jBj, 1000);
  eq(mise(g, jBj, 'bj'), 1000, 'blackjack');

  const jHo = joueur(); g.casinoDeal(jHo, 'holdem', 1000, 0);
  eq(mise(g, jHo, 'holdem'), 1000, "casino hold'em");

  const jTh = joueur(); g.casinoDeal(jTh, 'three', 1000, 0);
  eq(mise(g, jTh, 'three'), 1000, 'three card');

  const jSm = joueur(); g.spin(jSm, 1000);
  eq(mise(g, jSm, 'smash'), 1000, 'smash');

  const jSp = joueur(); const paris = cfg.VOLCANO_BETS[0];
  g.volcanoSpin(jSp, paris);
  eq(mise(g, jSp, 'spin'), paris, 'swoge spin');

  const jPu = joueur(); g.drop(jPu);
  ok(mise(g, jPu, 'pusher') > 0, 'coin pusher');

  const jPo = joueur(); g.pokerWager(jPo, 1000);
  eq(mise(g, jPo, 'poker'), 1000, 'poker');

  /* Le crash ne prend les mises qu'entre deux manches : on amene la table
     dans sa fenetre d'attente avant de miser. */
  const jCr = joueur();
  let tc = Date.now();
  g.crashTick(tc);
  if (g.crash.phase !== require('./crash').ATTENTE) g.crashTick(g.crash.jusqua + 1);
  g.crashMise(jCr, 1000, 0, tc);
  eq(mise(g, jCr, 'crash'), 1000, 'crash');

  /* Les trois duels partagent le meme chemin d'argent : il faut donc que
     chacun se range sous SON nom, et pas tous sous celui du Connect 4. */
  const C = '0x' + 'cc'.repeat(20), D = '0x' + 'dd'.repeat(20);
  for (const a of [C, D]) riche(g, a, 5000000);
  for (const [jeu, creer] of [['p4', (a) => g.p4Creer(a, 1000, 1000)],
                              ['mp', (a) => g.duelCreer('mp', a, 1000, 1000)],
                              ['dm', (a) => g.duelCreer('dm', a, 1000, 1000)]]) {
    const m = creer(C);
    eq(mise(g, C, jeu), 1000, `duel ${jeu} : celui qui ouvre`);
    g.duelRejoindre(D, m.id, 2000);
    eq(mise(g, D, jeu), 1000, `duel ${jeu} : celui qui s assied`);
    g.duelAbandonner(C, m.id, 3000);
    g._p(C).miseJour[jeu] = 0; g._p(D).miseJour[jeu] = 0;
  }
  eq(mise(g, C, 'p4') + mise(g, C, 'mp') + mise(g, C, 'dm'), 0,
     'et rien ne s est melange entre les trois');
}

// =================================================== 2. la rotation du jour
{
  const g = new Game();
  const jour = (k) => g.missionsDuJour(k).map((m) => m.jeu).join(',');

  eq(g.missionsDuJour('2026-08-14').length, cfg.MISSIONS_PAR_JOUR,
     'il y a bien le nombre de missions annonce');
  eq(jour('2026-08-14'), jour('2026-08-14'),
     'deux lectures du meme jour donnent les memes jeux');
  ok(jour('2026-08-14') !== jour('2026-08-15'), 'et le lendemain change');

  /* Trois jeux differents le meme jour : proposer deux fois le meme serait
     une mission perdue, et le joueur le verrait tout de suite. */
  for (const k of ['2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17']) {
    const l = g.missionsDuJour(k).map((m) => m.jeu);
    eq(new Set(l).size, l.length, `aucun doublon le ${k}`);
  }

  /* Le catalogue en entier doit passer. Un jeu qui n'apparait jamais est un
     jeu qu'on n'aide jamais — c'est exactement ce qu'on essaie de corriger. */
  const vus = new Set();
  for (let i = 0; i < 40; i++) {
    const k = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    for (const m of g.missionsDuJour(k)) vus.add(m.jeu);
  }
  eq(vus.size, cfg.MISSION_CATALOGUE.length,
     'en quarante jours, tout le catalogue est passe au moins une fois');

  /* Chaque mission doit savoir OU envoyer le joueur : sans la page, on lui
     demande d'aller quelque part sans lui dire ou. */
  for (const m of g.missionsDuJour('2026-08-14')) {
    ok(m.page && /\.html/.test(m.page), `${m.jeu} : la mission porte sa page`);
    ok(m.label.indexOf(m.nom) > 0, `${m.jeu} : et nomme le jeu en clair`);
  }
}

// ========================================== 3. remplir, reclamer, et pas deux fois
{
  const g = new Game();
  const jourKey = g._today();
  riche(g, A, 5000000);
  g._p(A).hasDeposited = true;
  /* L'identifiant de la mission n'est plus « m:<jeu> » mais « n_jeu » : le
     jeu du jour a son propre creneau dans le pool, ce qui evite d'avoir deux
     « misez sur X » le meme jour. On la trouve donc par son PALIER, et c'est
     elle qui dit quel jeu elle nomme. */
  const mission = g.questState(A).find((q) => q.palier === 'jeu');
  ok(mission, 'le jeu du jour a bien sa quete');

  const vue0 = g.questState(A).find((q) => q.id === mission.id);
  ok(vue0, 'la mission du jour figure dans les quetes');
  eq(vue0.progress, 0, 'a zero au depart');
  eq(vue0.claimable, false, 'et rien a reclamer');
  jete(() => g.claimQuest(A, mission.id), /not complete/, 'reclamer trop tot est refuse');

  /* On mise la moitie : la mission doit avancer sans s'ouvrir. */
  g._markWager(g._p(A), ethers.utils.parseUnits(String(mission.target / 2), cfg.DECIMALS), mission.jeu);
  const vue1 = g.questState(A).find((q) => q.id === mission.id);
  eq(vue1.progress, mission.target / 2, 'la mission avance a la mise');
  eq(vue1.claimable, false, 'mais ne s ouvre pas a moitie');

  /* Miser sur un AUTRE jeu ne doit pas la faire avancer : c'est tout l'objet
     de la mission. */
  const autre = cfg.MISSION_CATALOGUE.map((c) => c[0]).find((j) => j !== mission.jeu);
  g._markWager(g._p(A), ethers.utils.parseUnits(String(cfg.MISSION_MISE * 5), cfg.DECIMALS), autre);
  eq(g.questState(A).find((q) => q.id === mission.id).progress, mission.target / 2,
     'miser ailleurs ne la fait pas avancer d un jeton');

  g._markWager(g._p(A), ethers.utils.parseUnits(String(mission.target / 2), cfg.DECIMALS), mission.jeu);
  const vue2 = g.questState(A).find((q) => q.id === mission.id);
  eq(vue2.progress, mission.target, 'la mise atteinte la remplit');
  eq(vue2.claimable, true, 'et elle devient reclamable');

  const avant = Number(g.balanceStr(A));
  const gain = g.claimQuest(A, mission.id);
  eq(gain, mission.reward, 'elle rapporte ce qui etait annonce');
  pres(Number(g.balanceStr(A)) - avant, mission.reward, 1e-9, 'et le solde le recoit');
  jete(() => g.claimQuest(A, mission.id), /already claimed/, 'une seule fois par jour');

  /* La mission d'un AUTRE jour ne se reclame pas aujourd'hui, meme remplie :
     un identifiant garde de la veille ne doit rien payer. */
  /* Une quete qui n'est PAS au programme du jour ne paie pas, quel que soit
     l'avancement du compteur qu'elle lit. C'est ce qui empeche de garder un
     identifiant de la veille et de le rejouer. */
  const auProgramme = g.quetesDuJour(A).map((q) => q.id);
  const absente = (cfg.QUETES_POOL || []).map((q) => q.id).find((id) => auProgramme.indexOf(id) < 0);
  if (absente) {
    g._p(A).dropsToday = 9999; g._p(A).winsToday = 9999;
    jete(() => g.claimQuest(A, absente), /unknown quest/,
         'une quete hors programme ne paie pas, meme son compteur rempli');
  } else {
    ok(true, 'tout le pool est au programme aujourd hui');
  }
}

// ---------------------------------------------- le jour tourne, tout repart
{
  const g = new Game();
  riche(g, A, 5000000);
  g._p(A).hasDeposited = true;
  const mission = g.questState(A).find((q) => q.palier === 'jeu');
  g._markWager(g._p(A), ethers.utils.parseUnits(String(mission.target), cfg.DECIMALS), mission.jeu);
  g.claimQuest(A, mission.id);

  g._p(A).dayKey = '2020-01-01';           // on force le passage d'un jour
  g._bumpDay(g._p(A));
  eq(mise(g, A, mission.jeu), 0, 'la mise du jour repart de zero');
  const vue = g.questState(A).find((q) => q.id === mission.id);
  if (vue) eq(vue.claimed, false, 'et ce qui etait reclame ne l est plus');
  else ok(true, 'la mission d hier n est plus au programme');
}

// ------------------------------------------------ elle survit au redemarrage
{
  const g = new Game();
  riche(g, A, 5000000);
  g._markWager(g._p(A), ethers.utils.parseUnits('1234', cfg.DECIMALS), 'mines');
  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(mise(g2, A, 'mines'), 1234,
     'la mise du jour par jeu traverse une sauvegarde — sinon un redeploiement ' +
     'remettrait toutes les missions a zero en pleine journee');
}

// ============================================== 4. ca ne se ferme pas gratuitement
/* Le controle qui protege la caisse. Pour finir une mission il faut miser
   MISSION_MISE sur le jeu ; ce que la maison prend sur cette mise doit
   depasser LARGEMENT ce que la mission rend, sinon on paie quelqu'un pour ne
   rien risquer, et un fermier a portefeuilles jetables vit dessus.
   On prend l'avantage le PLUS FAIBLE du catalogue, pas la moyenne. */
{
  const AVANTAGE_MINIMAL = 0.025;   // blackjack ~2,6 % ; tout le reste est au-dessus
  const g = new Game();
  riche(g, A, 5000000);
  g._p(A).hasDeposited = true;
  const l = g.questState(A);
  const m = l.find((q) => q.palier === 'jeu');
  const preleve = m.target * AVANTAGE_MINIMAL;
  ok(preleve > m.reward * 3,
     `la maison prend ~${Math.round(preleve)} sur la mise exigee, la quete du jeu ` +
     `en rend ${m.reward} : au moins trois fois moins`);

  /* ET LA JOURNEE ENTIERE. C'est le controle qui compte : la refonte a fait
     passer le volume exige de 6 000 a ~2 000 en reduisant a cinq quetes, et
     laisser le gain intact aurait rendu la journee RENTABLE a elle seule.
     Le test l'a attrape avant la mise en ligne. */
  const totalJour = l.reduce((s, q) => s + q.reward, 0);
  ok(preleve > totalJour,
     `la journee entiere rend ${totalJour} pour ~${Math.round(preleve)} preleves sur la seule quete du jeu`);

  /* Le verrou du depot ne ferme plus les quetes — il ne retient que les
     JETONS. L'XP et le coffre du jour restent ouverts a tous, sinon la
     retention serait reservee a ceux qui sont deja clients. */
  ok(!cfg.QUEST_REQUIRE_DEPOSIT, 'les quetes ne sont plus fermees avant un depot');
  ok(cfg.QUETE_JETONS_APRES_DEPOT, 'mais les jetons, eux, attendent le premier depot');
}

console.log(`missions.test.js : ${n} verifications OK`);
