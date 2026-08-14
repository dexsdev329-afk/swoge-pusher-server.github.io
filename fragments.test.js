'use strict';
/*
 * L'etat ecrit par morceaux.
 *
 * C'est le fichier qui porte l'argent. Le seul controle qui vaille est donc :
 * quoi qu'on fasse, ce qu'on relit est EXACTEMENT ce qu'on avait. On ne
 * verifie pas « ca marche », on compare l'etat complet, joueur par joueur,
 * apres chaque chemin d'ecriture.
 *
 * Les pieges auxquels on pense en decoupant un fichier en 256 morceaux :
 *
 *  • un joueur qui n'a pas bouge, mais dont un VOISIN de fragment a bouge :
 *    son fragment est reecrit, et s'il n'y figure pas il disparait ;
 *  • un joueur NOUVEAU : son fragment n'existe pas encore ;
 *  • une restauration : les fragments d'avant doivent disparaitre, sinon ils
 *    ressuscitent au redemarrage suivant les joueurs qu'on venait d'effacer ;
 *  • un fragment illisible : on doit retomber sur `state.json`, jamais
 *    demarrer a vide.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/fragments-test-');
process.env.RPC_URL = '';

const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');
const store = require('./store');
const fragments = require('./fragments');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

/* Une adresse dont on choisit le fragment : c'est ce qui permet de mettre
   deux joueurs dans le MEME morceau, la ou se cachent les mauvaises
   surprises. */
const adr = (frag, i) => '0x' + frag + i.toString(16).padStart(38, '0');

/* Chaque bloc repart d'un disque vide : sinon on relirait les fragments du
   bloc precedent et on compterait des joueurs qu'on n'a pas ecrits. */
