'use strict';
/*
 * Le profil : nom public, visage, amis, et virement de solde a solde.
 *
 * Le virement est la seule fonctionnalite de tout le serveur qui deplace de
 * l'argent d'un joueur VERS UN AUTRE. Le controle qui compte est donc celui-la
 * et pas un autre : apres n'importe quelle serie de virements, la somme des
 * soldes doit etre EXACTEMENT celle d'avant. Un jeton cree ou perdu se voit
 * la, meme s'il se cache.
 *
 * Le nom, lui, s'affiche chez les AUTRES joueurs — au poker, au Crash, au
 * Connect 4. Ce qu'on verifie n'est donc pas qu'il « se sauvegarde » mais que
 * ce qui peut y entrer est borne : un nom est du texte qui part dans le HTML
 * de la table de quelqu'un d'autre.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-profil-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';
const sol = (g, a) => Number(g.balanceStr(a));

function neuf(credit = 10000) {
  const g = new Game();
  for (const a of [A, B, C]) {
    const p = g._p(a);
    p.balance = ethers.utils.parseUnits(String(credit), cfg.DECIMALS);
    p.hasDeposited = true;
  }
  return g;
}

// ------------------------------------------------------------- le nom
{
  const g = neuf();
  eq(g.setPublicName(A, 'Swoler'), 'Swoler', 'un nom correct est accepte');
  eq(g.profilPublic(A).name, 'Swoler', 'et devient le nom public');

  jete(() => g.setPublicName(A, 'ab'), /at least 3/, 'trop court : refuse');
  jete(() => g.setPublicName(A, 'x'.repeat(19)), /18 characters/, 'trop long : refuse');
  /* Le controle qui compte : ce nom part dans le HTML de la table des autres
     joueurs. Tout ce qui ressemble a du balisage doit etre refuse a l'entree,
     pas echappe a la sortie et espere. */
  /* Une charge COURTE : longue, elle serait refusee par la regle de longueur,
     et on n'aurait rien prouve sur le jeu de caracteres — qui est la regle
     qui protege reellement la table des autres joueurs. */
  jete(() => g.setPublicName(A, '<b>x</b>'), /letters, digits/, 'du HTML court : refuse');
  jete(() => g.setPublicName(A, '<img src=x onerror=alert(1)>'), /letters, digits|18 characters/,
       'et une vraie charge d attaque, refusee elle aussi');
  jete(() => g.setPublicName(A, 'bob"onmouseover="x'), /letters, digits/, 'des guillemets : refuse');
  jete(() => g.setPublicName(A, 'a\nb'), /letters, digits/, 'un saut de ligne : refuse');
  /* Un espace de bout est une faute de frappe, pas une intention : on le
     retire. Tout le reste est refuse. */
  eq(g.setPublicName(A, '  bob  '), 'bob', 'les espaces de bout sont retires, pas refuses');
  jete(() => g.setPublicName(A, 'bob  smith'), /double or trailing/, 'deux espaces d affilee : refuse');
  eq(g.setPublicName(A, 'Bob-Smith_1.0'), 'Bob-Smith_1.0', 'tirets, souligne et point : acceptes');
  eq(g.setPublicName(A, 'Éliott le Fort'), 'Éliott le Fort', 'les accents aussi');

  // pas deux joueurs sous le meme nom
  jete(() => g.setPublicName(B, 'eliott le fort'), /taken/, 'un nom deja pris, meme en minuscules : refuse');
  eq(g.setPublicName(A, 'Éliott le Fort'), 'Éliott le Fort', 'mais on peut regarder le sien');
}

// ---------------------------------------------------------- le visage
{
  const g = neuf();
  const liste = Game.VISAGES;
  ok(liste.length >= 12, `${liste.length} visages proposes`);
  eq(g.setVisage(A, liste[3]), liste[3], 'un visage de la liste est accepte');
  eq(g.profilPublic(A).visage, liste[3], 'et devient le visage public');
  jete(() => g.setVisage(A, '<script>'), /unknown avatar/, 'ce qui n est pas dans la liste : refuse');
  jete(() => g.setVisage(A, 'https://ailleurs/img.png'), /unknown avatar/, 'une adresse d image aussi');
}

