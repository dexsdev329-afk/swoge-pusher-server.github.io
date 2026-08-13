'use strict';
/*
 * Le parrainage.
 *
 * Un programme de parrainage est une machine a fabriquer de l'argent pour qui
 * trouve la faille : c'est la fonctionnalite la plus attaquee d'un casino, et
 * de loin. Les verifications qui comptent ne sont donc pas « le parrain
 * touche bien sa part » mais celles-ci :
 *
 *   • se parrainer soi-meme avec un deuxieme compte doit etre PERDANT ;
 *   • un filleul qui gagne ne doit mettre personne en dette ;
 *   • un compte vide qui n'a jamais depose ne doit rien rapporter ;
 *   • et l'attache doit valoir pour la vie, sinon deux parrains se disputent
 *     le meme filleul.
 *
 * La part porte sur le REVENU reel — les pertes nettes contre la banque, une
 * fraction de la mise en un-contre-un. C'est ce choix, et lui seul, qui rend
 * la premiere verification vraie sans aucune regle anti-triche.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-parrain-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, m, eps) => { ok(Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps), `${m} (${a} ≈ ${b})`); };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';   // le parrain
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';   // le filleul
const C = '0xcccccccccccccccccccccccccccccccccccccccc';

const du = (g, a) => Number(g.parrainage(a).du);          // encaissable tout de suite
const attente = (g, a) => Number(g.parrainage(a).attente); // pas encore mur
/* Le delai se mesure en jours : on vieillit les seaux plutot que d'attendre
   une semaine. C'est la seule facon de verifier une regle de temps. */
const vieillit = (g, f, jours) => { for (const x of (g._p(f).attente || [])) x[0] -= jours; };
const sol = (g, a) => Number(g.balanceStr(a));

function neuf() {
  const g = new Game();
  for (const a of [A, B, C]) {
    const p = g._p(a);
    p.balance = ethers.utils.parseUnits('100000', cfg.DECIMALS);
    p.hasDeposited = true;
  }
  return g;
}
/* Une manche contre la banque : mise posee, retour rendu. C'est le seul point
   de passage de tous les jeux — donc le seul endroit ou le revenu se compte. */
const manche = (g, a, mise, rendu, jeu) => g._manche(g._p(a), jeu || 'plinko', mise, rendu);

// ------------------------------------------------------ l attache du lien
{
  const g = neuf();
  g.setPublicName(A, 'Le Parrain');
  eq(g.codeParrain(A), 'Le Parrain', 'le lien porte le NOM choisi : on le partage de vive voix');
  eq(g.codeParrain(C), C.slice(2, 10), 'sans nom choisi, huit caracteres de l adresse');

  jete(() => g.lieParrain(A, 'Le Parrain'), /yourself/, 'se parrainer soi-meme : refuse');
  jete(() => g.lieParrain(B, 'personne'), /no such invite code/, 'un code inconnu : refuse');

  eq(g.lieParrain(B, 'le parrain').parrain, A, 'le code se retrouve sans la casse');
  jete(() => g.lieParrain(B, C), /already have a sponsor/, 'on ne change pas de parrain');
  eq(g.parrainage(A).filleuls.length, 1, 'le parrain voit son filleul');
  eq(g.parrainage(B).parrain.name, 'Le Parrain', 'et le filleul voit son parrain');

  g.lieParrain(C, A);
  jete(() => g.lieParrain(A, C), /each other/, 'et deux joueurs ne se parrainent pas mutuellement');
}

// ------------------------------------- ce que le parrain touche vraiment
{
  const g = neuf();
  g.lieParrain(B, A);
  eq(du(g, A), 0, 'au depart, rien');

  manche(g, B, 1000, 0);                       // le filleul perd 1000
  pres(attente(g, A), 100, 'dix pour cent des pertes nettes du filleul');
  eq(du(g, A), 0, 'mais en ATTENTE : rien n est encaissable tout de suite');

  vieillit(g, B, cfg.REFERRAL_HOLD_DAYS + 1);
  pres(du(g, A), 100, 'le delai passe, la part devient encaissable');

  /* Le filleul remporte un gros coup APRES la maturite : le revenu qu'il a
     rapporte repasse dans le rouge, mais ce qui est mur est acquis. */
  manche(g, B, 1000, 3000);
  pres(du(g, A), 100, 'le filleul gagne : on ne reprend RIEN de ce qui a muri');
  eq(attente(g, A), 0, 'et il n y a plus rien en attente');

  manche(g, B, 1000, 0);                       // cumul : -1000 → 0
  eq(attente(g, A), 0, 'il reperd : toujours rien, on est encore sous la ligne d eau');
  manche(g, B, 1000, 0);                       // cumul : 0 → 1000, pile la ligne
  eq(attente(g, A), 0, 'pile a la ligne d eau non plus');

  manche(g, B, 1000, 0);                       // cumul : 1000 → 2000
  pres(attente(g, A), 100, 'au-dela seulement, la part reprend — et sur le seul depassement');
  pres(du(g, A), 100, 'sans toucher a ce qui etait deja mur');
}

