'use strict';
/*
 * Le plafond de staking.
 *
 * ---- pourquoi un plafond, et pas une simple surveillance ----
 *
 * A 100 % l'an, chaque jeton mis en staking engage le coffre a en rendre DEUX
 * dans un an. Cette dette ne se voit pas le jour ou elle est contractee : elle
 * se voit douze mois plus tard. Un seul gros porteur qui arrive avec cinquante
 * millions engage donc cinquante millions de plus, et personne ne s'en rend
 * compte a temps.
 *
 * Le plafond met une borne CONNUE D'AVANCE : vingt pour cent de l'offre au
 * maximum en staking, donc vingt pour cent de l'offre de rendement au maximum
 * sur l'annee. C'est un chiffre qu'on peut budgeter.
 *
 * ---- ce qui est verifie ----
 *
 * Qu'on ne puisse PAS depasser (par un gros depot, ni par mille petits), que
 * le refus ne coute pas un jeton au joueur, que la place se LIBERE quand
 * quelqu'un sort, et que le chiffre affiche ne dise jamais « plein » quand il
 * reste de la place.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-plafond-'));
process.env.DATA_DIR = bac;
process.env.STAKE_CAP_BPS = '2000';
process.env.TOKEN_SUPPLY = '1000000000';
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const adr = (i) => '0x' + i.toString(16).padStart(40, '0');
const riche = (g, i, montant) => { const p = g._p(adr(i)); p.balance = WEI(montant); p.hasDeposited = true; return adr(i); };

/* Ce fichier teste le plafond GLOBAL — celui de la salle. Le plafond par
   PORTEFEUILLE, arrive apres, est teste dans plafond_joueur.test.js et
   empecherait ici de remplir la salle depuis un seul compte, ce qui
   masquerait ce qu'on veut voir. On le neutralise donc explicitement autour
   des blocs qui remplissent la salle d'un coup, plutot que de repartir les
   mises sur cent portefeuilles et de rendre chaque bloc illisible. */
function sansPlafondJoueur(f) {
  const avant = cfg.STAKE_CAP_JOUEUR_BPS;
  cfg.STAKE_CAP_JOUEUR_BPS = 0;
  try { return f(); } finally { cfg.STAKE_CAP_JOUEUR_BPS = avant; }
}

// ============================== le plafond vaut ce qu'il annonce
{
  const g = new Game();
  const c = g.capaciteStaking();
  eq(c.plafond, 200000000, 'le plafond vaut 20 % de l offre — 200 millions');
  eq(c.partOffre, 20, 'et il se presente comme tel');
  eq(c.libre, 200000000, 'tout est libre au depart');
  eq(c.plein, false, 'et rien n est plein');
}

// ============================== on ne passe pas au-dessus, en une fois
sansPlafondJoueur(() => {
  const g = new Game();
  const a = riche(g, 1, 300000000);
  jete(() => g.stake(a, '250000000'), /room left in the staking pool/,
       'une demande plus grosse que le plafond est refusee');
  /* LE POINT QUI COMPTE : le refus ne doit pas avoir coute un jeton. Un
     controle place APRES le debit laisserait le joueur sans ses jetons ni son
     staking, et c'est le genre de trou qu'on ne decouvre que par une
     reclamation. */
  eq(g.balanceStr(a), '300000000.0', 'ET LE SOLDE EST INTACT : le refus n a rien coute');
  eq(g.totalStaked().toString(), '0', 'rien n est parti en staking non plus');

  /* Le refus porte le chiffre exact qui reste : « pool full » tout seul fait
     ecrire au support, « il reste 200 000 000 » fait retaper le montant. */
  jete(() => g.stake(a, '250000000'), /200,000,000/, 'et il dit COMBIEN il reste');
});

