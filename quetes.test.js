'use strict';
/*
 * LES CINQ QUETES DU JOUR.
 *
 * Ce fichier tient trois choses qu'aucune signature ne protege :
 *
 *   1. LA SELECTION TOURNE. C'est la seule raison d'etre de la refonte, et
 *      c'est aussi la propriete la plus facile a casser sans s'en apercevoir —
 *      ma premiere version l'a fait, et huit jours de suite rendaient les
 *      memes quetes sans qu'aucune erreur ne soit levee.
 *   2. LE PREMIER JOUR EST FAISABLE. C'etait le defaut le plus cher de
 *      l'ancien systeme : un debutant a 100 jetons ne pouvait finir aucune
 *      des trois missions, qui en demandaient 2 000 chacune.
 *   3. RIEN DE GRATUIT. Une quete reclamee deux fois, une journee parfaite
 *      prise deux fois, un coffre au-dela du plafond global.
 */
const assert = require('assert');
const ethers = require('ethers');
const { Game } = require('./game');
const B = require('./boutique');
const cfg = require('./config');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const A = '0x' + 'a1'.repeat(20);
const jour = (g, d) => { g._today = () => d; const p = g._p(A); p.dayKey = d; };

const veteran = (g, addr) => {
  const p = g._p(addr);
  p.balance = WEI(50000); p.creeLe = Date.now() - 40 * 86400000;
  B.itemsDeSaison(1).slice(0, 8).forEach((o) => { p.objets[o.id] = 1; });
  p.filleuls = ['0x' + 'ff'.repeat(20)];
  return p;
};

// ================== 1. LA SELECTION TOURNE
{
  const g = new Game(); veteran(g, A);
  const jours = [];
  for (let d = 0; d < 12; d++) {
    const k = new Date(Date.UTC(2026, 0, 5 + d)).toISOString().slice(0, 10);
    jour(g, k);
    jours.push(g.quetesDuJour(A).map((q) => q.id));
  }
  eq(jours[0].length, cfg.QUETE_COMPO.length, `${jours[0].length} quetes par jour`);

  /* Aucune journee identique a la precedente. C'est le controle qui aurait
     attrape le pas modulaire nul : il rendait douze journees identiques. */
  let repets = 0;
  for (let i = 1; i < jours.length; i++)
    if (jours[i].join() === jours[i - 1].join()) repets++;
  eq(repets, 0, 'aucune journee n est la copie de la veille');

  /* Chaque palier doit VRAIMENT tourner, pas seulement l'ensemble. */
  cfg.QUETE_COMPO.forEach((palier, slot) => {
    const suite = jours.map((j) => j[slot]);
    const distinctes = new Set(suite).size;
    if (palier === 'jeu') {
      eq(distinctes, 1, 'le creneau du jeu du jour garde la meme quete — c est son role');
    } else {
      ok(distinctes >= 3, `le creneau ${palier} montre ${distinctes} quetes differentes sur douze jours`);
    }
  });

  /* Et le JEU du jour tourne, lui aussi. */
  const jeux = [];
  for (let d = 0; d < 8; d++) {
    jour(g, new Date(Date.UTC(2026, 0, 5 + d)).toISOString().slice(0, 10));
    jeux.push((g.quetesDuJour(A).find((q) => q.palier === 'jeu') || {}).jeu);
  }
  ok(new Set(jeux).size >= 6, `${new Set(jeux).size} jeux differents en huit jours`);

  /* Deux quetes identiques le meme jour : jamais. */
  jours.forEach((j, i) => { if (new Set(j).size !== j.length) ok(false, 'doublon le jour ' + i); });
  ok(true, 'aucun doublon a l interieur d une journee');
}

