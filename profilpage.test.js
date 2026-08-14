'use strict';
/*
 * La page publique d'un joueur.
 *
 * Publier une page, c'est decider une fois pour toutes ce qui sort. Le
 * controle central n'est donc pas « la page s'affiche » mais « la page ne dit
 * QUE ce qu'on a decide » — et il doit rester vrai le jour ou quelqu'un
 * ajoutera un champ ailleurs sans penser a celui-la.
 *
 * On verifie ensuite ce qui fait qu'une adresse partageable sert a quelque
 * chose : les balises que Telegram et X lisent. Sans elles le lien colle reste
 * nu, et un lien nu ne se propage pas — la fonctionnalite entiere n'aurait
 * servi a rien.
 */
const assert = require('assert');
const fs = require('fs');

process.env.PORT = String(8500 + (process.pid % 90));
process.env.DATA_DIR = fs.mkdtempSync('/tmp/profilpage-test-');
process.env.RPC_URL = '';

const { ethers } = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');
const page = require('./profilpage');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), C = '0x' + 'cc'.repeat(20);

function casino() {
  const g = new Game();
  for (const a of [A, B, C]) {
    const p = g._p(a);
    p.balance = ethers.utils.parseUnits('500000', cfg.DECIMALS);
    p.hasDeposited = true;
  }
  const p = g._p(A);
  p.name = 'swoler'; p.nomChoisi = true; p.visage = 'b3';
  p.wagered = ethers.utils.parseUnits('900000', cfg.DECIMALS);
  p.deposited = ethers.utils.parseUnits('123456', cfg.DECIMALS);
  p.record = { g: 48000, x: 24, j: 'plinko', t: Date.now() - 3600000 };
  p.jeux = { plinko: { n: 900, mise: 90000, rendu: 88000 }, mines: { n: 120, mise: 1000, rendu: 900 } };
  p.amis = [B, C];
  g._p(B).name = 'rival'; g._p(B).nomChoisi = true;
  g._p(C).name = 'autre'; g._p(C).nomChoisi = true;
  return g;
}

// ============================================ ce qui ne doit JAMAIS sortir
{
  const g = casino();
  const vue = g.profilPage(A);
  const texte = JSON.stringify(vue) + page.rend(vue);

  /* Le solde de quelqu'un ne regarde personne, et afficher combien il a
     depose designe une cible. */
  ok(!/123456/.test(texte), 'le total depose n apparait nulle part');
  ok(!/500000/.test(texte), 'le solde non plus');
  const interdits = ['balance', 'deposited', 'depose', 'cumulativeAuthorized',
                     'clientSeed', 'serverSeed', 'sessionSecret', 'tgId', 'stakeAccrued'];
  for (const k of interdits)
    ok(!Object.prototype.hasOwnProperty.call(vue, k), `« ${k} » n est pas publie`);

  /* La construction est faite par ADDITION : la liste des champs publies est
     figee ici, et tout ajout ailleurs devra passer par ce test. */
  const attendus = ['adresse', 'nom', 'visage', 'photo', 'niveau', 'palier', 'palierNo',
                    'volume', 'seuil', 'prochain', 'manches', 'favoris', 'record',
                    'duels', 'amis', 'depuis'];
  eq(Object.keys(vue).sort().join(','), attendus.sort().join(','),
     'la liste des champs publies est exactement celle qui a ete decidee');
}

// ================================================= ce qui doit y etre
{
  const g = casino();
  const vue = g.profilPage(A);
  eq(vue.nom, 'swoler', 'le nom');
  ok(vue.niveau > 0, 'le niveau', vue.niveau);
  eq(vue.manches, 1020, 'le nombre de manches, tous jeux confondus');
  eq(vue.favoris[0].jeu, 'plinko', 'le jeu le plus joue en tete');
  eq(vue.record.gain, 48000, 'la plus grosse victoire — deja annoncee au canal');
  eq(vue.amis, 2, 'le nombre d amis');
}

// ------------------------------------------------------- les rivalites
{
  const g = casino();
  /* Une rencontre n est pas une rivalite : il en faut au moins deux. */
  g._faceAFace(A, B, 'v');
  eq(g.profilPage(A).duels.rivaux.length, 0, 'un seul duel ne fait pas une rivalite');
  g._faceAFace(A, B, 'v');
  g._faceAFace(B, A, 'v');
  g._faceAFace(A, B, 'n');

  const vA = g.profilPage(A).duels;
  eq(vA.rivaux.length, 1, 'un rival');
  eq(vA.rivaux[0].nom, 'rival', 'nomme');
  eq(vA.rivaux[0].v, 2, 'deux victoires');
  eq(vA.rivaux[0].d, 1, 'une defaite');
  eq(vA.rivaux[0].n, 1, 'une nulle');
  eq(vA.joues, 4, 'quatre duels au total');

  /* Le compte doit etre le MIROIR exact chez l adversaire : deux comptes qui
     divergent, c est une page qui ment a l un des deux. */
  const vB = g.profilPage(B).duels.rivaux[0];
  eq(vB.v, vA.rivaux[0].d, 'ses victoires sont mes defaites');
  eq(vB.d, vA.rivaux[0].v, 'et reciproquement');
  eq(vB.n, vA.rivaux[0].n, 'les nulles sont les memes des deux cotes');
}

