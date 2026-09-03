'use strict';
/*
 * QUAND LA RENCONTRE DISPARAIT DU CALENDRIER.
 *
 * ---- ce qui s'est passe le 17 aout 2026 ----
 *
 * Un pari simple, « Draw @ 3.30 » sur Deportivo – Elche. Le match se joue,
 * le serveur redemarre, et la carte du pari affiche « ? – ? ». La rencontre
 * ne figure plus dans « Matches waiting for a result » : aucun bouton
 * « Draw » nulle part, et `/paris/regle` repond « unknown match ». Le joueur
 * a gagne et personne ne peut le payer.
 *
 * La cause tenait en une ligne : l'import ecrivait le catalogue dans le
 * dossier de l'application — efface a chaque redeploiement — au lieu du
 * volume. Le calendrier revenait a l'amorce du depot, ou la Liga du 17 aout
 * n'a jamais figure.
 *
 * Ce fichier verifie les deux moities de la reparation :
 *
 *   1. le catalogue vit sur le VOLUME des qu'il y est ecrit ;
 *   2. et meme si une rencontre en sort quand meme — retention depassee,
 *      volume perdu, ligue retiree — les paris poses dessus restent
 *      AFFICHABLES et REGLABLES. Un pari gagnant qu'on ne peut pas payer est
 *      la pire panne de tout le serveur : elle ne casse rien, elle vole.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

/* Le volume d'essai doit exister AVANT le premier require('./paris') : le
   module resout son fichier au chargement. */
const VOLUME = fs.mkdtempSync('/tmp/paris-hors-calendrier-');
process.env.DATA_DIR = VOLUME;

const { ethers } = require('ethers');
const { Game } = require('./game');
const paris = require('./paris');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x' + 'a1'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
const sol = (g, a) => Number(g.betBalanceStr(a));
const AVANT = Date.parse('2026-08-15T09:00:00Z');   // avant les coups d'envoi
const APRES = Date.parse('2026-08-15T20:00:00Z');   // apres
const M = 'efl-20260815-bol-pre';                   // un match de foot, 1-N-2

const DEPOT = JSON.parse(fs.readFileSync(paris.FICHIER_DEPOT, 'utf8'));
const CIBLE = DEPOT.matchs.find((m) => m.id === M);
ok(!!CIBLE, 'le match temoin est bien dans l amorce du depot');

/** Ecrit un catalogue sur le volume, et le fait relire au serveur. */
function volume(matchs) {
  fs.writeFileSync(paris.FICHIER_VOLUME,
    JSON.stringify({ sports: DEPOT.sports, matchs }, null, 1) + '\n');
  paris.charge();
}

// ==================================================== 1. LE VOLUME L EMPORTE
/* C'est la reparation de fond : ce que l'import ecrit doit survivre au
   redeploiement, sinon tout le reste n'est que rattrapage. */
{
  eq(paris.fichier(), paris.FICHIER_DEPOT,
    'volume vide : on lit l amorce du depot');
  volume(DEPOT.matchs);
  eq(paris.fichier(), paris.FICHIER_VOLUME,
    'des que le volume porte un catalogue, c est LUI qu on lit');
  eq(path.dirname(paris.FICHIER_VOLUME), VOLUME,
    'et il est bien sur le volume, pas dans le dossier de l application');
  ok(!!paris.match(M), 'le match temoin est ouvert');
}

// ============================ 2. UNE RENCONTRE QUI SORT RESTE AFFICHABLE
/* Le pari garde sa rencontre : les noms viennent du TICKET, pas du
   calendrier du jour. */
{
  const g = new Game();
  g._p(A).balance = W(100000); g._p(A).betBalance = W(100000);
  const pari = g.parie(A, M, 'N', 1000, AVANT);
  eq(pari.jambes[0].domicile, CIBLE.domicile, 'la jambe garde le nom de l equipe a domicile');
  eq(pari.jambes[0].exterieur, CIBLE.exterieur, 'et celui de l exterieur');
  eq(pari.jambes[0].issues.join(''), '1N2', 'et les issues du sport');

  /* Le redeploiement : la rencontre quitte le calendrier. */
  volume(DEPOT.matchs.filter((m) => m.id !== M));
  eq(paris.match(M), null, 'la rencontre a bien disparu du calendrier');

  const vue = g.tousParis({ now: APRES });
  const j = vue.paris[0].jambes[0];
  eq(j.domicile, CIBLE.domicile, 'le panneau affiche encore le nom, pas « ? »');
  eq(j.horsCalendrier, true, 'et signale que la rencontre est hors calendrier');
  eq(vue.paris[0].etat, 'a regler', 'le pari demande une action, il n est pas « en cours »');

  const att = g.parisAregler(APRES);
  const carte = att.find((x) => x.id === M);
  ok(!!carte, 'la rencontre revient dans la liste a regler');
  eq(carte.horsCalendrier, true, 'marquee hors calendrier');
  eq(carte.sansFiche, false, 'mais avec sa fiche, gardee par le pari');
  eq(carte.issues.join(''), '1N2', 'les trois issues sont proposees');
  eq(carte.expo.N, Math.round(pari.rapport), 'et l exposition du nul est celle du pari');

  const avant = sol(g, A);
  const r = g.regleMatch(M, 'N');
  eq(r.gagnants, 1, 'le gagnant est paye');
  eq(Math.round(sol(g, A) - avant), Math.round(pari.rapport), 'du bon montant');
  ok(!g.parisAregler(APRES).some((x) => x.id === M), 'et la rencontre sort de la liste');
}