// ================== 2. LE PREMIER JOUR EST FAISABLE
{
  const g = new Game(); jour(g, '2026-01-05');
  const p = g._p(A);
  p.balance = WEI(cfg.WELCOME_BONUS);        // le credit d'essai, rien de plus
  p.creeLe = Date.now();
  const l = g.questState(A);

  ok(l.length >= 2, `${l.length} quetes proposees le premier jour`);
  eq(l.some((q) => q.palier === 'hard'), false, 'aucune Hard le premier jour');
  eq(l.some((q) => q.palier === 'elite'), false,
     'aucune Elite tant qu il ne possede aucun objet — une quete impossible apprend a ne pas lire la liste');

  const vol = l.find((q) => q.metric === 'mise' || q.metric === 'total');
  if (vol) {
    ok(vol.target <= Number(cfg.WELCOME_BONUS) * cfg.QUETE_CIBLE_MULT,
       `la cible de volume (${vol.target}) tient dans trois fois son credit, pas vingt fois`);
    ok(vol.target >= cfg.QUETE_CIBLE_MIN, `et reste au-dessus du plancher (${cfg.QUETE_CIBLE_MIN})`);
  }
  /* L'ancien systeme demandait 2 000 a quelqu'un qui en avait 100. */
  ok(!vol || vol.target < 2000, 'et elle n est PAS de 2 000, contrairement a l ancienne mission');

  eq(cfg.QUEST_REQUIRE_DEPOSIT, false, 'les quetes ne sont plus fermees avant le premier depot');
  eq(l.every((q) => !q.locked), true, 'aucune n est verrouillee');
}

// ================== 3. LES COMPTEURS MESURENT CE QU'ILS ANNONCENT
{
  const g = new Game(); jour(g, '2026-01-05'); veteran(g, A);
  const p = g._p(A);
  const prog = (metric, jeu) => g._queteProgres(p, { metric, jeu });

  p.miseJour = { plinko: 500, bj: 200, p4: 50 };
  eq(prog('jeux'), 3, 'trois jeux distincts');
  eq(prog('total'), 750, 'et 750 mises au total');
  eq(prog('duel'), 1, 'le Connect 4 compte comme un duel — il depose deja son identifiant');
  eq(prog('paris'), 0, 'aucun pari sportif');
  p.miseJour.paris = 100;
  eq(prog('paris'), 1, 'un pari sportif, oui');

  p.jourColl = { coffres: 2, neufs: 1, rarete: 3 };
  eq(prog('coffres'), 2, 'deux coffres ouverts');
  eq(prog('neufs'), 1, 'dont un objet jamais possede');
  ok(prog('rarete') >= 2, 'et un legendaire compte pour « rare ou mieux »');

  eq(prog('sortes'), 8, 'huit objets differents en collection');
  eq(prog('pleines'), 0, 'aucune famille complete');
  /* Une famille entiere, et le compteur la voit. */
  B.ITEMS.filter((o) => o.famille === 'chaos').forEach((o) => { p.objets[o.id] = 1; });
  eq(prog('pleines'), 1, 'une famille complete, une fois les cinq rangs poses');
}

// ================== 4. RIEN DE GRATUIT
{
  const g = new Game(); jour(g, '2026-01-05'); veteran(g, A);
  const p = g._p(A);
  p.hasDeposited = true;                    // sinon les jetons sont retenus
  p.dropsToday = 999; p.winsToday = 999;
  const q = g.questState(A).find((x) => x.claimable);
  ok(!!q, 'au moins une quete est reclamable');
  const xpAvant = g.niveau(A).xpGagne;
  const gain = g.claimQuest(A, q.id);
  eq(gain, q.reward, 'elle paie ce qu elle annonce en jetons');
  eq(g.niveau(A).xpGagne - xpAvant, q.xp, `et son XP de palier (${q.xp})`);
  assert.throws(() => g.claimQuest(A, q.id), /already claimed/); n++;
  assert.throws(() => g.claimQuest(A, 'nexistepas'), /unknown quest/); n++;

  /* Une quete d'HIER ne paie pas aujourd'hui. */
  jour(g, '2026-01-06');
  const hier = g.quetesDuJour(A).map((x) => x.id);
  jour(g, '2026-01-05');
  const aujourdhui = g.quetesDuJour(A).map((x) => x.id);
  const disparue = hier.find((id) => aujourdhui.indexOf(id) < 0);
  if (disparue) { assert.throws(() => g.claimQuest(A, disparue), /unknown quest/); n++; }
}

