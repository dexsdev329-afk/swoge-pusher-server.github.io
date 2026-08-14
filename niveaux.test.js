'use strict';
/*
 * Les cent niveaux.
 *
 * ---- pourquoi l'experience est le volume mise ----
 *
 * Parce qu'il est DEJA compte, sur chaque fiche, depuis le premier jour : le
 * jour du deploiement, chacun a son vrai niveau, gagne pour de bon. Un
 * compteur neuf aurait remis tout le monde a zero et puni ceux qui jouent
 * depuis le debut.
 *
 * Et parce qu'il ne se triche pas : chaque point coute l'avantage de la
 * maison. Farmer un niveau, c'est payer le casino.
 *
 * ---- ce qui est verifie ----
 *
 * Les seuils tombent JUSTE (le joueur qui atteint exactement la marche doit
 * monter — c'est precisement le moment ou il regarde), le niveau ne redescend
 * jamais, il voyage avec le profil public sans que personne ait a le
 * demander, et les avantages qu'il ouvre ne coutent rien a la maison.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-niveaux-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function joueur(volume) {
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(10000000); p.hasDeposited = true;
  if (volume) p.wagered = WEI(String(volume));
  return g;
}

// ============================== les seuils tombent juste
/*
 * LE PIEGE : pow(1788854/50, 1/3,5) rend 19,999999998 et non 20. Sans
 * correction, le joueur qui atteint EXACTEMENT la marche reste au niveau
 * precedent — et c'est le moment ou il regarde son ecran.
 */
{
  for (const niv of [1, 5, 10, 20, 30, 50, 75, 99, 100]) {
    const v = Game.volumePour(niv);
    const g = joueur(v.toFixed(6));
    eq(g.niveau(A).niveau, niv, `pile au seuil du niveau ${niv} : on EST niveau ${niv}`);
  }
  /* Un jeton en dessous, on ne l'est pas encore. */
  const v = Game.volumePour(50);
  const g = joueur((v - 1).toFixed(6));
  eq(g.niveau(A).niveau, 49, 'un jeton sous la marche : toujours au niveau precedent');
}

// ============================== la courbe est bien celle annoncee
{
  eq(Math.round(Game.volumePour(100)), 500000000,
     'le niveau 100 demande 500 millions de volume — la moitie de l offre totale');
  ok(Game.volumePour(10) < 200000, `le niveau 10 s atteint vite (${Math.round(Game.volumePour(10))})`);
  /* Chaque marche est plus haute que la precedente, et de plus en plus : une
     courbe qui s aplatirait rendrait la fin facile. */
  let precedent = 0;
  for (let i = 2; i <= 100; i++) {
    const marche = Game.volumePour(i) - Game.volumePour(i - 1);
    ok(marche > precedent, i === 2 ? 'chaque marche est plus haute que la precedente' : true);
    precedent = marche;
    if (i > 2) n--;                       // une seule ligne pour les 99
  }
  n++;
  ok(Game.volumePour(100) - Game.volumePour(99) > (Game.volumePour(11) - Game.volumePour(10)) * 100,
     'la derniere marche vaut plus de cent fois une marche du debut');
}

// ============================== les dix paliers
{
  const attendus = [[1, 'Bronze'], [10, 'Bronze'], [11, 'Silver'], [20, 'Silver'],
                    [21, 'Gold'], [50, 'Diamond'], [70, 'Champion'], [91, 'SWOLE'], [100, 'SWOLE']];
  for (const [niv, palier] of attendus) {
    const g = joueur(Game.volumePour(niv).toFixed(6));
    eq(g.niveau(A).palier, palier, `niveau ${niv} → ${palier}`);
  }
  eq(Game.PALIERS.length, 10, 'dix paliers de dix niveaux');
}

// ============================== le niveau ne redescend JAMAIS
/* Un niveau qui baisse est une punition, et ca n'a jamais fait jouer
   personne. Perdre, retirer, tout vider : le niveau reste. */
{
  const g = joueur();
  const p = g._p(A);
  g._markWager(p, WEI(2000000));
  const avant = g.niveau(A).niveau;
  ok(avant >= 20, `il est monte au niveau ${avant} en misant`);

  g._manche(p, 'plinko', 2000000, 0);      // il perd tout
  p.balance = ethers.BigNumber.from(0);
  eq(g.niveau(A).niveau, avant, 'il perd tout : son niveau ne bouge pas');

  p.balance = WEI(100000);
  g.requestWithdraw(A, '50000');
  eq(g.niveau(A).niveau, avant, 'il retire : son niveau ne bouge pas non plus');
}

