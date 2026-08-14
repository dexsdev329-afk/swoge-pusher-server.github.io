'use strict';
/*
 * La preuve d'equite, verifiee comme un joueur la verifierait.
 *
 * ---- ce qui manquait ----
 *
 * Chaque manche est tiree par HMAC(graine du serveur, graine du joueur:numero),
 * et le joueur recoit d'avance l'EMPREINTE de la graine du serveur. Cette
 * empreinte engage la maison : on ne peut plus changer la graine sans changer
 * l'empreinte.
 *
 * Mais la graine n'etait JAMAIS revelee — `_rotateSeed()` n'etait appelee
 * qu'une fois, a la construction. Le joueur avait donc une empreinte, sa
 * graine a lui, ses numeros… et aucun moyen de recalculer quoi que ce soit.
 * « Provably fair » etait une promesse invérifiable.
 *
 * ---- ce que ce test prouve ----
 *
 * Il ne verifie pas que « la rotation fonctionne ». Il REJOUE une manche
 * reellement tiree, a partir de la seule graine publiee, et exige de retrouver
 * le meme resultat au bit pres. C'est exactement ce qu'un joueur mefiant
 * ferait — et s'il ne peut pas le faire, rien de tout cela ne vaut.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-equite-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const plinko = require('./plinko');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);

function joueur() {
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(1000000); p.hasDeposited = true;
  return g;
}

// =================== LE CONTROLE CENTRAL : rejouer une manche reelle
{
  const g = joueur();

  /* On joue pour de vrai, et on note ce que le joueur a sous les yeux :
     l'empreinte annoncee, sa graine, et le numero de la manche. C'est tout ce
     dont il dispose au moment de jouer. */
  const empreinteAnnoncee = g.fairness(A).serverSeedHash;
  const graineJoueur = g.fairness(A).clientSeed;
  const numero = g.fairness(A).nonce;

  const r = g.plinkoDrop(A, 100, 12, 'medium');
  const cheminJoue = r.chemin.join('');
  const caseJouee = r.case;

  /* A cet instant, il ne peut RIEN verifier : la graine est encore en service.
     C'est normal et c'est necessaire — la publier laisserait predire la
     manche suivante. */
  ok(!JSON.stringify(g.equite()).includes(g.serverSeed),
     'tant qu elle sert, la graine n est publiee nulle part');
  eq(g.equite().graines.length, 0, 'et il n y a encore rien a verifier');

  // ---- la graine tourne : la precedente devient publique
  const t = g.tourneGraine();
  const publiees = g.equite().graines;
  eq(publiees.length, 1, 'apres la rotation, une graine est publiee');

  const pub = publiees[0];
  eq(pub.empreinte, empreinteAnnoncee,
     'c est bien l empreinte qui avait ete annoncee au joueur avant de jouer');
  eq(crypto.createHash('sha256').update(pub.graine).digest('hex'), pub.empreinte,
     'et son empreinte correspond : la graine n a pas ete changee en cours de route');

  /* ---- LE MOMENT DE VERITE ----
     Avec la graine publiee, sa propre graine et son numero, le joueur refait
     le calcul lui-meme. Il doit retomber sur le chemin exact que la bille a
     suivi devant ses yeux. */
  /* LA FORMULE EXACTE, telle qu'elle est publiee. Ma premiere version de ce
     test — et de la documentation — oubliait les deux details qui suivent, et
     retrouvait donc un autre chemin : le suffixe de jeu ajoute a la graine du
     joueur, et le numero incremente AVANT le tirage. Un joueur qui aurait
     suivi cette documentation aurait cru qu'on trichait. */
  const refait = plinko.chemin(pub.graine, graineJoueur + ':plinko', numero + 1, 12);
  eq(refait.join(''), cheminJoue,
     'LE JOUEUR REFAIT LE CALCUL ET RETROUVE LE MEME CHEMIN, case par case');
  eq(refait.reduce((s, x) => s + x, 0), caseJouee,
     'et la meme case d arrivee — donc le meme gain');

  /* La contre-epreuve : une autre graine ne redonne pas ce chemin. Sans elle,
     l'egalite ci-dessus pourrait etre un hasard heureux. */
  const fausse = crypto.randomBytes(32).toString('hex');
  const avecFausse = plinko.chemin(fausse, graineJoueur + ':plinko', numero + 1, 12).join('');
  ok(avecFausse !== cheminJoue,
     'et une graine inventee ne redonne PAS ce chemin — la verification discrimine');

  // la nouvelle graine est bien differente, et son empreinte aussi
  ok(t.nouvelle !== pub.empreinte, 'la nouvelle graine a une autre empreinte');
  eq(g.fairness(A).serverSeedHash, t.nouvelle, 'que le joueur recoit desormais');
}

