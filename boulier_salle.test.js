'use strict';
/*
 * La salle du Boulier : trois phases, un tirage pour tout le monde.
 *
 * Ce que ce fichier verifie, et que rien d'autre ne peut verifier :
 *
 *  1. L'HORLOGE. Les phases s'enchainent dans l'ordre et ne sautent pas, meme
 *     si le serveur a ete gele une minute. Une salle qui reste bloquee en
 *     « attente » ne tire plus jamais, et personne ne s'en apercoit avant que
 *     les joueurs le disent.
 *
 *  2. L'ENGAGEMENT. La chaine est publiee AVANT la premiere mise, chaque
 *     manche revele son maillon, et sha256(maillon) redonne celui d'avant.
 *     C'est toute la preuve qu'un tirage partage peut offrir : sans elle, la
 *     maison choisit les boules apres avoir vu les grilles.
 *
 *  3. CE QUI NE FUIT PAS. Les grilles des autres ne sortent jamais de la
 *     salle, et les boules n'existent pas avant la fermeture des mises.
 */
const assert = require('assert');
const crypto = require('crypto');
const { Salle, ATTENTE, TIRAGE, APRES } = require('./boulier_salle');
const B = require('./boulier');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const G = (a) => a || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const A1 = '0x' + '11'.repeat(20), A2 = '0x' + '22'.repeat(20);
function salle(o) {
  return new Salle(Object.assign({ graine: 'graine-de-test', longueur: 200,
                                   attenteMs: 10000, tirageMs: 10000, apresMs: 5000 }, o || {}));
}

// ------------------------------------------------------------- l'horloge
{
  const s = salle();
  let t = 1000000;
  eq(s.phase, APRES, 'on demarre apres : la premiere attente s ouvre au premier tick');
  const e1 = s.tick(t);
  eq(e1.length, 1, 'un seul evenement');
  eq(e1[0].type, 'boulierAttente', 'les inscriptions s ouvrent');
  eq(s.phase, ATTENTE, 'phase attente');
  eq(s.manche, 1, 'premiere manche');
  eq(e1[0].duree, 10000, 'la duree accompagne l echeance');
  /* `duree` n'est pas decoratif : l'horloge du navigateur n'est pas celle du
     serveur, et un decompte cale sur une echeance absolue afficherait
     n'importe quoi chez un joueur dont la montre retarde. */
  eq(e1[0].jusqua, t + 10000, 'echeance = maintenant + duree');

  eq(s.tick(t + 5000).length, 0, 'rien ne se passe au milieu de l attente');
  eq(s.phase, ATTENTE, 'toujours en attente');

  const e2 = s.tick(t + 10000);
  eq(e2.length, 1, 'le tirage part');
  eq(e2[0].type, 'boulierTirage', 'phase tirage');
  eq(s.phase, TIRAGE, 'phase tirage');

  const e3 = s.tick(t + 20000);
  eq(e3.length, 1, 'la manche se ferme');
  eq(e3[0].type, 'boulierFin', 'fin de manche');
  eq(s.phase, APRES, 'phase apres');

  const e4 = s.tick(t + 25000);
  eq(e4[0].type, 'boulierAttente', 'et on rouvre');
  eq(s.manche, 2, 'manche suivante');
}

/* LE SERVEUR A ETE GELE.
 *
 * La salle ne REJOUE PAS les manches manquees, et c'est voulu : chaque phase
 * se termine a `maintenant + duree`, jamais a une echeance calculee d'avance.
 * Deux minutes de gel ne produisent donc pas douze manches fantomes tirees
 * pour une salle vide — elles produisent UNE manche neuve, qui repart de
 * l'instant present avec ses dix secondes entieres.
 *
 * Le cas qu'il fallait ecarter est l'autre : rester coince dans le passe et ne
 * plus jamais tirer. C'est ce que ce test verifie. */
{
  const s = salle();
  const t = 1000000 + 120000;
  const evs = s.tick(t);                  // deux minutes d un coup
  eq(evs.length, 1, 'une manche neuve, pas douze fantomes');
  eq(s.phase, ATTENTE, 'la salle repart des inscriptions');
  eq(s.manche, 1, 'une seule manche consommee');
  ok(s.jusqua > t, 'avec une echeance DANS LE FUTUR : la salle n est pas coincee');
  eq(s.jusqua - t, 10000, 'et les dix secondes entieres, pas ce qu il en restait');
  /* Un maillon par manche, meme apres un gel : le gel ne doit pas en devorer
     une poignee au passage. */
  eq(s.index, 0, 'aucun maillon consomme tant qu on n a pas tire');

  /* La boucle est BORNEE de toute facon : si un jour une phase se terminait a
     une echeance absolue, un serveur gele trois semaines ne devrait pas rendre
     cent mille evenements d un coup. */
  const s2 = salle();
  ok(s2.tick(1000000 + 3 * 7 * 24 * 3600 * 1000).length <= 100, 'la boucle est bornee');
}

