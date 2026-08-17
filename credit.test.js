'use strict';
/*
 * CREDITER UN JOUEUR DEPUIS LE PANNEAU.
 *
 * ---- ce qui est en jeu ----
 *
 * Ces jetons-la ne viennent d'aucun depot. Ils augmentent ce que la maison
 * doit sans rien ajouter au coffre : c'est le seul bouton du panneau qui
 * puisse, a lui seul, rendre le casino insolvable. Il n'y a donc pas de
 * « petit » test ici — chaque verrou compte.
 *
 * Quatre choses, et la troisieme est celle qui se contourne le plus vite :
 *
 *   1. le credit arrive bien, chez le bon joueur, trouve par son NOM ;
 *   2. il se raconte : une ligne au journal du joueur, une ligne aux comptes.
 *      Un solde qui monte sans explication se prend pour un bug ;
 *   3. L'ENVELOPPE EST GLOBALE ET GLISSANTE. Un plafond par envoi se
 *      contourne en dix clics : ce qui est borne est le total sorti sur la
 *      fenetre, tous joueurs confondus ;
 *   4. elle survit au redemarrage. Un plafond garde en memoire du processus
 *      se remet a zero a chaque redeploiement — c'est-a-dire qu'il n'existe
 *      pas.
 */
const assert = require('assert');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/credit-test-');

const { Game } = require('./game');
const journal = require('./journal');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = ('0x' + 'a1'.repeat(20)).toLowerCase();
const B = ('0x' + 'b2'.repeat(20)).toLowerCase();
const sol = (g, a) => Number(g.balanceStr(a));
const T0 = Date.parse('2026-08-17T12:00:00Z');
const H = 3600000;
const MAX = cfg.CREDIT_ADMIN_MAX, FEN = cfg.CREDIT_ADMIN_FENETRE_H;

function jeu() {
  const g = new Game();
  /* On pose le nom a la main : `setPublicName` facture le nom unique, et ce
     n'est pas ce qu'on teste ici. */
  const p = g._p(A); p.name = 'Dominic'; p.nomChoisi = true;
  g._p(B);
  return g;
}

// ============================================ 1. LE CREDIT ARRIVE, PAR NOM
{
  const g = jeu();
  eq(sol(g, A), 0, 'le joueur part de zero');

  const e0 = g.enveloppeCredit(T0);
  eq(e0.reste, MAX, `l enveloppe est pleine (${MAX})`);
  eq(e0.envois, 0, 'et personne n a encore rien recu');
  eq(e0.libereDansMs, 0, 'rien a liberer : rien n a ete envoye');

  const r = g.crediteJoueur('Dominic', 5000, T0, 'dedommagement pari b12');
  eq(r.addr, A, 'le nom a bien trouve son adresse');
  eq(r.nom, 'Dominic', 'et le panneau peut le renommer dans sa confirmation');
  eq(r.montant, 5000, 'le montant est celui demande');
  eq(sol(g, A), 5000, 'et il est sur le solde');
  eq(r.enveloppe.reste, MAX - 5000, 'l enveloppe a baisse d autant');

  /* La casse et les accents ne doivent pas faire echouer la recherche : c'est
     la meme cle que l'unicite des noms. Sans ca, l'exploitant conclut que le
     joueur n'existe pas. */
  g.crediteJoueur('DOMINIC', 1000, T0, '');
  eq(sol(g, A), 6000, 'la casse ne change rien');
  /* Et l'adresse marche aussi — c'est ce qu'on recolle depuis le tableau. */
  g.crediteJoueur(B, 2000, T0, '');
  eq(sol(g, B), 2000, 'un joueur sans nom se credite par son adresse');

  /* Un montant a virgule est tronque, pas arrondi vers le haut : on ne cree
     jamais plus que ce qui a ete tape. */
  g.crediteJoueur('Dominic', 10.9, T0, '');
  eq(sol(g, A), 6010, 'un montant a virgule est tronque');
}