// ------------------------------- le delai de sept jours, et a quoi il sert
/*
 * SANS LE DELAI : une part est versee des la manche perdue par le filleul. Si
 * le filleul reprend tout le lendemain, la maison a paye sur un revenu
 * qu'elle n'a plus. Avec le delai, le gain reste en attente et REDESCEND si le
 * filleul se refait dans l'intervalle.
 */
{
  const g = neuf();
  g.lieParrain(B, A);

  manche(g, B, 10000, 0);                      // le filleul perd gros
  pres(attente(g, A), 1000, 'la part est en attente');
  eq(du(g, A), 0, 'et rien n est encaissable');
  jete(() => g.reclameParrainage(A), /nothing to claim/, 'impossible de l encaisser avant terme');

  manche(g, B, 10000, 20000);                  // il se refait le lendemain
  eq(attente(g, A), 0, 'le filleul se refait : l attente retombe a zero');
  eq(du(g, A), 0, 'et la maison n a rien paye sur un revenu qu elle n a plus');

  /* Il reperd la meme somme : le revenu cumule remonte a 10 000, et la part
     revient — au bon montant, pas au double. */
  manche(g, B, 10000, 0);
  pres(attente(g, A), 1000, 'quand il reperd, la part revient — au bon montant');
}

// -------------------------- ce qui a muri ne se reprend jamais
{
  const g = neuf();
  g.lieParrain(B, A);
  manche(g, B, 10000, 0);
  vieillit(g, B, cfg.REFERRAL_HOLD_DAYS + 1);
  pres(du(g, A), 1000, 'mur apres le delai');
  const r = g.reclameParrainage(A);
  pres(Number(r.montant), 1000, 'encaisse');
  manche(g, B, 10000, 30000);                  // le filleul explose la banque
  eq(du(g, A), 0, 'plus rien a encaisser');
  eq(attente(g, A), 0, 'ni en attente');
  pres(sol(g, A), 100000 + 1000, 'mais le parrain garde ce qu il a encaisse : on ne reprend pas');
}

// -------------------------------- un compte qui n a jamais depose : rien
/*
 * Sans cette barriere, ouvrir cent portefeuilles jetables, les parrainer tous
 * et leur faire jouer le bonus de bienvenue suffirait a se payer.
 */
{
  const g = new Game();
  g._p(A).balance = ethers.utils.parseUnits('1000', cfg.DECIMALS);
  g._p(B).balance = ethers.utils.parseUnits('1000', cfg.DECIMALS);
  g.lieParrain(B, A);
  eq(g._p(B).hasDeposited, false, 'le filleul n a jamais depose');
  manche(g, B, 1000, 0);
  eq(attente(g, A) + du(g, A), 0, 'il a beau tout perdre, le parrain ne touche rien');
  g._p(B).hasDeposited = true;
  manche(g, B, 1000, 0);
  pres(attente(g, A), 100, 'et la part ne commence qu au premier depot reel');
}

// --------------------------------- se parrainer soi-meme est PERDANT
/*
 * C'EST LA VERIFICATION QUI JUSTIFIE TOUT LE MODELE. Un pourcentage sur les
 * DEPOTS se contourne en une minute : je depose, je retire, je recommence, et
 * je me paie sans que la maison ait gagne un jeton. Un pourcentage sur le
 * REVENU ne se contourne pas — pour se verser dix pour cent de ses pertes, il
 * faut d'abord les perdre.
 */
{
  const g = neuf();
  g.lieParrain(B, A);                          // A et B sont la meme personne
  const avant = sol(g, A) + sol(g, B);

  // le deuxieme compte joue et perd, comme n'importe quel joueur
  let perdu = 0;
  for (let i = 0; i < 20; i++) { manche(g, B, 1000, 0); perdu += 1000; }
  g._p(B).balance = g._p(B).balance.sub(ethers.utils.parseUnits(String(perdu), cfg.DECIMALS));
  vieillit(g, B, cfg.REFERRAL_HOLD_DAYS + 1);
  g.reclameParrainage(A);

  const apres = sol(g, A) + sol(g, B);
  pres(apres - avant, -perdu * (1 - cfg.REFERRAL_BPS / 10000), 'les deux comptes reunis ont PERDU', 1e-3);
  ok(apres < avant, `se parrainer soi-meme coute ${(avant - apres).toFixed(0)} $SWOGE : c est perdant`);
}