// ============================== ni en mille fois
/* Un plafond qui ne tient que sur un gros depot ne tient pas : il suffirait de
   le decouper.
 *
 * Le nombre de portefeuilles necessaires a change le jour ou le plafond PAR
 * PORTEFEUILLE est arrive : il en fallait vingt a dix millions, il en faut
 * maintenant cent au maximum autorise. C'est exactement l'effet recherche —
 * la subvention atteint cent portefeuilles au lieu de vingt — et le voir ici
 * vaut mieux que de le supposer. */
{
  const g = new Game();
  const max = Number(ethers.utils.formatUnits(g.plafondJoueur(), cfg.DECIMALS));
  const combien = Math.ceil(200000000 / max);
  eq(combien, 100, 'il faut cent portefeuilles au plafond pour remplir la salle');
  for (let i = 1; i <= combien + 1; i++) {
    const a = riche(g, i, max);
    try { g.stake(a, String(max)); } catch (e) { /* le cent-unieme est refuse */ }
  }
  const c = g.capaciteStaking();
  eq(c.occupe, 200000000, 'cent portefeuilles au plafond remplissent la salle, le cent-unieme non');
  ok(c.occupe <= c.plafond, 'LA SOMME NE DEPASSE JAMAIS LE PLAFOND');
  eq(c.plein, true, 'et la salle se declare pleine');
  eq(Number(g.balanceStr(adr(combien + 1))), max, 'le refuse a garde tous ses jetons');
}

// ============================== la place se libere quand quelqu un sort
/* Sinon ce n'est pas un plafond, c'est une porte fermee — et le systeme
   mourrait au premier remplissage. */
sansPlafondJoueur(() => {
  const g = new Game();
  const a = riche(g, 1, 200000000);
  g.stake(a, '200000000');
  eq(g.capaciteStaking().plein, true, 'la salle est pleine');
  const b = riche(g, 2, 50000);
  jete(() => g.stake(b, '50000'), /full/, 'le suivant ne peut pas entrer');

  g.unstakeAll(a);
  eq(g.capaciteStaking().plein, false, 'le premier sort : la salle n est plus pleine');
  g.stake(b, '50000');
  eq(g.capaciteStaking().occupe, 50000, 'et le suivant entre');
});

// ============================== le taux affiche ne ment pas
/* A 99,9995 %, un arrondi au plus proche affiche « 100 % » alors qu'il reste
   de la place : le joueur renonce a une salle qui l'aurait accepte. */
sansPlafondJoueur(() => {
  const g = new Game();
  const a = riche(g, 1, 200000000);
  g.stake(a, '199999000');
  const c = g.capaciteStaking();
  ok(c.taux < 100, `il reste 1 000 jetons : le taux ne dit PAS 100 % (${c.taux} %)`);
  eq(c.plein, false, 'et la salle ne se declare pas pleine');
  eq(c.libre, 1000, 'elle annonce exactement ce qui reste');
  g.stake(a, '1000');
  eq(g.capaciteStaking().taux, 100, 'cent pour cent ne s affiche que quand c est vraiment plein');
});

// ============================== il suit l offre REELLE de la chaine
/* Un plafond fige sur un chiffre ecrit a la main finirait par ne plus vouloir
   dire 20 % le jour ou des jetons sont brules. */
sansPlafondJoueur(() => {
  const g = new Game();
  g.offreTotale = WEI(500000000);            // la moitie a ete brulee
  eq(g.capaciteStaking().plafond, 100000000, 'l offre baisse de moitie : le plafond aussi');
  const a = riche(g, 1, 200000000);
  jete(() => g.stake(a, '150000000'), /room left/, 'et il s applique tout de suite');
});

// ============================== le plafond survit au redemarrage
sansPlafondJoueur(() => {
  const g = new Game();
  const a = riche(g, 1, 200000000);
  g.stake(a, '199000000');
  const g2 = new Game(); g2.hydrate(g.serialize());
  eq(g2.capaciteStaking().occupe, 199000000, 'ce qui est en staking revient apres un redemarrage');
  const b = riche(g2, 2, 5000000);
  jete(() => g2.stake(b, '5000000'), /room left/, 'et le plafond tient toujours');
});

// ============================== le staking lui-meme n a pas change
/* Le plafond ne doit rien casser de ce qui marchait : ce qui est mis revient,
   le rendement court, et rien ne se cree. */
{
  const g = new Game();
  const a = riche(g, 1, 100000);
  const avant = g.owedBreakdown();
  g.stake(a, '60000');
  eq(g.balanceStr(a), '40000.0', 'le solde baisse de ce qui est mis');
  const apres = g.owedBreakdown();
  eq(apres.balances.add(apres.staked).toString(), avant.balances.add(avant.staked).toString(),
     'ET RIEN NE SE CREE : solde + staking est le meme avant et apres');
  /* LA SORTIE EST LIBRE. Ce qui a ete mis revient EN ENTIER, immediatement,
     sans attendre aucune echeance. Avant, la moitie du principal restait a la
     maison : c'est cette regle-la qui a ete retiree, et ce test est ce qui
     empeche de la reintroduire par inadvertance. */
  const r = g.unstakeAll(a);
  eq(r.returned, '60000.0', 'sortie immediate : TOUT le principal revient');
  eq(r.penalty, '0.0', 'et rien ne reste a la maison');
  eq(g.capaciteStaking().occupe, 0, 'et la place est rendue EN ENTIER a la salle');
}