// ================================================ 2. CA SE RACONTE
{
  const g = jeu();
  g.crediteJoueur('Dominic', 4200, T0, 'lot du concours');
  /* Les comptes du mois : un cadeau COUTE, au meme titre qu'un bonus. Le
     ranger dans le bilan le rendrait invisible au resultat du mois, et un
     resultat qui ignore ce qu'on donne se lit comme un benefice. */
  const c = g.comptes();
  eq(c.cadeaux, 4200, 'les comptes du mois portent le cadeau');
  ok(c.couts >= 4200, 'et il pese dans les couts, pas dans le bilan');
}

// ================== 3. L ENVELOPPE EST GLOBALE, GLISSANTE, ET ELLE TIENT
{
  const g = jeu();
  /* Plusieurs joueurs, plusieurs envois : c'est le TOTAL qui compte. */
  g.crediteJoueur('Dominic', MAX / 2, T0, '');
  g.crediteJoueur(B, MAX / 2, T0 + 60000, '');
  const e = g.enveloppeCredit(T0 + 120000);
  eq(e.utilise, MAX, 'les deux envois remplissent l enveloppe');
  eq(e.reste, 0, 'il ne reste rien');
  eq(e.envois, 2, 'et elle sait combien d envois la remplissent');

  jete(() => g.crediteJoueur('Dominic', 1, T0 + 120000, ''), /already sent/,
    'un jeton de plus est refuse — meme sur un autre joueur');
  eq(sol(g, A), MAX / 2, 'et rien n a bouge');

  /* LE REFUS DIT QUAND. « Vous ne pouvez plus envoyer » sans heure se lit
     comme une panne, et on reclique dix fois pour voir. */
  try { g.crediteJoueur(B, 1, T0 + 120000, ''); }
  catch (e2) { ok(/frees up in/.test(e2.message), `le refus dit quand : « ${e2.message} »`); }

  /* La fenetre GLISSE : le premier envoi sort douze heures apres avoir ete
     fait, pas au prochain minuit. */
  eq(g.enveloppeCredit(T0 + FEN * H - 60000).reste, 0, 'une minute avant, toujours rien');
  const apres = g.enveloppeCredit(T0 + FEN * H + 1000);
  eq(apres.reste, MAX / 2, 'une seconde apres, la moitie est rendue');
  eq(apres.envois, 1, 'et il ne reste qu un envoi dans la fenetre');
  eq(g.enveloppeCredit(T0 + FEN * H + 2 * 60000).reste, MAX,
     'puis le second sort a son tour, et tout est rendu');
}

// ============================ 3bis. CE QUE LES DEUX BARRES DOIVENT DIRE
/* La jauge repond a « combien reste-t-il », la barre de temps a « quand
   est-ce que ca revient ». Le rebours vise le PROCHAIN envoi a sortir — pas
   le dernier, qui est le plus lointain des deux. */
{
  const g = jeu();
  g.crediteJoueur('Dominic', 100000, T0, '');
  g.crediteJoueur(B, 50000, T0 + 3 * H, '');
  const e = g.enveloppeCredit(T0 + 6 * H);
  eq(Math.round(e.libereDansMs / 60000), (FEN - 6) * 60,
     'le rebours vise le plus ancien envoi');
  eq(e.libereMontant, 100000, 'et annonce ce qu il rendra');
  eq(Math.round(e.videDansMs / 60000), (FEN - 3) * 60,
     'l enveloppe entiere revient avec le plus recent');
  eq(e.derniers[0].montant, 50000, 'la liste des envois va du plus recent au plus ancien');
  eq(e.derniers[0].addr, B, 'chaque envoi porte son destinataire');
  eq(e.derniers[1].nom, 'Dominic', 'et son nom quand il en a un');
}