// ----------------------------------- le un-contre-un ne se fabrique pas
/*
 * En Connect 4 ou au poker, l'argent va d'un joueur a l'autre : les pertes de
 * l'un sont les gains de l'autre, et la maison ne prend qu'une commission.
 * Compter les pertes nettes y serait une invitation — deux comptes complices
 * qui se renvoient la balle fabriqueraient du revenu sans fin. On ne compte
 * donc qu'une petite fraction de la mise, gagnee ou perdue.
 */
{
  const g = neuf();
  g.lieParrain(B, A);
  manche(g, B, 10000, 0, 'p4');                // il perd la partie
  const apresPerte = attente(g, A);
  pres(apresPerte, 10000 * (cfg.REFERRAL_PVP_BPS / 10000) * (cfg.REFERRAL_BPS / 10000),
       'en 1v1, la part porte sur une fraction de la mise, pas sur la perte');

  manche(g, B, 10000, 20000, 'p4');            // il gagne la suivante
  ok(attente(g, A) > apresPerte, 'et elle tombe aussi quand le filleul GAGNE : c est la commission qui la porte');

  /* La comparaison qui compte : la meme mise contre la banque rapporte
     beaucoup plus. Un jeu ou l'argent circule entre joueurs ne peut pas
     rapporter autant qu'un jeu ou il va a la maison. */
  const g2 = neuf();
  g2.lieParrain(B, A);
  manche(g2, B, 10000, 0);
  ok(attente(g2, A) > attente(g, A) * 5,
     'perdre 10 000 contre la banque rapporte bien plus que 10 000 mises en 1v1');
}

// ------------------------------------------------------- l encaissement
{
  const g = neuf();
  g.lieParrain(B, A);
  manche(g, B, 5000, 0);
  vieillit(g, B, cfg.REFERRAL_HOLD_DAYS + 1);
  const avant = sol(g, A);
  const r = g.reclameParrainage(A);
  pres(Number(r.montant), 500, 'le parrain encaisse ce qui lui est du');
  pres(sol(g, A) - avant, 500, 'et son solde monte d autant');
  eq(du(g, A), 0, 'le compteur retombe a zero');
  jete(() => g.reclameParrainage(A), /nothing to claim/, 'encaisser deux fois : refuse');
  pres(Number(g.parrainage(A).total), 500, 'le total gagne, lui, reste');
}