// -------------------------------------------------------- l'engagement
{
  const s = salle();
  ok(/^[0-9a-f]{64}$/.test(s.engagement), 'l engagement est une empreinte');
  let t = 1000000, precedent = s.engagement;
  for (let i = 0; i < 5; i++) {
    s.tick(t); t += 10000;
    const ev = s.tick(t)[0];
    eq(ev.type, 'boulierTirage', 'tirage ' + (i + 1));
    /* LA preuve : sha256 du maillon revele redonne celui d'avant. Un joueur
       qui a note l'engagement au demarrage peut verifier toutes les manches,
       y compris celles qu'il n'a pas vues. */
    eq(crypto.createHash('sha256').update(Buffer.from(ev.maillon, 'hex')).digest('hex'),
       precedent, 'le maillon ' + (i + 1) + ' remonte au precedent');
    precedent = ev.maillon;
    t += 10000; s.tick(t); t += 5000;
  }
  /* L'engagement ne bouge JAMAIS : c'est ce qui a ete publie. */
  eq(s.engagement, salle().engagement, 'meme graine, meme engagement');
  ok(salle({ graine: 'autre' }).engagement !== s.engagement, 'une autre graine, un autre engagement');
}

/* Le tirage est CELUI DU MAILLON, reproductible par n'importe qui. */
{
  const s = salle();
  s.tick(1000000);
  const ev = s.tick(1010000)[0];
  assert.deepStrictEqual(ev.sortie, B.tirage(ev.maillon, ev.sel, ev.manche)); n++;
  eq(ev.sortie.length, 30, '30 boules');
  eq(new Set(ev.sortie).size, 30, 'toutes distinctes');
  /* Deux salles de meme graine tirent la meme chose : c'est ce qui rend la
     verification possible, et c'est aussi ce qui interdit de rejouer un
     maillon deja consomme. */
  const s2 = salle();
  s2.tick(1000000);
  assert.deepStrictEqual(s2.tick(1010000)[0].sortie, ev.sortie); n++;
}

/* LES BOULES N'EXISTENT PAS AVANT LA FERMETURE DES MISES. */
{
  const s = salle();
  s.tick(1000000);
  const e = s.etat(1005000, A1);
  eq(e.phase, ATTENTE, 'en attente');
  eq(e.sortie, undefined, 'aucune boule pendant l inscription');
  eq(e.maillon, undefined, 'aucun maillon non plus');
  eq(s.sortie.length, 0, 'la salle elle-meme ne les a pas encore');
}

// ------------------------------------------------------- les inscriptions
{
  const s = salle();
  s.tick(1000000);
  const j = s.inscrire(A1, 'Dog', [G()], 100, 50);
  eq(j.mise, 100, 'une grille a 100');
  eq(j.grilles.length, 1, 'une grille');
  /* ON AJOUTE, on ne remplace pas : un joueur qui appuie deux fois sur « 10
     grilles » pendant les dix secondes en veut vingt, et le plafond est celui
     de la MANCHE, pas du clic. */
  s.inscrire(A1, 'Dog', [G(), G()], 100, 50);
  eq(s.joueurs.get(A1).grilles.length, 3, 'les grilles s ajoutent');
  eq(s.joueurs.get(A1).mise, 300, 'la mise aussi');

  const trop = []; for (let i = 0; i < 48; i++) trop.push(G());
  jete(() => s.inscrire(A1, 'Dog', trop, 100, 50), /at most 50/, 'le plafond est celui de la manche');
  eq(s.joueurs.get(A1).grilles.length, 3, 'un refus n ajoute rien');

  jete(() => s.inscrire(A2, 'Cat', [], 100, 50), /at least one/, 'zero grille');
  jete(() => s.inscrire(A2, 'Cat', [[1, 2, 3]], 100, 50), /exactly 10/, 'grille incomplete');
  eq(s.joueurs.size, 1, 'aucun joueur fantome apres un refus');
}