// ================================ on ne coupe pas une manche en deux
/*
 * Une main de blackjack tire plusieurs fois, a plusieurs secondes d'ecart.
 * Tourner au milieu ferait tirer les premieres cartes avec l'ancienne graine
 * et les suivantes avec la nouvelle : la manche porterait UNE empreinte alors
 * que DEUX graines l'ont produite, et elle deviendrait invérifiable — le
 * contraire exact du but.
 */
{
  const g = joueur();
  eq(g.partiesEnCours(), 0, 'tables vides : on peut tourner');
  g.tourneGraine();
  ok(true, 'et la rotation passe');

  g.bjBet(A, '100');
  ok(g.partiesEnCours() >= 1, 'une main de blackjack est en cours');
  jete(() => g.tourneGraine(), /still running/,
       'la rotation REFUSE : elle couperait la main en deux');
  const avant = g.serverSeedHash;
  try { g.tourneGraine(); } catch (e) {}
  eq(g.serverSeedHash, avant, 'et la graine n a pas bouge d un poil');

  /* La main finie, on peut tourner. C'est pour ca que le serveur reessaie
     toutes les dix minutes au lieu de programmer un rendez-vous. */
  g.bjStand(A);
  eq(g.partiesEnCours(), 0, 'la main terminee, la table est libre');
  g.tourneGraine();
  ok(g.serverSeedHash !== avant, 'et la rotation passe enfin');
}

// ============ les jeux qui figent leur graine sont attendus AUSSI
/*
 * Les Mines, le Hi-Lo et les tables de casino gardent la graine du DEBUT de
 * la manche : une rotation ne les couperait pas en deux. On les attend quand
 * meme, et pour une raison qui compte autant — la ligne d'historique porte
 * l'empreinte en vigueur A LA FIN de la manche. Apres une rotation ce serait
 * la nouvelle, alors que l'ancienne a tire : le joueur verifierait avec la
 * mauvaise graine et conclurait qu'on triche.
 */
{
  const g = joueur();
  g.minesStart(A, '100', 3);
  ok(g.partiesEnCours() >= 1, 'une grille de Mines ouverte compte comme une manche en cours');
  jete(() => g.tourneGraine(), /still running/, 'et la rotation attend');
  g.minesPick(A, 0);          // il faut avoir ouvert une case pour encaisser
  g.minesCashOut(A);
  eq(g.partiesEnCours(), 0, 'encaissee, la grille libere la table');

  const g2 = joueur();
  g2.hiloStart(A, '100');
  ok(g2.partiesEnCours() >= 1, 'une serie de Hi-Lo aussi');
  jete(() => g2.tourneGraine(), /still running/, 'meme refus');

  const g3 = joueur();
  g3.casinoDeal(A, 'three', '100', 0);
  ok(g3.partiesEnCours() >= 1, 'et une main de Three Card');
  jete(() => g3.tourneGraine(), /still running/, 'meme refus');

  /* La sortie de secours existe : si une table reste bloquee des jours — un
     joueur qui ne revient jamais finir sa main — on peut forcer. C'est un
     choix, pas un accident, d'ou l'argument explicite. */
  const f = g3.tourneGraine(true);
  ok(f && f.revelee, 'on peut forcer la rotation, si on assume ce qu on fait');
}

// ============================== les graines revelees survivent a tout
/* Une preuve qu'on retire apres l'avoir donnee n'a jamais ete une preuve. */
{
  const g = joueur();
  g.plinkoDrop(A, 100, 12, 'medium');
  g.tourneGraine();
  g.plinkoDrop(A, 100, 12, 'medium');
  g.tourneGraine();
  eq(g.equite().graines.length, 2, 'deux graines publiees');

  const g2 = new Game();
  g2.hydrate(g.serialize());
  eq(g2.equite().graines.length, 2, 'elles sont toujours la apres redemarrage');
  eq(g2.equite().graines[0].graine, g.equite().graines[0].graine, 'a l identique');
  eq(g2.serverSeedHash, g.serverSeedHash, 'et la graine en service ne change pas au redemarrage');

  /* Chaque graine dit combien de manches elle a tirees et sur quelle periode :
     sans ca, le joueur ne sait pas LAQUELLE utiliser pour sa manche. */
  const p = g.equite().graines[0];
  ok(p.du && p.au && p.au >= p.du, 'chaque graine porte sa periode');
  ok(p.manches >= 1, 'et le nombre de manches qu elle a tirees');
}

// ====================================== ce que la page publique montre
{
  const g = joueur();
  g.plinkoDrop(A, 100, 12, 'medium');
  const e = g.equite();
  ok(e.empreinteActuelle && e.empreinteActuelle.length === 64, 'l empreinte en cours est publiee');
  ok(e.depuis > 0, 'avec la date depuis laquelle elle sert');
  ok(e.formules && e.formules.plinko && e.formules.blackjack,
     'et les formules, jeu par jeu — une preuve qu on ne sait pas refaire n en est pas une');
  ok(/:plinko/.test(e.formules.plinko) && /n1/.test(e.formules.plinko),
     'avec le suffixe de jeu ET le bon numero : c est exactement la ou je m etais trompe');
  ok(!JSON.stringify(e).includes(g.serverSeed), 'la graine en service reste secrete');
  ok(!JSON.stringify(e).includes(g.sessionSecret || 'xxxxx'),
     'et rien d autre ne fuit par cette porte');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`equite.test.js : ${n} verifications OK`);
});