// ------------------------------------------- le cadeau du filleul
/*
 * CE QUI ETAIT OUVERT : le cadeau partait au premier depot, QUEL QUE SOIT LE
 * MONTANT. Cent portefeuilles jetables, un jeton depose avec chacun, cent
 * cadeaux — un depot reel mais derisoire, et l'operation etait rentable.
 *
 * Deux verrous ferment la porte, et il faut les deux : le depot minimum rend
 * l'entree chere, la mise a atteindre rend la SORTIE couteuse. Le premier
 * seul ne ferait que deplacer le prix ; le second seul laisserait entrer
 * n'importe qui.
 */
{
  const MIN = cfg.REFERRAL_WELCOME_MIN, CADEAU = Number(cfg.REFERRAL_WELCOME);
  const depose = (g, qui, montant, tx) =>
    g.creditDeposit({ player: qui, amount: ethers.utils.parseUnits(String(montant), cfg.DECIMALS), tx });

  // --- le recolteur : il depose le minimum syndical
  {
    const g = new Game();
    g.lieParrain(B, A);
    depose(g, B, 1, '0x1');
    pres(sol(g, B), 1, 'un depot derisoire ne donne AUCUN cadeau');
    ok(MIN >= CADEAU * 10, `le depot minimum (${MIN}) vaut au moins dix fois le cadeau (${CADEAU})`);
  }

  // --- le vrai joueur : il depose pour de bon
  {
    const g = new Game();
    g.lieParrain(B, A);
    depose(g, B, MIN, '0x2');
    pres(sol(g, B), MIN + CADEAU, 'au-dela du minimum, le cadeau tombe');
    depose(g, B, MIN, '0x3');
    pres(sol(g, B), MIN * 2 + CADEAU, 'une seule fois, pas a chaque depot');

    // ... mais il ne peut pas repartir avec sans avoir joue
    const p = g._p(B);
    ok(p.bonusBloque.gt(0), 'le cadeau est dans le solde mais BLOQUE');
    jete(() => g.requestWithdraw(B, String(MIN * 2 + CADEAU)), /unlock your referral gift/,
         'retirer le tout avant d avoir joue : refuse');
    g.requestWithdraw(B, String(MIN * 2));
    pres(sol(g, B), CADEAU, 'mais son PROPRE argent sort sans entrave');

    /* LE VERROU QUI COMPTE : il ne se leve pas sur du volume — qui se
       contournerait par le jeu le moins cher — mais quand LA MAISON A GAGNE
       le montant du cadeau sur ce joueur. */
    manche(g, B, CADEAU / 2, 0);
    ok(g._p(B).bonusBloque.gt(0), 'la maison a gagne la moitie du cadeau : toujours bloque');
    manche(g, B, CADEAU / 2, 0);
    eq(g._p(B).bonusBloque.toString(), '0',
       'la maison a gagne le cadeau entier : il se debloque');
    pres(Number(g.parrainage(B).bloque), 0, 'et plus rien n est retenu');
  }

  // --- pourquoi la recolte est PERDANTE, et pas seulement penible
  /*
   * Un simple volume a miser se contourne : vingt mille mises au blackjack,
   * dont l'avantage maison est d'un demi pour cent, ne coutent que cent — pour
   * un cadeau de cinq cents. La recolte resterait rentable.
   *
   * Ici le verrou ne porte pas sur le volume mais sur le RESULTAT : pour
   * sortir cinq cents, il faut en avoir fait perdre cinq cents. Quel que soit
   * le jeu, quelle que soit la mise, l'operation est nulle au mieux.
   */
  {
    const g = new Game();
    g.lieParrain(B, A);
    depose(g, B, MIN, '0xf1');
    const p = g._p(B);
    // il joue au jeu le moins cher, longtemps, et gagne meme un peu
    for (let i = 0; i < 200; i++) manche(g, B, 1000, 1000);
    ok(p.bonusBloque.gt(0),
       '200 000 mises sans rien perdre ne debloquent rien : le volume ne suffit pas');
    eq(attente(g, A) + du(g, A), 0, 'et le parrain n a rien touche non plus');
  }

  // --- la sortie de secours du joueur chanceux
  /* Celui qui gagne ne doit pas rester bloque a vie : au-dela de deux cents
     fois le cadeau mise, le compte est de toute facon largement rentable. */
  {
    const g = new Game();
    g.lieParrain(B, A);
    depose(g, B, MIN, '0xf2');
    g._markWager(g._p(B), ethers.utils.parseUnits(
      String(CADEAU * cfg.REFERRAL_WELCOME_ROLLOVER), cfg.DECIMALS));
    eq(g._p(B).bonusBloque.toString(), '0',
       `${CADEAU * cfg.REFERRAL_WELCOME_ROLLOVER} mises debloquent le joueur chanceux`);
  }

  const g2 = new Game();
  depose(g2, C, MIN, '0x9');
  eq(sol(g2, C), MIN, 'et sans parrain, personne ne touche rien');
}

// ------------------------------------------- ca survit au redemarrage
{
  const g = neuf();
  g.setPublicName(A, 'Le Parrain');
  g.lieParrain(B, 'Le Parrain');
  manche(g, B, 3000, 0);

  const g2 = new Game();
  g2.hydrate(g.serialize());
  eq(g2.parrainage(A).filleuls.length, 1, 'le filleul est toujours la apres redemarrage');
  pres(attente(g2, A), 300, 'et ce qui mûrit pour lui aussi');
  manche(g2, B, 1000, 0);
  pres(attente(g2, A), 400, 'la part continue de tomber, sans repartir de zero');
  vieillit(g2, B, cfg.REFERRAL_HOLD_DAYS + 1);
  pres(du(g2, A), 400, 'et le delai court depuis la manche, pas depuis le redemarrage');
}

// ------------------------------------------------------ les statistiques
/* Elles se recalculent depuis ce qui est deja compte : une statistique qui
   aurait sa propre source finirait par contredire l'historique affiche juste
   en dessous, et c'est l'historique qu'on croit. */
{
  const g = neuf();
  manche(g, A, 100, 0, 'plinko');
  manche(g, A, 100, 900, 'plinko');
  manche(g, A, 50, 0, 'mines');
  const s = g.stats(A);
  eq(s.manches, 3, 'trois manches comptees');
  pres(s.mise, 250, 'le total mise');
  pres(s.net, 650, 'et le resultat net');
  eq(s.favoris[0].jeu, 'plinko', 'le jeu le plus joue arrive en tete');
  pres(s.record.g, 800, 'le plus gros gain est retenu');
  pres(s.record.x, 9, 'avec son multiplicateur');
  eq(s.record.j, 'plinko', 'et le jeu ou il est tombe');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`parrainage.test.js : ${n} verifications OK`);
});