/* Hors de la fenetre, tout est refuse — c'est ce qui empeche de miser une fois
   les boules connues. */
{
  const s = salle();
  jete(() => s.inscrire(A1, 'Dog', [G()], 100, 50), /closed/, 'refus pendant apres');
  s.tick(1000000);
  s.inscrire(A1, 'Dog', [G()], 100, 50);
  s.tick(1010000);
  eq(s.phase, TIRAGE, 'les boules sont sorties');
  jete(() => s.inscrire(A2, 'Cat', [G()], 100, 50), /closed/, 'refus pendant le tirage');
}

// ------------------------------------------------------- ce qui se diffuse
{
  const s = salle();
  s.tick(1000000);
  s.inscrire(A1, 'Dog', [G(), G()], 100, 50);
  s.inscrire(A2, 'Cat', [G()], 100, 50);
  const l = s.liste();
  eq(l.length, 2, 'deux joueurs a la table');
  /* LES GRILLES DES AUTRES NE SORTENT PAS. Savoir que quelqu'un a coche le 47
     avant que le 47 sorte ne regarde personne — et cinquante grilles par
     joueur feraient dix mille numeros par diffusion. */
  eq(JSON.stringify(l).indexOf('"grille"'), -1, 'aucune grille dans la liste');
  ok(l.every((x) => typeof x.grilles === 'number'), 'seulement leur NOMBRE');
  eq(l[0].mise, 200, 'le plus gros mise en tete pendant l attente');
  ok(l.every((x) => x.nom && x.addr), 'nom et adresse pour l affichage');

  /* Le classement bascule sur le GAIN des qu il y en a un. */
  s.note(A2, [{ n: 9, lot: 120000 }], 120000, 0);
  eq(s.liste()[0].addr, A2, 'le plus gros gain passe devant');
}

/* Ce qu'un joueur voit de SA manche, et de celle des autres. */
{
  const s = salle();
  s.tick(1000000);
  s.inscrire(A1, 'Dog', [G()], 100, 50);
  const e = s.etat(1005000, A1);
  eq(e.moi.grilles.length, 1, 'je vois mes grilles');
  eq(e.moi.mise, 100, 'et ma mise');
  eq(s.etat(1005000, A2).moi, null, 'un joueur non inscrit n a pas de manche');
  eq(s.etat(1005000).moi, undefined, 'un spectateur non plus');
  ok(s.etat(1005000).joueurs.length === 1, 'mais il voit la table');
}

/* ARRIVER EN COURS DE TIRAGE. Sans `avance`, quelqu'un qui ouvre la page a la
   vingtieme boule verrait le tirage repartir de la premiere — et le resultat
   tomberait dix secondes apres celui des autres. */
{
  const s = salle();
  s.tick(1000000);
  s.tick(1010000);                       // les boules sortent
  eq(s.etat(1010000, null).avance, 0, 'au debut du tirage, aucune boule tombee');
  const mi = s.etat(1015000, null);
  ok(mi.avance >= 12 && mi.avance <= 18, `a mi-parcours, ${mi.avance} boules`);
  ok(mi.sortie.length === 30, 'la liste entiere part quand meme');
  eq(s.etat(1019999, null).avance, 29, 'presque au bout');
  s.tick(1020000);
  eq(s.etat(1021000, null).avance, 30, 'apres le tirage, tout est tombe');
}

// --------------------------------------------------------- la sauvegarde
{
  const s = salle();
  let t = 1000000;
  for (let i = 0; i < 3; i++) { s.tick(t); t += 10000; s.tick(t); t += 10000; s.tick(t); t += 5000; }
  const av = s.sauve();
  eq(av.index, 3, 'trois maillons consommes');

  const s2 = salle();
  s2.charge(av);
  s2.tick(t); t += 10000;
  const ev = s2.tick(t)[0];
  /* UN MAILLON DEJA CONSOMME NE SE REJOUE PAS. Sans l index sauve, la salle
     repartirait du premier maillon apres chaque redeploiement : les memes
     trente boules, encore et encore, connues de qui a vu la manche d avant. */
  eq(ev.maillon, s.maillons[3], 'on reprend au maillon suivant, pas au premier');
  eq(s2.manche, 4, 'et le numero de manche continue');

  /* Les joueurs, eux, ne se reprennent PAS : une manche a moitie inscrite dont
     tout le monde a ete deconnecte n a plus d arbitre. */
  eq(s2.joueurs.size, 0, 'la salle relue est vide de joueurs');
}

console.log(`boulier_salle.test.js : ${n} verifications OK`);
