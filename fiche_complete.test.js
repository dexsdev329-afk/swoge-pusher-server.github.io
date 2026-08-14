'use strict';
/*
 * TOUT ce qu'une fiche porte doit revenir de la sauvegarde.
 *
 * ---- pourquoi ce fichier n'est pas une liste ----
 *
 * On pourrait ecrire ici les cinquante-cinq champs a la main. Ils seraient
 * justes aujourd'hui, et faux au premier champ ajoute — parce que la personne
 * qui ajoute un champ a `_p()` pense a son jeu, pas a `fiche()`. Un champ
 * oublie ne casse rien, ne leve rien, et ne se voit qu'au redemarrage : le
 * niveau retombe, la serie repart a zero, le bonus se redonne. C'est la
 * categorie de defaut la plus chere, parce qu'on ne la trouve qu'apres.
 *
 * Ce fichier prend donc les champs OU ILS SONT DECLARES — la fiche neuve que
 * rend `_p()` — les remplit tous avec une valeur reconnaissable, fait passer
 * l'etat par le disque, et compare cle par cle. Un champ ajoute demain est
 * couvert sans que personne ne touche a ce test.
 *
 * ---- les deux exceptions, voulues ----
 *
 *   • `addr` n'est pas ecrite : la fiche est rangee SOUS son adresse, l'ecrire
 *     deux fois serait la seule chose qui puisse la contredire. `_p()` la
 *     repose a la lecture ; c'est verifie ici.
 *   • `photo` n'est qu'un DRAPEAU dans le fichier d'etat — l'image elle-meme
 *     vit a cote pour ne pas etre reecrite toutes les dix secondes avec les
 *     soldes. Le drapeau doit survivre ici ; que l'IMAGE parte bien dans
 *     l'archive est verifie par photos_sauvegarde.test.js.
 */
const assert = require('assert');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/fiche-complete-');
process.env.RPC_URL = '';

const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const A = '0x' + 'aa'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);

/* Une valeur RECONNAISSABLE, du meme type que la valeur par defaut. Elle ne
   doit jamais valoir le defaut : un champ qu'on oublie d'ecrire revient a sa
   valeur par defaut, et un test qui pose la valeur par defaut ne voit rien. */
let compteur = 0;
function valeurTemoin(defaut, cle) {
  compteur++;
  if (defaut && defaut._isBigNumber) return W(1000 + compteur);
  if (typeof defaut === 'number') return 1000 + compteur;
  if (typeof defaut === 'boolean') return !defaut;
  if (Array.isArray(defaut)) return ['temoin-' + cle];
  if (typeof defaut === 'string') return 'temoin-' + cle;
  if (defaut === null) return 'temoin-' + cle;          // les null portent des scalaires
  if (typeof defaut === 'object') { const o = {}; o['temoin'] = compteur; return o; }
  return 'temoin-' + cle;
}