// ------------------------------------------------------------ les amis
{
  const g = neuf();
  eq(g.amis(A).length, 0, 'on commence sans ami');
  eq(g.amiAjoute(A, B).length, 1, 'on en ajoute un');
  eq(g.amis(A)[0].address, B, 'c est le bon');
  jete(() => g.amiAjoute(A, B), /already in/, 'deux fois le meme : refuse');
  jete(() => g.amiAjoute(A, A), /your own address/, 'soi-meme : refuse');
  jete(() => g.amiAjoute(A, 'pas une adresse'), /valid 0x/, 'une adresse invalide : refuse');
  g.setPublicName(B, 'Bobby');
  eq(g.amis(A)[0].name, 'Bobby', 'la liste montre le nom choisi par l ami');
  eq(g.amiRetire(A, B).length, 0, 'et on peut le retirer');
}

// -------------------------------------------------------- le virement
{
  const g = neuf();
  const avant = sol(g, A) + sol(g, B);
  const r = g.transfere(A, B, '250');
  eq(r.montant, '250.0', 'le montant part');
  eq(sol(g, A), 10000 - 250, 'debite chez l expediteur');
  eq(sol(g, B), 10000 + 250, 'credite chez le destinataire');
  eq(sol(g, A) + sol(g, B), avant, 'CONSERVATION : la somme des deux soldes n a pas bouge');

  jete(() => g.transfere(A, A, '10'), /to yourself/, 'a soi-meme : refuse');
  jete(() => g.transfere(A, B, '0'), /enter an amount/, 'zero : refuse');
  jete(() => g.transfere(A, B, '-50'), /enter an amount/, 'un montant negatif : refuse');
  jete(() => g.transfere(A, B, '999999999'), /exceeds your balance/, 'plus que son solde : refuse');
  jete(() => g.transfere(A, 'pas une adresse', '10'), /valid 0x/, 'vers n importe quoi : refuse');
  jete(() => g.transfere(A, B, '0.001'), /minimum transfer/, 'sous le minimum : refuse');

  // et aucun de ces refus n'a bouge un seul jeton
  eq(sol(g, A) + sol(g, B), avant, 'CONSERVATION apres six refus : rien n a bouge');
}

// ----------------------------- le depot prealable, contre les portefeuilles jetables
{
  const g = neuf();
  g._p(C).hasDeposited = false;
  if (cfg.TRANSFER_REQUIRE_DEPOSIT) {
    jete(() => g.transfere(C, A, '100'), /deposit once/,
         'sans depot, on ne peut pas vider son bonus chez un complice');
    g._p(C).hasDeposited = true;
    ok(g.transfere(C, A, '100'), 'apres un depot, le virement passe');
  } else {
    ok(true, 'le depot prealable est desactive dans cette configuration');
  }
}

// -------------------------- CONSERVATION sur cent virements croises
/* Le controle qui attrape tout. Cent virements dans tous les sens, dont des
   refuses : a la fin, la somme des trois soldes doit valoir exactement celle
   du depart. */
{
  const g = neuf();
  const depart = sol(g, A) + sol(g, B) + sol(g, C);
  const gens = [A, B, C];
  let passes = 0, refuses = 0;
  for (let i = 0; i < 100; i++) {
    const de = gens[i % 3], vers = gens[(i + 1 + (i % 2)) % 3];
    const montant = String((i * 37) % 900 + 1);        // parfois trop, parfois zero-ish
    try { g.transfere(de, vers, montant); passes++; }
    catch (e) { refuses++; }
  }
  ok(passes > 50, `${passes} virements passes, ${refuses} refuses`);
  eq(sol(g, A) + sol(g, B) + sol(g, C), depart,
     'CONSERVATION : apres cent virements, pas un jeton cree ni perdu');
}

// ------------------------------ le profil survit a un redemarrage
{
  const g = neuf();
  g.setPublicName(A, 'Champion');
  g.setVisage(A, Game.VISAGES[5]);
  g.amiAjoute(A, B);
  const g2 = new Game();
  g2.hydrate(g.serialize());
  eq(g2.profilPublic(A).name, 'Champion', 'le nom est relu apres redemarrage');
  eq(g2.profilPublic(A).visage, Game.VISAGES[5], 'le visage aussi');
  eq(g2.amis(A).length, 1, 'et la liste d amis');
  eq(g2.amis(A)[0].address, B, 'avec le bon ami');
}

fs.rmSync(bac, { recursive: true, force: true });
console.log(`profil.test.js : ${n} verifications OK`);
