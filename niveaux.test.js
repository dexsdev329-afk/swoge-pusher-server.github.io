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
  eq(Math.round(Game.volumePour(100)), 5000000000,
     'le niveau 100 demande CINQ MILLIARDS de volume cumule');
  ok(Game.volumePour(10) <= 500000, `le niveau 10 reste accessible (${Math.round(Game.volumePour(10))})`);
  /* Le durcissement vaut DIX au sommet — c'est le chiffre demande — mais
     seulement trois au niveau 10 : monter la puissance plutot que la base
     laisse le debut de l'echelle atteignable. */
  eq(Math.round(50 * Math.pow(100, 3.5) * 10), Math.round(Game.volumePour(100)),
     'exactement dix fois l ancienne courbe au niveau 100');
  ok(Game.volumePour(10) / (50 * Math.pow(10, 3.5)) < 4,
     'mais moins de quatre fois au niveau 10 : le debut reste accessible');
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
  /* On mise ce qu'il FAUT pour le niveau 20, quelle que soit la courbe : un
     montant en dur devient faux au premier durcissement, et c'est le test qui
     casse au lieu du code. */
  g._markWager(p, WEI(Game.volumePour(20).toFixed(6)));
  const avant = g.niveau(A).niveau;
  eq(avant, 20, `il est monte au niveau ${avant} en misant`);

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

  /* Le parrainage monte d'un point PAR PALIER — et reste un pourcentage du
     REVENU, donc plafonne par ce que le filleul rapporte. */
  eq(bas.partParrainage(A), cfg.REFERRAL_BPS, 'au debut, la part de parrainage est celle de tout le monde');
  const haut = joueur(Game.volumePour(100).toFixed(6));
  eq(haut.partParrainage(A), 2000, 'a SWOLE, le double : 20 %');
  ok(haut.partParrainage(A) < 10000, 'et jamais plus que ce que le filleul rapporte');
  /* Un palier apres l'autre, sans trou ni retour en arriere. */
  let avant = 0;
  for (let t = 1; t <= 10; t++) {
    const g = joueur(Game.volumePour((t - 1) * 10 + 1).toFixed(6));
    const part = g.partParrainage(A);
    ok(part > avant, t === 1 ? 'la part monte a CHAQUE palier, jamais elle ne redescend' : true);
    if (t > 1) n--;
    avant = part;
  }
  n++;
  eq(joueur(0).partParrainage(A), cfg.REFERRAL_BPS,
     'et celui qui n a jamais mise touche quand meme la part de base');
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

// ============================== UN NIVEAU ATTEINT NE SE REPREND PAS
/*
 * Y COMPRIS QUAND LA COURBE CHANGE. C'est le cas qui compte : durcir la courbe
 * sans cette regle retrograderait tous les joueurs existants d'un coup — celui
 * qui etait niveau 34 se reveillerait niveau 21 sans rien avoir fait. C'est
 * exactement la punition que le systeme de niveaux existe pour eviter.
 */
{
  /* Une fiche ecrite AVANT le durcissement : elle ne porte pas de niveau
     acquis, et son volume vaut le niveau 34 de l'ancienne courbe. */
  const avant = new Game();
  const p = avant._p(A); p.addr = A;
  p.wagered = WEI((cfg.NIVEAU_BASE * Math.pow(34, cfg.NIVEAU_PUISSANCE_AVANT)).toFixed(6));
  const etat = avant.serialize();
  for (const [, d] of etat.players) delete d.nx;      // comme un fichier d'hier

  const g = new Game(); g.hydrate(etat);
  const n = g.niveau(A);
  eq(n.niveau, 34, 'LE JOUEUR GARDE SON NIVEAU 34 apres le durcissement');
  ok(Game.niveauDe(34e6) < 34, 'alors que la courbe neuve le mettrait bien plus bas');
  eq(n.progression, 0, 'sa progression repart de zero vers la marche suivante');
  ok(n.restant > 60000000, `et il lui reste ${Math.round(n.restant / 1e6)} M a miser pour le 35`);

  /* Et il ne se reperd pas au redemarrage suivant. */
  const g2 = new Game(); g2.hydrate(g.serialize());
  eq(g2.niveau(A).niveau, 34, 'et il le garde au redemarrage suivant');

  /* LE PIEGE : un joueur NEUF avec le meme volume ne doit PAS heriter de
     l'ancienne courbe. Ma premiere version le faisait, et le durcissement
     n'aurait servi a rien sans que ca se voie. */
  const q = g._p(B); q.addr = B;
  q.wagered = WEI((cfg.NIVEAU_BASE * Math.pow(34, cfg.NIVEAU_PUISSANCE_AVANT)).toFixed(6));
  ok(g.niveau(B).niveau < 34,
     `un joueur NEUF au meme volume est niveau ${g.niveau(B).niveau}, pas 34`);
  eq(g.niveau(B).niveau, Game.niveauDe(Number(cfg.NIVEAU_BASE * Math.pow(34, cfg.NIVEAU_PUISSANCE_AVANT))),
     'il est exactement la ou la courbe neuve le place');

  /* Et le fige ne recoit pas de fausses montees de niveau en rejouant. */
  g.montéesRecentes();
  g._markWager(g._p(A), WEI(1000000));
  eq(g.montéesRecentes().length, 0,
     'le joueur fige au-dessus de la courbe ne recoit PAS de montees pour des paliers deja depasses');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`niveaux.test.js : ${n} verifications OK`);
});