// ==================================== 4. CE QUI EST REFUSE, ET POURQUOI
{
  const g = jeu();
  jete(() => g.crediteJoueur('Personne', 100, T0, ''), /unknown player/,
    'un nom qui n existe pas');
  jete(() => g.crediteJoueur('0x' + 'c3'.repeat(20), 100, T0, ''), /unknown player/,
    'une adresse jamais vue — aucun compte n est cree au passage');
  jete(() => g.crediteJoueur('Dominic', 0, T0, ''), /positive whole number/, 'zero');
  jete(() => g.crediteJoueur('Dominic', -50, T0, ''), /positive whole number/, 'un montant negatif');
  jete(() => g.crediteJoueur('Dominic', 'beaucoup', T0, ''), /positive whole number/,
    'un montant qui n en est pas un');
  jete(() => g.crediteJoueur('Dominic', MAX + 1, T0, ''), /left in this/,
    'et un montant plus gros que ce qui reste');
  eq(sol(g, A), 0, 'aucun de ces refus n a credite quoi que ce soit');
  eq(g.enveloppeCredit(T0).utilise, 0, 'ni entame l enveloppe');

  /* Le montant se plafonne AU RESTE, pas au maximum : c'est la difference
     entre « il reste mille » et « le plafond est cinq cent mille ». */
  g.crediteJoueur('Dominic', MAX - 1000, T0, '');
  jete(() => g.crediteJoueur('Dominic', 1001, T0, ''), /only 1000 \$SWOGE left/,
    'le refus chiffre ce qui reste');
  g.crediteJoueur('Dominic', 1000, T0, '');
  eq(sol(g, A), MAX, 'et le dernier jeton de l enveloppe passe');
}

// ============================== 5. L ENVELOPPE SURVIT AU REDEMARRAGE
/* Le verrou le plus facile a perdre : un plafond garde en memoire du
   processus se remet a zero a chaque redeploiement. */
{
  const g = jeu();
  g.crediteJoueur('Dominic', MAX, T0, 'tout d un coup');
  const etat = JSON.parse(JSON.stringify(g.serialize()));
  ok(Array.isArray(etat.dons) && etat.dons.length === 1,
     'les envois partent dans l etat sauvegarde');

  const g2 = new Game();
  g2.hydrate(etat);
  eq(g2.enveloppeCredit(T0 + 60000).utilise, MAX,
     'apres redemarrage, l enveloppe est toujours vide');
  jete(() => g2.crediteJoueur('Dominic', 1, T0 + 60000, ''), /already sent/,
    'et le plafond tient');
  eq(g2.enveloppeCredit(T0 + (FEN + 1) * H).reste, MAX,
     'la fenetre reprend son cours normalement');
}

// ===================== 6. LES VIEUX ENVOIS NE S ACCUMULENT PAS DANS L ETAT
/* La liste ne sert qu'a la fenetre. Un tableau qui grandit pour toujours
   finit dans chaque sauvegarde, toutes les dix secondes. */
{
  const g = jeu();
  for (let i = 0; i < 5; i++) g.crediteJoueur('Dominic', 10, T0 - (i + 2) * FEN * H, '');
  g.enveloppeCredit(T0);
  eq((g.dons || []).length, 0, 'les envois sortis de la fenetre sont purges');
}

// ============================ 7. LA LIGNE AU JOURNAL DU JOUEUR
/* Ecrite de facon differee : on laisse la file partir avant de relire. */
setTimeout(() => {
  const l = journal.lit(A, { limite: 50 });
  const lignes = l.evenements.filter((x) => x.k === 'ca');
  ok(lignes.length > 0, 'une ligne « ca » est ecrite au journal du joueur');
  ok(lignes.every((x) => Number(x.m) > 0), 'chacune porte son montant');
  ok(lignes.some((x) => x.note === 'dedommagement pari b12'),
     'et le motif, quand il y en a un — le seul mot que le joueur recevra');
  console.log(`\ncredit.test.js : ${n} verifications OK\n`);
}, 400);
