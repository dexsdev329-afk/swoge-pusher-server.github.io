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

const du = (g, a) => Number(g.parrainage(a).du);
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
  pres(du(g, A), 100, 'dix pour cent des pertes nettes du filleul');

  /* Le filleul remporte un gros coup : le revenu qu'il a rapporte repasse
     dans le rouge, de 1000 a -1000. La ligne d'eau, elle, reste a 1000. */
  manche(g, B, 1000, 3000);
  pres(du(g, A), 100, 'le filleul gagne : le parrain ne touche RIEN de plus');
  ok(du(g, A) >= 0, 'et surtout, il ne doit rien — on ne reprend jamais ce qui est verse');

  manche(g, B, 1000, 0);                       // cumul : -1000 → 0
  pres(du(g, A), 100, 'il reperd : toujours rien, on est encore sous la ligne d eau');
  manche(g, B, 1000, 0);                       // cumul : 0 → 1000, pile la ligne
  pres(du(g, A), 100, 'pile a la ligne d eau non plus');

  manche(g, B, 1000, 0);                       // cumul : 1000 → 2000
  pres(du(g, A), 200, 'au-dela seulement, la part reprend — et sur le seul depassement');
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
  eq(du(g, A), 0, 'il a beau tout perdre, le parrain ne touche rien');
  g._p(B).hasDeposited = true;
  manche(g, B, 1000, 0);
  pres(du(g, A), 100, 'et la part ne commence qu au premier depot reel');
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
  const apresPerte = du(g, A);
  pres(apresPerte, 10000 * (cfg.REFERRAL_PVP_BPS / 10000) * (cfg.REFERRAL_BPS / 10000),
       'en 1v1, la part porte sur une fraction de la mise, pas sur la perte');

  manche(g, B, 10000, 20000, 'p4');            // il gagne la suivante
  ok(du(g, A) > apresPerte, 'et elle tombe aussi quand le filleul GAGNE : c est la commission qui la porte');

  /* La comparaison qui compte : la meme mise contre la banque rapporte
     beaucoup plus. Un jeu ou l'argent circule entre joueurs ne peut pas
     rapporter autant qu'un jeu ou il va a la maison. */
  const g2 = neuf();
  g2.lieParrain(B, A);
  manche(g2, B, 10000, 0);
  ok(du(g2, A) > du(g, A) * 5, 'perdre 10 000 contre la banque rapporte bien plus que 10 000 mises en 1v1');
}

// ------------------------------------------------------- l encaissement
{
  const g = neuf();
  g.lieParrain(B, A);
  manche(g, B, 5000, 0);
  const avant = sol(g, A);
  const r = g.reclameParrainage(A);
  pres(Number(r.montant), 500, 'le parrain encaisse ce qui lui est du');
  pres(sol(g, A) - avant, 500, 'et son solde monte d autant');
  eq(du(g, A), 0, 'le compteur retombe a zero');
  jete(() => g.reclameParrainage(A), /nothing to claim/, 'encaisser deux fois : refuse');
  pres(Number(g.parrainage(A).total), 500, 'le total gagne, lui, reste');
}

// ------------------------------------------- le cadeau du filleul
{
  const g = new Game();
  g.lieParrain(B, A);
  const avant = sol(g, B);
  g.creditDeposit({ player: B, amount: ethers.utils.parseUnits('1000', cfg.DECIMALS), tx: '0x1' });
  pres(sol(g, B) - avant, 1000 + Number(cfg.REFERRAL_WELCOME), 'le filleul recoit son cadeau au premier depot');
  g.creditDeposit({ player: B, amount: ethers.utils.parseUnits('1000', cfg.DECIMALS), tx: '0x2' });
  pres(sol(g, B) - avant, 2000 + Number(cfg.REFERRAL_WELCOME), 'une seule fois, pas a chaque depot');

  const g2 = new Game();
  g2.creditDeposit({ player: C, amount: ethers.utils.parseUnits('1000', cfg.DECIMALS), tx: '0x3' });
  eq(sol(g2, C), 1000, 'et personne ne le touche sans parrain');
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
  pres(Number(g2.parrainage(A).du), 300, 'et ce qui lui est du aussi');
  manche(g2, B, 1000, 0);
  pres(Number(g2.parrainage(A).du), 400, 'la part continue de tomber, sans repartir de zero');
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