// ================== 5. LA JOURNEE PARFAITE
{
  const g = new Game(); jour(g, '2026-01-05'); veteran(g, A);
  const p = g._p(A);
  p.dropsToday = 999; p.winsToday = 999; p.miseJour = {};
  /* On force TOUT a etre fini, puis on reclame chaque quete. */
  g.quetesDuJour(A).forEach((q) => { p.questClaimed[q.id] = true; });

  const e = g.parfaitEtat(A);
  eq(e.faites, e.total, `les ${e.total} quetes du jour sont reclamees`);
  eq(e.pret, true, 'la journee parfaite est prete');

  const inv0 = Object.values(p.objets).reduce((a, b) => a + b, 0);
  const xp0 = g.niveau(A).xpGagne;
  const r = g.reclameParfait(A);
  eq(r.plafonne, false, 'sous le plafond, le coffre part');
  ok(!!r.gagne && !!r.gagne.item, `et il rend un objet (${r.gagne.item.nom})`);
  eq(Object.values(p.objets).reduce((a, b) => a + b, 0) - inv0, 1, 'un objet de plus dans l inventaire');
  eq(g.niveau(A).xpGagne - xp0 >= cfg.PARFAIT_XP, true, 'et l XP de la journee parfaite');
  assert.throws(() => g.reclameParfait(A), /already claimed/); n++;

  /* LE PLAFOND GLOBAL. Sans lui, cinq cents joueurs brulent l edition en
     dix-neuf jours — et personne ne s en apercoit avant qu il soit trop tard. */
  const g2 = new Game(); jour(g2, '2026-01-05');
  /* Le compteur est desormais COMMUN aux deux sources de coffres gratuits :
     le coffre du jour et la journee parfaite sortent de la meme edition. */
  g2.coffresGratuits = cfg.COFFRES_GRATUITS_JOUR; g2.coffresGratuitsJour = '2026-01-05';
  const B2 = '0x' + 'b2'.repeat(20);
  const q2 = veteran(g2, B2); q2.dayKey = '2026-01-05';
  g2.quetesDuJour(B2).forEach((q) => { q2.questClaimed[q.id] = true; });
  const inv1 = Object.values(q2.objets).reduce((a, b) => a + b, 0);
  const r2 = g2.reclameParfait(B2);
  eq(r2.plafonne, true, 'au-dela du plafond, le coffre ne part plus');
  eq(Object.values(q2.objets).reduce((a, b) => a + b, 0), inv1, 'et rien n est sorti de l edition');
  ok(r2.xp > 0, 'mais l XP est payee quand meme — le joueur a fait le travail');
}

// ================== 6. L ECONOMIE TIENT
{
  const g = new Game(); jour(g, '2026-01-05'); veteran(g, A);
  g._p(A).hasDeposited = true;
  const l = g.questState(A);
  const jetons = l.reduce((a, q) => a + q.reward, 0);
  const xp = l.reduce((a, q) => a + q.xp, 0);
  console.log(`  une journee parfaite : ${jetons} $SWOGE + ${xp} XP + ${cfg.PARFAIT_XP} XP de bonus`);
  /* Le volume a miser pour tout finir, au plus juste : la quete du jeu du
     jour a elle seule. L'avantage de la maison le plus faible du catalogue
     (blackjack, 2,6 %) doit rester au-dessus de ce qu'on distribue. */
  const volume = (l.find((q) => q.palier === 'jeu') || { target: 0 }).target;
  const marge = volume * 0.026;
  console.log(`  ${volume} $SWOGE a miser -> ~${Math.round(marge)} d esperance de perte contre ${jetons} distribues`);
  ok(marge > jetons, `l anti-farming tient : ${Math.round(marge)} > ${jetons}`);
  ok(jetons <= 40, `et le total en jetons reste modeste (${jetons})`);

  /* Et sans depot, AUCUN jeton — mais toute l'XP. C'est ce qui rend une
     adresse jetable sans interet tout en gardant la retention ouverte. */
  const B3 = '0x' + 'd4'.repeat(20);
  const p3 = veteran(g, B3); p3.dayKey = '2026-01-05'; p3.hasDeposited = false;
  const l3 = g.questState(B3);
  eq(l3.reduce((a, q) => a + q.reward, 0), 0, 'sans depot : zero jeton');
  eq(l3.reduce((a, q) => a + q.xp, 0), xp, 'mais exactement la meme XP');
  eq(l3.every((q) => !q.locked), true, 'et rien n est verrouille — les quetes se font');
}

console.log(`quetes.test.js : ${n} verifications OK`);