// -------------------------------------- le face-a-face suit une vraie partie
/* On ne se contente pas d appeler le compteur a la main : on joue un duel
   entier et on regarde si la page le sait. */
{
  const g = casino();
  const m = g.duelCreer('mp', A, 1000, 1000);
  g.duelRejoindre(B, m.id, 2000);
  g.duelAbandonner(B, m.id, 3000);          // B abandonne : A gagne
  const m2 = g.duelCreer('mp', A, 1000, 4000);
  g.duelRejoindre(B, m2.id, 5000);
  g.duelAbandonner(B, m2.id, 6000);

  const r = g.profilPage(A).duels;
  eq(r.gagnes, 2, 'deux victoires reelles comptees');
  eq(r.rivaux[0].nom, 'rival', 'contre le bon adversaire');
  eq(g.profilPage(B).duels.rivaux[0].d, 2, 'et deux defaites de son cote');
}

// ================================== ce qui rend une adresse partageable
{
  const g = casino();
  const html = page.rend(g.profilPage(A));

  /* Sans ces balises, coller le lien dans Telegram donne une ligne de texte
     grise. C est la seule chose qui fait la difference entre une adresse
     qu on partage et une adresse qu on ne partage pas. */
  for (const balise of ['og:title', 'og:description', 'og:image', 'og:url',
                        'twitter:card', 'twitter:image'])
    ok(html.indexOf(balise) > 0, `la balise ${balise} est presente`);
  ok(/og:image" content="https?:\/\//.test(html),
     'l image de l apercu est une adresse ABSOLUE — une adresse relative ne serait ' +
     'pas resolue par le service qui lit la page');
  ok(/og:url" content="https?:\/\//.test(html), 'l adresse canonique aussi');
  ok(html.indexOf('<title>swoler') === html.indexOf('<title>'),
     'le titre commence par le nom du joueur');

  /* Le titre et la description sont ce qui s affiche : ils doivent porter
     quelque chose, pas rester vides. */
  const desc = /name="description" content="([^"]*)"/.exec(html);
  ok(desc && desc[1].length > 10, 'la description dit quelque chose', desc && desc[1]);
}

// ------------------------------------------ un nom qui essaie de sortir du cadre
{
  const g = casino();
  const p = g._p(A);
  p.name = '"><script>alert(1)</script>';
  const html = page.rend(g.profilPage(A));
  ok(html.indexOf('<script>alert') < 0, 'un nom piege ne sort pas en balise');
  ok(html.indexOf('&lt;script&gt;') > 0, 'il est echappe');
  /* Y compris dans les ATTRIBUTS, ou une simple guillemet suffirait a sortir
     du cadre — c est le piege que l echappement du corps ne couvre pas. */
  ok(!/content="[^"]*"><script/.test(html), 'ni dans les attributs des balises og:');
}

// ------------------------------------------------- retrouver un joueur
{
  const g = casino();
  eq(g.parNom('swoler'), A.toLowerCase(), 'par son nom');
  eq(g.parNom('SWOLER'), A.toLowerCase(), 'sans distinction de casse');
  eq(g.parNom(A), A.toLowerCase(), 'ou par son adresse');
  eq(g.parNom('personne'), null, 'un inconnu ne rend rien');
  eq(g.parNom(''), null, 'un nom vide non plus');

  /* Un joueur qui n a jamais choisi de nom ne se trouve pas par son nom
     d office : « 0xaa12 » n est pas une identite, et deux joueurs pourraient
     se disputer la meme adresse partageable. */
  const D = '0x' + 'dd'.repeat(20);
  g._p(D);
  eq(g.parNom(g._p(D).name), null, 'un nom par defaut n ouvre pas de page');
}

// ------------------------------------------------- la page « personne »
{
  const html = page.absent('inconnu');
  ok(html.indexOf('noindex') > 0, 'une page absente ne demande pas a etre indexee');
  ok(html.indexOf('inconnu') > 0, 'mais elle dit quel nom a ete cherche');
  ok(page.absent('<script>x</script>').indexOf('<script>x') < 0,
     'et le nom cherche y est echappe aussi');
}

console.log(`profilpage.test.js : ${n} verifications OK`);