// ============================== COMBIEN DE TEMPS LE COFFRE TIENT
/*
 * L'alarme de solvabilite compare ce qu'il y a dans le coffre a ce qu'on doit,
 * et sonne quand c'est DEJA passe dessous — c'est-a-dire le jour ou on
 * l'apprend par un joueur qui n'arrive pas a retirer.
 *
 * A 100 % l'an la dette ne saute pas : elle monte a la seconde, d'un montant
 * qui se calcule. En face, l'avantage de la maison encaisse tous les jours.
 * Les deux courbes se croisent a une date, et cette date se calcule
 * aujourd'hui. C'est le seul chiffre qui previent au lieu de constater.
 */
sansPlafondJoueur(() => {
  const g = new Game();
  const a = riche(g, 1, 120000000);
  g.stake(a, '100000000');

  const nu = g.autonomie(null);
  eq(nu.staked, 100000000, 'cent millions en staking');
  ok(Math.abs(nu.rendementJour - 100000000 / 365) < 1,
     `ils coutent ${Math.round(nu.rendementJour).toLocaleString('en-US')} $SWOGE par JOUR, joue ou pas`);
  eq(nu.surplus, null, 'sans lecture du coffre, on n annonce pas un surplus qu on ne connait pas');
  eq(nu.joursRestants, null, 'ni une echeance');

  /* On fait tourner le casino : 850 000 de volume par jour, 3 % pour la
     maison. C'est l'ordre de grandeur reel. */
  const b = riche(g, 2, 60000000);
  const jours = new Date().getUTCDate();
  for (let i = 0; i < jours; i++) g._manche(g._p(b), 'plinko', 850000, 850000 * 0.97);

  const av = g.autonomie(WEI(220000000));
  ok(Math.abs(av.revenuJour - 25500) < 60, `la maison encaisse ${Math.round(av.revenuJour)} par jour`);
  ok(av.drainJour > 0, 'le staking coute plus que la maison ne gagne : ca DRAINE');
  ok(av.joursRestants > 30 && av.joursRestants < 400,
     `et le surplus tient ${av.joursRestants} jours — une date, pas une inquietude`);

  /* LE CHIFFRE QUI SERT A DECIDER : ce que le revenu seul pourrait porter. */
  ok(Math.abs(av.stakingAutofinance - 25500 * 365) < 25000,
     `le revenu seul porterait ${Math.round(av.stakingAutofinance).toLocaleString('en-US')} $SWOGE de staking`);
  ok(av.stakingAutofinance < g.capaciteStaking().plafond,
     'et c est BIEN EN DESSOUS du plafond : la difference se remet au coffre a la main');
});

// -------------------------------- quand le revenu couvre, il n y a plus d echeance
{
  const g = new Game();
  const a = riche(g, 1, 200000);
  g.stake(a, '100000');                       // 100 000 en staking = 274 par jour
  const b = riche(g, 2, 90000000);
  const jours = new Date().getUTCDate();
  for (let i = 0; i < jours; i++) g._manche(g._p(b), 'plinko', 500000, 500000 * 0.97);
  const av = g.autonomie(WEI(95000000));
  ok(av.revenuJour > av.rendementJour, 'la maison gagne plus que le staking ne coute');
  eq(av.joursRestants, null, 'IL N Y A PLUS D ECHEANCE : la salle se paie toute seule');
  ok(av.drainJour < 0, 'et le drain est negatif — le surplus monte au lieu de baisser');
}

// -------------------------------- deja sous l eau : zero jour, pas un nombre rassurant
sansPlafondJoueur(() => {
  const g = new Game();
  const a = riche(g, 1, 10000000);
  g.stake(a, '10000000');
  const av = g.autonomie(WEI(1000000));       // le coffre ne couvre meme pas ce qui est en staking
  ok(av.surplus < 0, 'le coffre ne couvre plus ce qu on doit');
  eq(av.joursRestants, 0, 'ZERO JOUR — et surtout pas un nombre qui rassure');
});

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`plafond.test.js : ${n} verifications OK`);
});