const texte = (v) => {
  if (v && v._isBigNumber) return 'BN:' + v.toString();
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/* Les champs qui ne sont pas sur une fiche NEUVE parce qu'ils n'apparaissent
   qu'a l'usage. Ils sont ajoutes a la main — mais leur oubli, lui, se verrait :
   ils sont deja tous dans `fiche()`. */
const TARDIFS = {
  nomPaye: true,                       // le nom a ete paye — sans ca on repaie
  photo: true,                         // le drapeau, pas l'image
  nivMax: 12,                          // le niveau ACQUIS, jamais recalcule
  bj: { main: [1, 11], mise: '5' },    // une main de blackjack en cours
};

// =========================================== on remplit TOUT, on fait le tour
const g = new Game();
const neuve = g._p(A);
const champs = Object.keys(neuve);

const pose = {};
for (const k of champs) {
  if (k === 'addr') continue;                       // voir plus bas
  pose[k] = valeurTemoin(neuve[k], k);
}
/* `stakes` a une forme precise — c'est de l'argent verrouille, pas un tableau
   quelconque : on la pose telle qu'elle est vraiment. */
pose.stakes = [{ a: W(4242), s: 1700000000000, u: 1800000000000 }];
pose.questClaimed = { drop50: true };
pose.miseJour = { plinko: 500 };
pose.face = { plinko: 3 };
pose.jeux = { plinko: 12, crash: 5 };
pose.record = { jeu: 'plinko', gain: 999 };
pose.meilleurJour = { jour: '2026-08-01', net: 42 };
pose.attente = [{ a: '1', t: 2 }];
/* Les champs qui valent `null` a la creation mais portent un type precis
   ensuite : la valeur temoin doit etre de CE type, sinon c'est le test qui
   casse et pas le code. */
pose.bonusCible = W(16);                            // un montant, pas une chaine
pose.visage = 'b3';                                 // le badge : une valeur de la liste fermee
pose.parrain = '0x' + 'ee'.repeat(20);              // une adresse
pose.dayKey = '2026-08-14';
pose.moisCle = '2026-08';
pose.streakLastClaimDay = '2026-08-13';
pose.adDayKey = '2026-08-14';
Object.assign(pose, TARDIFS);

for (const k of Object.keys(pose)) neuve[k] = pose[k];

ok(champs.length >= 50, `la fiche porte ${champs.length} champs — ils passent tous par ici`);

// ------------------------------------------------- le voyage par le disque
const instantane = JSON.parse(JSON.stringify(g.serialize()));
const g2 = new Game();
g2.hydrate(instantane);
const revenue = g2.players.get(A.toLowerCase());
ok(revenue, 'la fiche est bien revenue');

const perdus = [], changes = [];
for (const k of Object.keys(pose)) {
  if (!(k in revenue)) { perdus.push(k); continue; }
  if (texte(revenue[k]) !== texte(pose[k])) changes.push(`${k} : ${texte(pose[k]).slice(0, 40)} → ${texte(revenue[k]).slice(0, 40)}`);
}
ok(!perdus.length, 'aucun champ ne manque apres la sauvegarde — absents : ' + perdus.join(', '));
ok(!changes.length, 'et aucun ne revient different :\n     ' + changes.join('\n     '));

/* Nommement, ce que le joueur verrait disparaitre. On les redit un par un :
   quand ce fichier casse, on veut lire CE QUI est perdu, pas « un champ ». */
eq(texte(revenue.balance), texte(pose.balance), 'le solde');
eq(texte(revenue.stakes), texte(pose.stakes), 'les positions de staking, avec leurs dates de verrou');
eq(texte(revenue.stakeAccrued), texte(pose.stakeAccrued), 'le rendement deja couru');
eq(texte(revenue.stakeClaimTotal), texte(pose.stakeClaimTotal), 'le rendement deja encaisse');
eq(revenue.nivMax, TARDIFS.nivMax, 'le niveau ACQUIS — sinon tout le monde retrograde au redemarrage');
eq(texte(revenue.wagered), texte(pose.wagered), 'le volume mise, qui porte le niveau');
eq(revenue.betCount, pose.betCount, 'le nombre de manches');
eq(texte(revenue.jeux), texte(pose.jeux), 'et leur detail par jeu');
eq(revenue.name, pose.name, 'le nom choisi');
eq(revenue.nomPaye, true, 'et le fait qu il a ETE PAYE — sinon le joueur repaie mille jetons');
eq(revenue.visage, pose.visage, 'le badge choisi (c est ce que `visage` designe)');
eq(revenue.photo, true, 'le drapeau de la photo');
eq(texte(revenue.amis), texte(pose.amis), 'les amis');
eq(texte(revenue.demandes), texte(pose.demandes), 'les demandes recues');
eq(texte(revenue.envoyees), texte(pose.envoyees), 'les demandes envoyees');
eq(revenue.parrain, pose.parrain, 'le parrain');
eq(texte(revenue.filleuls), texte(pose.filleuls), 'les filleuls');
eq(texte(revenue.refDu), texte(pose.refDu), 'la commission de parrainage due');
eq(texte(revenue.refTotal), texte(pose.refTotal), 'et celle deja versee');
eq(revenue.streakDay, pose.streakDay, 'la serie de jours');
eq(texte(revenue.questClaimed), texte(pose.questClaimed), 'les quetes deja reclamees');
eq(revenue.welcomeClaimed, pose.welcomeClaimed, 'le bonus de bienvenue deja pris — sinon il se reprend');
eq(texte(revenue.deposited), texte(pose.deposited), 'le total depose');
eq(texte(revenue.cumulativeAuthorized), texte(pose.cumulativeAuthorized),
   'le plafond de retrait deja signe — le chiffre qui empeche de retirer deux fois');
eq(revenue.tgId, pose.tgId, 'le lien avec Telegram');
eq(texte(revenue.record), texte(pose.record), 'le record');

// ------------------------------------------- l adresse, la seule non ecrite
{
  ok(!('addr' in JSON.parse(JSON.stringify(g.fiche(A)))),
     'l adresse n est pas ecrite dans la fiche : elle est la CLE, l ecrire deux fois la rendrait contredisable');
  eq(g2._p(A).addr, A.toLowerCase(),
     'et elle est reposee a la lecture — le code qui ne recoit que la fiche sait de qui il parle');
}

// ------------------------------- une fiche vide n est pas ecrite, exprès
{
  const g3 = new Game();
  const V = '0x' + 'bb'.repeat(20);
  g3._p(V);                                         // touchee, mais rien dessus
  ok(!g3.serialize().players.map((x) => x[0]).includes(V),
     'une fiche a zero n est pas ecrite — c est la seule barriere contre mille comptes vides par minute');

  /* Le bonus de bienvenue ne compte pas non plus : il est DONNE, pas gagne.
     Et ca ne coute rien au joueur — `welcomeGranted` n est pas ecrit non plus,
     donc s il revient, il le recoit encore. */
  const B = '0x' + 'cc'.repeat(20);
  const q = g3._p(B);
  q.balance = W(cfg.WELCOME_BONUS || 0);
  q.welcomeGranted = true;
  ok(!g3.serialize().players.map((x) => x[0]).includes(B),
     'un compte qui n a que le bonus de bienvenue n est pas ecrit — il est donne, pas gagne');

  /* Mais des qu il a FAIT quelque chose, il est ecrit. Une seule manche
     suffit : c est la ligne qui separe une ferme d un joueur. */
  const C = '0x' + 'dd'.repeat(20);
  const r = g3._p(C);
  r.wagered = W(1); r.betCount = 1;
  ok(g3.serialize().players.map((x) => x[0]).includes(C),
     'une manche jouee, et la fiche est ecrite');

  /* Et un depot aussi, meme sans avoir joue : l argent depose est du. */
  const D = '0x' + 'ee'.repeat(20);
  const t = g3._p(D);
  t.balance = W(50000); t.hasDeposited = true; t.deposited = W(50000);
  ok(g3.serialize().players.map((x) => x[0]).includes(D),
     'un depot sans une seule manche jouee est ecrit lui aussi — c est de l argent du');
}

console.log(`fiche_complete.test.js : ${n} verifications OK (${champs.length} champs couverts)`);