// ============ le niveau voyage tout seul avec le profil public
/*
 * C'est ce qui fait qu'il apparait d'un coup aux duels, chez les amis, au
 * classement et aux tables : aucun de ces endroits n'a a le demander.
 */
{
  const g = joueur(Game.volumePour(47).toFixed(6));
  g.setPublicName(A, 'Le Costaud');
  const pub = g.profilPublic(A);
  eq(pub.niveau, 47, 'le profil public porte le niveau');
  eq(pub.palier, 'Diamond', 'et son palier');

  /* Chez un ami, sans que la liste d'amis sache ce qu'est un niveau. */
  const p2 = g._p(B); p2.balance = WEI(100000); p2.hasDeposited = true;
  g.amiDemande(B, A); g.amiAccepte(A, B);
  eq(g.amis(B).amis[0].niveau, 47, 'un ami voit le niveau de son ami');
}

// ============================== ce que le niveau ouvre
{
  /* Le retrait minimum : une commodite qui ne coute rien a la maison. */
  const bas = joueur(Game.volumePour(5).toFixed(6));
  eq(bas.minRetraitDe(A), Number(cfg.MIN_WITHDRAW), 'au debut, le minimum de retrait est le minimum general');
  const or = joueur(Game.volumePour(20).toFixed(6));
  ok(or.minRetraitDe(A) < Number(cfg.MIN_WITHDRAW), `a Gold il baisse (${or.minRetraitDe(A)})`);
  const dia = joueur(Game.volumePour(40).toFixed(6));
  ok(dia.minRetraitDe(A) < or.minRetraitDe(A), `et encore a Diamond (${dia.minRetraitDe(A)})`);

  /* Et le refus porte le BON chiffre : un message qui annonce un minimum que
     le joueur a deja depasse le ferait ecrire au support. */
  assert.throws(() => dia.requestWithdraw(A, '1500'),
                new RegExp('below minimum withdraw \\(' + dia.minRetraitDe(A)),
                'le message dit SON minimum a lui'); n++;
  dia._p(A).balance = WEI(100000);
  dia.requestWithdraw(A, String(dia.minRetraitDe(A)));
  ok(true, 'et il peut retirer a son propre minimum');

  /* La photo : un depot OU le niveau 5. */
  const neuf = new Game();
  eq(neuf.peutTeleverser(A), false, 'sans depot ni niveau : pas de photo perso');
  neuf._p(A).wagered = WEI(Game.volumePour(5).toFixed(6));
  eq(neuf.peutTeleverser(A), true, 'au niveau 5, elle s ouvre sans avoir depose');

  /* Le parrainage monte d'un point tous les vingt-cinq niveaux — et reste un
     pourcentage du REVENU, donc plafonne par ce que le filleul rapporte. */
  eq(bas.partParrainage(A), cfg.REFERRAL_BPS, 'au debut, la part de parrainage est celle de tout le monde');
  const haut = joueur(Game.volumePour(100).toFixed(6));
  eq(haut.partParrainage(A), cfg.REFERRAL_BPS + 400, 'au niveau 100, quatre points de plus');
  ok(haut.partParrainage(A) < 10000, 'et jamais plus que ce que le filleul rapporte');
}

// ============================== la montee se remarque
{
  const g = joueur((Game.volumePour(10) - 100).toFixed(6));
  eq(g.niveau(A).niveau, 9, 'il est a un cheveu du niveau 10');
  g.montéesRecentes();                       // on vide ce qui trainait
  g._markWager(g._p(A), WEI(200));
  const m = g.montéesRecentes();
  eq(m.length, 1, 'la montee est signalee');
  eq(m[0].a, 10, 'au bon niveau');
  eq(g.montéesRecentes().length, 0, 'et une seule fois : on ne la fete pas deux fois');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`niveaux.test.js : ${n} verifications OK`);
});