function neuf() {
  try { fs.rmSync(fragments.DOSSIER, { recursive: true, force: true }); } catch (e) {}
  for (const f of [store.FILE, store.BAK]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  fragments.reconstruit({ players: [] });     // remet aussi l'index en memoire
  return new Game();
}

/* Le meme jeu, mais avec deux joueurs seulement : on ne touche pas au disque,
   on veut seulement voir si le decoupage reste allume. */
function neuf2() {
  const g = new Game();
  for (let i = 0; i < 2; i++)
    joueur(g, ethers.utils.keccak256(ethers.utils.toUtf8Bytes('reste' + i)).slice(0, 42), 50);
  return g;
}

function joueur(g, a, solde) {
  const p = g._p(a);
  p.balance = ethers.utils.parseUnits(String(solde), cfg.DECIMALS);
  p.hasDeposited = true;
  p.nomChoisi = true;
  p.name = 'j' + solde;
  return p;
}
/* La comparaison qui compte : tout l'etat, mis a plat, trie. */
const empreinte = (etat) => JSON.stringify({
  ...etat,
  players: (etat.players || []).slice().sort((x, y) => (x[0] < y[0] ? -1 : 1)),
  seenTx: (etat.seenTx || []).slice().sort(),
});
const soldes = (etat) => Object.fromEntries((etat.players || []).map(([a, f]) => [a, f.b]));

// ============================================ 1. l aller-retour, tel quel
{
  const g = neuf();
  joueur(g, adr('aa', 1), 1000);
  joueur(g, adr('aa', 2), 2000);          // meme fragment que le precedent
  joueur(g, adr('bb', 1), 3000);
  g.lastBlock = 4242;

  eq(store.sauveVite(g), true, 'la premiere sauvegarde passe');
  const relu = fragments.charge();
  ok(relu, 'les fragments se relisent');
  eq(relu.players.length, 3, 'les trois fiches sont la');
  eq(relu.lastBlock, 4242, 'et la tete aussi');
  eq(empreinte(relu), empreinte(g.serialize()),
     'ce qu on relit est exactement ce qu on avait');
}

// ================================= 2. le voisin de fragment qui n a pas bouge
/* LE piege du decoupage. On touche un joueur ; son fragment est reecrit en
   entier ; si le voisin n'y est pas remis, son solde disparait du disque
   alors qu'il est toujours en memoire — et le prochain redemarrage l'efface
   pour de bon. */
{
  const g = neuf();
  const A = adr('cc', 1), B = adr('cc', 2);
  joueur(g, A, 1000);
  joueur(g, B, 5000);
  store.sauveVite(g);
  eq(fragments.fragmentDe(A), fragments.fragmentDe(B), 'les deux sont bien dans le meme morceau');

  g.sales = new Set();
  g._p(A).balance = ethers.utils.parseUnits('1234', cfg.DECIMALS);   // seul A bouge
  eq(g.sales.size, 1, 'une seule fiche est marquee');
  store.sauveVite(g);

  const relu = fragments.charge();
  const s = soldes(relu);
  eq(s[A.toLowerCase()], ethers.utils.parseUnits('1234', cfg.DECIMALS).toString(),
     'le joueur qui a bouge est a jour');
  eq(s[B.toLowerCase()], ethers.utils.parseUnits('5000', cfg.DECIMALS).toString(),
     'et SON VOISIN est toujours la, avec son solde intact');
}

// ---------------------------------------- un joueur qui arrive apres coup
{
  const g = neuf();
  joueur(g, adr('dd', 1), 1000);
  store.sauveVite(g);
  g.sales = new Set();
  joueur(g, adr('ee', 9), 7000);          // fragment jamais ecrit
  store.sauveVite(g);
  const s = soldes(fragments.charge());
  eq(Object.keys(s).length, 2, 'le nouveau venu est ecrit');
  eq(s[adr('ee', 9).toLowerCase()], ethers.utils.parseUnits('7000', cfg.DECIMALS).toString(),
     'avec son solde');
}

// ------------------------------------ une fiche vide sort, et ne revient pas
{
  const g = neuf();
  const A = adr('ff', 1);
  joueur(g, A, 1000);
  store.sauveVite(g);
  eq(Object.keys(soldes(fragments.charge())).length, 1, 'elle y est');
  g.sales = new Set();
  const p = g._p(A);
  p.balance = ethers.BigNumber.from(0); p.hasDeposited = false; p.nomChoisi = false; p.name = A.slice(0, 6);
  store.sauveVite(g);
  eq(Object.keys(soldes(fragments.charge())).length, 0,
     'une fiche devenue vide sort du fragment, comme elle sortait du fichier unique');
}

// ==================================== 3. le cout ne depend plus du nombre
/* La raison d'etre de tout ce fichier. On peuple largement, on fait bouger
   une seule fiche, et on regarde ce qui est reellement ecrit. */
{
  const g = neuf();
  /* De VRAIES adresses. Une adresse Ethereum est un condensat : ses premiers
     chiffres sont uniformes, et c'est exactement ce sur quoi repose le
     decoupage. Des adresses de test toutes prefixees de zeros tomberaient
     dans un seul fragment et le controle ne prouverait rien. */
  const vraies = [];
  for (let i = 0; i < 3000; i++)
    vraies.push(ethers.utils.keccak256(ethers.utils.toUtf8Bytes('j' + i)).slice(0, 42));
  for (let i = 0; i < 3000; i++) joueur(g, vraies[i], 100 + i);
  store.sauveVite(g);

  /* La repartition, verifiee et non supposee : si les fragments etaient
     desequilibres, le plus gros redeviendrait le goulot d'origine. */
  const compte = {};
  for (const a of vraies) compte[fragments.fragmentDe(a)] = (compte[fragments.fragmentDe(a)] || 0) + 1;
  const plusGros = Math.max(...Object.values(compte));
  const moyenne = 3000 / 256;
  ok(Object.keys(compte).length > 200,
     `les 3000 fiches se repartissent sur ${Object.keys(compte).length} fragments`);
  ok(plusGros < moyenne * 3,
     `le plus gros fragment tient ${plusGros} fiches pour une moyenne de ${moyenne.toFixed(1)}`);

  g.sales = new Set();
  g._p(vraies[7]).balance = ethers.utils.parseUnits('99', cfg.DECIMALS);
  const ecrit = fragments.sauve(g, g.sales);
  eq(ecrit.fragments, 1, 'une fiche qui bouge fait reecrire UN fragment, pas trois mille fiches');
  ok(ecrit.fiches <= plusGros,
     `et seulement ${ecrit.fiches} fiches ecrites au lieu de 3000`);
  g.sales = new Set();

  const relu = fragments.charge();
  eq(relu.players.length, 3000, 'et rien n a ete perdu au passage');
  eq(soldes(relu)[vraies[7].toLowerCase()],
     ethers.utils.parseUnits('99', cfg.DECIMALS).toString(), 'celle qui a bouge est a jour');
}

// ============================================= 4. la restauration efface
/* Une restauration doit faire disparaitre ceux qui n'y sont pas. Sans
   effacement des fragments, ils reviendraient au redemarrage suivant — avec
   leur solde — et la restauration n'aurait servi a rien. */
{
  const g = neuf();
  joueur(g, adr('11', 1), 1000);
  joueur(g, adr('22', 2), 2000);
  store.sauveVite(g);

  const archive = { ...g.serialize(), players: [[adr('11', 1).toLowerCase(), g.fiche(adr('11', 1))]] };

  /* Un instantane ordinaire ne touche PAS aux fragments : ils sont deja a
     jour, et les refaire reecrirait des milliers de fichiers pour rien. */
  store.save(archive);
  eq(fragments.charge().players.length, 2,
     'un instantane periodique laisse les fragments tranquilles');

  /* Une RESTAURATION, elle, doit les refaire — sinon le redemarrage suivant
     rendrait l etat d avant, puisque les fragments sont relus en premier. */
  store.save(archive, { reconstruire: true });

  const relu = fragments.charge();
  eq(relu.players.length, 1, 'le joueur absent de l archive a disparu des fragments');
  eq(relu.players[0][0], adr('11', 1).toLowerCase(), 'et c est bien le bon qui reste');
  eq(JSON.parse(fs.readFileSync(store.FILE, 'utf8')).players.length, 1,
     'state.json dit la meme chose que les fragments');
}

// ======================================= 5. quand les fragments sont casses
/* On ne demarre JAMAIS a vide. Un fragment illisible doit renvoyer sur
   state.json, plus ancien mais entier. */
{
  const g = neuf();
  joueur(g, adr('33', 1), 4200);
  store.save(g.serialize());        // state.json + fragments d'accord
  store.sauveVite(g);

  /* On abime un VRAI fragment, celui qui contient reellement la fiche : un
     fichier invente prouverait seulement qu'on sait ignorer un intrus. */
  const casse = path.join(fragments.DOSSIER, fragments.fragmentDe(adr('33', 1)) + '.json');
  ok(fs.existsSync(casse), 'le fragment vise existe bien avant qu on l abime');
  fs.writeFileSync(casse, '{ceci n est pas du JSON');
  const relu = store.load();
  ok(relu && relu.players.length >= 1,
     'un fragment illisible ne fait pas demarrer a vide : on retombe sur state.json');
  eq(relu.players[0][1].b, ethers.utils.parseUnits('4200', cfg.DECIMALS).toString(),
     'et le solde est celui de l instantane');

  /* Et si tout est illisible, on refuse de demarrer plutot que d effacer. */
  fs.writeFileSync(store.FILE, 'casse aussi');
  fs.writeFileSync(store.BAK, 'casse aussi');
  jete(() => store.load(), /impossible de lire/,
       'tout illisible : le serveur refuse de demarrer, il n efface pas');
}

// ============================ 6. la marque est posee des qu on touche une fiche
{
  const g = neuf();
  g.sales = new Set();
  g.balanceStr(adr('44', 1));                 // une simple LECTURE
  ok(g.sales.has(adr('44', 1).toLowerCase()),
     'meme une lecture marque la fiche : marquer trop coute une ecriture, ' +
     'marquer trop peu perd de l argent');
}

// ================================ 7. le decoupage change : on reecrit tout
/* Si le nombre de fragments change un jour, les anciens fichiers ne seront
   plus jamais reecrits. Les laisser en place ferait ressusciter des fiches
   avec leur vieux solde. On verifie que le passage se solde en une fois. */
{
  const g = neuf();
  const A = adr('77', 1);
  joueur(g, A, 8000);
  store.sauveVite(g);

  /* On simule un disque ecrit par une version qui decoupait sur DEUX
     chiffres : on range la fiche dans un fichier a l ancienne, et on le dit
     dans la tete. */
  for (const nom of fs.readdirSync(fragments.DOSSIER))
    if (/^[0-9a-f]{3}\.json$/.test(nom)) fs.unlinkSync(path.join(fragments.DOSSIER, nom));
  const fi = g.fiche(A);
  fs.writeFileSync(path.join(fragments.DOSSIER, '77.json'),
                   JSON.stringify({ [A.toLowerCase()]: fi }));
  const tete = JSON.parse(fs.readFileSync(fragments.TETE, 'utf8'));
  tete.chiffres = 2;
  fs.writeFileSync(fragments.TETE, JSON.stringify(tete));

  const relu = fragments.charge();
  eq(relu.players.length, 1, 'un ancien decoupage se relit quand meme');

  const g2 = new Game();
  g2.hydrate(relu);
  g2.sales = new Set([A.toLowerCase()]);
  fragments.sauve(g2, g2.sales);

  const noms = fs.readdirSync(fragments.DOSSIER).filter((x) => /^[0-9a-f]+\.json$/.test(x));
  ok(!noms.includes('77.json'),
     'l ancien fichier a disparu : sinon la fiche y resterait, jamais reecrite');
  eq(fragments.charge().players.length, 1,
     'et la fiche est toujours la, une seule fois, dans le nouveau decoupage');
  eq(soldes(fragments.charge())[A.toLowerCase()],
     ethers.utils.parseUnits('8000', cfg.DECIMALS).toString(), 'avec son solde');
}

// ============================= 8. le decoupage ne s allume que s il paie
/* Mesure a 205 joueurs dont trente actifs : trente fragments coutent 30 ms,
   le fichier entier 5. Tant qu on est petit, on garde donc l ancien
   comportement — et on bascule tout seul en grandissant. */
{
  const g = neuf();
  try { fs.rmSync(fragments.DOSSIER, { recursive: true, force: true }); } catch (e) {}
  for (let i = 0; i < 5; i++)
    joueur(g, ethers.utils.keccak256(ethers.utils.toUtf8Bytes('petit' + i)).slice(0, 42), 100 + i);
  store.sauveVite(g);
  ok(!fragments.actif(), 'a cinq joueurs, aucun fragment n est cree');
  eq(JSON.parse(fs.readFileSync(store.FILE, 'utf8')).players.length, 5,
     'et state.json porte tout, comme avant');

  /* On franchit le seuil : la bascule doit se faire toute seule, une fois. */
  const seuil = parseInt(process.env.SEUIL_FRAGMENTS || '2000', 10);
  for (let i = 5; i < seuil + 5; i++)
    joueur(g, ethers.utils.keccak256(ethers.utils.toUtf8Bytes('petit' + i)).slice(0, 42), 100 + i);
  store.sauveVite(g);
  ok(fragments.actif(), 'passe le seuil, le decoupage s allume');
  eq(fragments.charge().players.length, seuil + 5, 'et il contient tout le monde');

  /* Et il ne s eteint plus : refaire l aller-retour a chaque variation
     d effectif reecrirait tout dans les deux sens pour rien. */
  const g2 = neuf2(g);
  store.sauveVite(g2);
  ok(fragments.actif(), 'et il ne s eteint pas quand l effectif redescend');
}

console.log(`fragments.test.js : ${n} verifications OK`);