// ================= 3. LES PARIS D AVANT, CEUX QUI N ONT PAS DE FICHE
/* Le pari du 17 aout a ete pose avant que les jambes ne gardent leur
   rencontre : il ne reste que l'identifiant. Il doit rester reglable —
   c'est tout l'objet de cette reparation. */
{
  volume(DEPOT.matchs);
  const g = new Game();
  g._p(A).balance = W(100000); g._p(A).betBalance = W(100000);
  const pari = g.parie(A, M, 'N', 1000, AVANT);
  /* On retire la fiche de la jambe : c'est exactement l'etat sauvegarde des
     paris poses avant ce correctif. */
  for (const j of pari.jambes) {
    delete j.domicile; delete j.exterieur; delete j.debut;
    delete j.sport; delete j.competition; delete j.issues;
  }
  volume(DEPOT.matchs.filter((m) => m.id !== M));

  const carte = g.parisAregler(APRES).find((x) => x.id === M);
  ok(!!carte, 'la rencontre sans fiche remonte quand meme');
  eq(carte.sansFiche, true, 'et se declare comme telle');
  eq(carte.domicile, '?', 'faute de mieux, elle n a pas de nom');
  eq(carte.issues.join(''), '1N2', 'on propose les trois issues du 1-N-2');
  eq(carte.paris, 1, 'le pari est compte');

  const avant = sol(g, A);
  const r = g.regleMatch(M, 'N');
  eq(r.gagnants, 1, 'et le joueur est paye');
  eq(Math.round(sol(g, A) - avant), Math.round(pari.rapport), 'du bon montant');
}

// ================================ 4. UN IDENTIFIANT INVENTE RESTE REFUSE
/* La souplesse s'arrete la : sans pari en jeu, un identifiant inconnu est
   une faute de frappe, et trancher une faute de frappe grave un resultat
   dans l'etat pour toujours. */
{
  volume(DEPOT.matchs);
  const g = new Game();
  jete(() => g.regleMatch('rien-du-tout-20260817', '1'), /unknown match/,
    'un identifiant sans pari est refuse');
  g._p(A).balance = W(100000); g._p(A).betBalance = W(100000);
  g.parie(A, M, '1', 1000, AVANT);
  volume(DEPOT.matchs.filter((m) => m.id !== M));
  jete(() => g.regleMatch(M, 'X'), /must be a score like 2-1, or one of/,
    'et une issue qui n existe pas, aussi — le message nomme desormais les DEUX'
    + ' formes acceptees, le score en premier');
}

// ============================================ 5. LE REMBOURSEMENT N A JAMAIS
//                                                 DEPENDU DU CALENDRIER
{
  const g = new Game();
  g._p(A).balance = W(100000); g._p(A).betBalance = W(100000);
  volume(DEPOT.matchs);
  const pari = g.parie(A, M, '2', 1000, AVANT);
  volume(DEPOT.matchs.filter((m) => m.id !== M));
  const avant = sol(g, A);
  const r = g.rembourseMatch(M);
  eq(r.paris, 1, 'le remboursement porte bien sur le pari');
  eq(Math.round(sol(g, A) - avant), pari.mise, 'la mise est rendue');
}

/* On retire le catalogue d'essai, pas le dossier : le journal du moteur y
   ecrit encore de facon differee, et lui couper le sol sous les pieds ferait
   passer une reussite pour une erreur. */
try { fs.rmSync(paris.FICHIER_VOLUME, { force: true }); } catch (e) {}
console.log(`\n${n} verifications passees.\n`);
