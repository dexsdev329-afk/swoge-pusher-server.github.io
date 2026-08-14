'use strict';
/*
 * Ce qui empeche de mettre le serveur a terre gratuitement.
 *
 * Ni l'un ni l'autre ne protege de l'argent : ils protegent la DISPONIBILITE.
 * Un casino hors ligne ne gagne rien, et c'etait la seule chose qu'on pouvait
 * encore lui faire sans rien depenser.
 *
 *  1. les fiches vides : ouvrir un compte ne coute rien, et chaque fiche
 *     pesait dans un fichier reecrit en entier toutes les dix secondes par un
 *     appel qui BLOQUE le seul fil d'execution ;
 *  2. le classement : un calcul qui parcourt tous les joueurs, qu'une seule
 *     socket pouvait demander cent cinquante fois par seconde.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-tenue-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const adr = (i) => '0x' + i.toString(16).padStart(40, '0');

/** Un compte tout juste ouvert : connecte une fois, credit d'essai, rien d'autre. */
function ouvre(g, i) { const a = adr(i); g._p(a); g.grantWelcome(a); return a; }

// =============================================== les fiches qui n ont rien fait
{
  const g = new Game();
  for (let i = 1; i <= 2000; i++) ouvre(g, i);
  eq(g.players.size, 2000, 'deux mille comptes ouverts, gratuitement');
  eq(JSON.parse(JSON.stringify(g.serialize())).players.length, 0,
     'et PAS UN SEUL n est ecrit sur le disque');

  /* Ce qui compte autant : qu'un vrai joueur ne soit jamais confondu avec
     eux. Chaque forme d'activite, prise SEULE, doit suffire a le garder. */
  const cas = [
    ['un depot', (p) => { p.hasDeposited = true; p.deposited = WEI(1); }],
    ['une mise', (p) => { p.wagered = WEI(1); p.betCount = 1; }],
    ['un solde', (p) => { p.balance = WEI(1000); }],
    ['un nom choisi', (p) => { p.nomChoisi = true; p.name = 'Quelquun'; }],
    ['une medaille', (p) => { p.visage = 'b3'; }],
    ['une photo', (p) => { p.photo = true; }],
    ['un ami', (p) => { p.amis = [adr(9)]; }],
    ['une demande recue', (p) => { p.demandes = [adr(9)]; }],
    ['un parrain', (p) => { p.parrain = adr(9); }],
    ['un filleul', (p) => { p.filleuls = [adr(9)]; }],
    ['du staking', (p) => { p.stakes = [{ a: WEI(1), s: 1, u: 2 }]; }],
    ['un retrait autorise', (p) => { p.cumulativeAuthorized = WEI(1); }],
    ['un compte Telegram', (p) => { p.tgId = '123'; }],
    ['un gain de parrainage', (p) => { p.refDu = WEI(1); }],
  ];
  cas.forEach(([quoi, fait], k) => {
    const g2 = new Game();
    const a = ouvre(g2, 500 + k);
    fait(g2._p(a));
    eq(g2.serialize().players.length, 1, `${quoi} : la fiche est gardee`);
  });

  /* Le credit d'essai ne compte pas : il est donne, pas gagne. Sans cette
     nuance, RIEN ne serait jamais purge — toute fiche connectee le porte. */
  const g3 = new Game();
  const a3 = ouvre(g3, 77);
  ok(g3._p(a3).balance.gt(0), 'un compte tout neuf a bien recu le credit d essai');
  eq(g3.serialize().players.length, 0, 'et il ne suffit pas a faire garder la fiche');
}

// ------------------------------------------- la purge de la memoire
{
  const g = new Game();
  for (let i = 1; i <= 500; i++) ouvre(g, i);
  const vrai = ouvre(g, 999);
  g._p(vrai).hasDeposited = true;
  const connecte = ouvre(g, 888);

  const retirees = g.purge(new Set([connecte]));
  eq(retirees, 500, 'les 500 fiches vides quittent la memoire');
  ok(g.players.has(vrai), 'le joueur qui a depose reste');
  ok(g.players.has(connecte),
     'et celui qui est CONNECTE aussi — on ne lui reprend pas son credit en pleine visite');

  /* Une fiche purgee n'est pas une fiche perdue : le joueur revient, elle se
     recree. Ce qu'on retire, c'est du poids, pas un compte. */
  const revenu = g._p(adr(1));
  ok(revenu && revenu.balance.isZero(), 'un revenant retrouve une fiche neuve, sans erreur');
}

// ------------------------------------ ce que ca change pour le fichier
/*
 * Le chiffre qui justifie tout : le fichier est reecrit EN ENTIER toutes les
 * dix secondes par un appel synchrone. Ce qu'on mesure ici, c'est le temps
 * pendant lequel plus RIEN d'autre ne tourne — ni une partie de Crash, ni un
 * coup de Connect 4, ni un message recu.
 */
{
  const g = new Game();
  for (let i = 1; i <= 20000; i++) ouvre(g, i);
  const t0 = Date.now();
  const taille = JSON.stringify(g.serialize()).length;
  const dt = Date.now() - t0;
  ok(taille < 100 * 1024, `vingt mille comptes vides : ${(taille / 1024).toFixed(1)} Ko ecrits (etait 10,7 Mo)`);
  ok(dt < 400, `et ${dt} ms de fil bloque (etait 1 014 ms)`);
}

// ==================================================== le classement partage
{
  const g = new Game();
  for (let i = 1; i <= 20000; i++) {
    const a = adr(i); const p = g._p(a);
    p.moisCle = Game.moisCle(); p.moisMise = i; p.balance = WEI(1);
  }
  const un = (fois) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < fois; i++) g.classementMois(adr(1), 50);
    return Number(process.hrtime.bigint() - t0) / 1e6 / fois;
  };
  const cout = un(500);
  ok(cout < 1.5, `mille demandes de classement : ${cout.toFixed(3)} ms chacune (etait 6,6)`);

  /* Le cache ne doit pas mentir : le rang du demandeur est recalcule a chaque
     appel, c'est la seule partie qui lui est propre. */
  const a = g.classementMois(adr(1), 50);
  const b = g.classementMois(adr(20000), 50);
  ok(a.moi && b.moi && a.moi.rang !== b.moi.rang,
     'et chacun recoit SON rang, pas celui du premier qui a demande');
  eq(b.moi.rang, 1, 'le plus gros volume est premier');
  eq(a.top.length, 50, 'le haut du classement est le meme pour tous');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`tenue.test.js : ${n} verifications OK`);
});
