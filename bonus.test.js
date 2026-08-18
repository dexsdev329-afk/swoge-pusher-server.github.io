'use strict';
/*
 * L'echelle de connexion et les quetes du jour.
 *
 * Ce sont des fonctionnalites qu'on croit trop simples pour les verifier, et
 * c'est exactement pour ca qu'elles cassent en silence : personne ne peut
 * ATTENDRE UN JOUR pour essayer. Ici la journee est un parametre, donc on
 * traverse une semaine en trois lignes.
 *
 * Le controle qui compte : ce que le joueur RECOIT doit valoir exactement ce
 * que l'echelle annonce, et une journee ne doit jamais payer deux fois.
 */
const assert = require('assert');
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sol = (g, a) => Number(g.balanceStr(a));

/** Le jour UTC decale de n jours — la meme cle que celle du serveur. */
const jour = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/* On ne peut pas attendre minuit : on recule la DERNIERE reclamation, ce qui
   revient exactement au meme du point de vue du code, qui ne compare que des
   cles de journee. */
function avance(g, addr, jours) {
  const p = g._p(addr);
  if (p.streakLastClaimDay) {
    const d = new Date(p.streakLastClaimDay + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - jours);
    p.streakLastClaimDay = d.toISOString().slice(0, 10);
  }
}

// ------------------------------------------- l'echelle monte, jour apres jour
{
  const g = new Game();
  const R = cfg.STREAK_REWARDS, N = R.length;
  ok(N >= 2, `l'echelle a ${N} paliers`);

  let recu = 0;
  for (let i = 0; i < N; i++) {
    const etat = g.streakState(A);
    eq(etat.day, i + 1, `au ${i + 1}e passage, le palier annonce est ${i + 1}`);
    eq(etat.claimable, true, 'et il est reclamable');
    eq(etat.todayReward, R[i], `la recompense annoncee vaut ${R[i]}`);
    const r = g.claimStreak(A);
    eq(r.reward, R[i], `la recompense versee vaut ${R[i]}`);
    recu += r.reward;
    avance(g, A, 1);
  }
  eq(sol(g, A), recu, `le solde vaut la somme des paliers (${recu})`);

  // et l'echelle reboucle sur le premier palier
  eq(g.streakState(A).day, 1, `apres ${N} paliers, on repart au premier`);
}

// ------------------------------------------------ une journee ne paie qu'une fois
{
  const g = new Game();
  const premier = g.claimStreak(A);
  eq(premier.day, 1, 'premiere reclamation : palier 1');
  eq(g.streakState(A).claimedToday, true, 'la journee est marquee');
  eq(g.streakState(A).claimable, false, 'le bouton ne propose plus rien');
  jete(() => g.claimStreak(A), /already claimed today/, 'et une seconde reclamation est refusee');
  const avant = sol(g, A);
  try { g.claimStreak(A); } catch (e) { /* attendu */ }
  eq(sol(g, A), avant, 'le solde n a pas bouge');
}

// -------------------------------------- UN TROU NE REMET PAS L ECHELLE A ZERO
/* Le defaut signale : on reclame le palier 1, on saute un jour, et le
   lendemain le jeu repropose le palier 1. Le joueur clique, touche 1 au lieu
   de 2, et conclut que la reclamation ne marche pas. Elle marchait — c'est
   l'echelle qui reculait. */
{
  const R = cfg.STREAK_REWARDS;
  for (const ecart of [1, 2, 3, 9, 40]) {
    const g = new Game();
    g.claimStreak(A);                 // palier 1
    avance(g, A, ecart);              // on revient `ecart` jours plus tard
    const etat = g.streakState(A);
    eq(etat.day, 2, `apres ${ecart} jour(s) d absence, on est au palier 2`);
    eq(etat.todayReward, R[1], `et il paie ${R[1]}, pas ${R[0]}`);
    eq(g.claimStreak(A).reward, R[1], 'ce qui est verse correspond');
  }
}

// ------------------------------------ les quetes du jour comptent tous les jeux
/* Une manche de Connect 4 doit faire avancer les quetes comme n'importe quelle
   autre mise : c'est le compteur `dropsToday`, et le Connect 4 etait le seul
   jeu a ne pas l'incrementer. */
{
  const g = new Game();
  const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  for (const a of [A, B]) g._p(a).balance = ethers.utils.parseUnits('100000', cfg.DECIMALS);
  const avant = g._p(A).dropsToday || 0;
  const m = g.p4Creer(A, 100, 1000);
  eq((g._p(A).dropsToday || 0) - avant, 1, 'ouvrir une table compte pour une manche');
  g.p4Rejoindre(B, m.id, 2000);
  eq(g._p(B).dropsToday || 0, 1, 's asseoir aussi');

  /* La quete au compteur de manches n'est plus fixe : elle sort du pool du
     jour. On la cherche donc dans les quetes REELLES, et on ne conclut que si
     le jour en propose une. */
  const vue = g.questState(A).find((q) => q.metric === 'drops');
  if (vue) eq(vue.progress, 1, `la quete « ${vue.label} » avance de la partie jouee`);
  else ok(true, 'aucune quete au compteur de manches ce jour-la');
}

// --------------------------------------------- les quetes demandent un depot
{
  const g = new Game();
  const q = g.questState(A);
  if (cfg.QUEST_REQUIRE_DEPOSIT) {
    ok(q.every((x) => x.locked), 'sans depot, les quetes sont verrouillees');
    ok(q.every((x) => !x.claimable), 'et aucune n est reclamable');
    jete(() => g.claimQuest(A, q[0].id), /deposit first/, 'la reclamation le dit clairement');
    g._p(A).hasDeposited = true;
    const q2 = g.questState(A);
    ok(q2.every((x) => !x.locked), 'apres un depot, elles se deverrouillent');
    const libre = q2.find((x) => x.claimable);
    ok(libre, 'et celle qui est deja remplie devient reclamable');
    const avant = sol(g, A);
    const gain = g.claimQuest(A, libre.id);
    eq(sol(g, A) - avant, gain, 'ce qui est verse correspond a la recompense');
    jete(() => g.claimQuest(A, libre.id), /already claimed/, 'une quete ne paie qu une fois');
  } else {
    /* ---- LE VERROU A CHANGE DE NATURE ----
     *
     * Il fermait TOUT avant le premier depot, donc il eteignait la retention
     * pour ceux qu'on cherche a garder. Il ne retient plus que les JETONS :
     * les quetes se font, l'XP se gagne, et une adresse jetable ne rapporte
     * rien qui se retire. */
    ok(q.every((x) => !x.locked), 'les quetes sont ouvertes sans depot');
    if (cfg.QUETE_JETONS_APRES_DEPOT) {
      ok(q.every((x) => x.reward === 0), 'mais elles ne paient aucun jeton avant le premier depot');
      ok(q.every((x) => x.xp > 0), 'alors qu elles paient toute leur XP');
      ok(q.some((x) => x.recompenseBloquee), 'et la page peut le dire, le champ est la');
      g._p(A).hasDeposited = true;
      const q2 = g.questState(A);
      ok(q2.some((x) => x.reward > 0), 'apres un depot, les jetons apparaissent');
    }
  }
}

console.log(`bonus.test.js : ${n} verifications OK`);
