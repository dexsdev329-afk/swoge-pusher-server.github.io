'use strict';
/*
 * Les paris sportifs.
 *
 * ---- pourquoi ce fichier est le plus severe du lot ----
 *
 * Partout ailleurs dans ce serveur, une manche se regle dans la seconde : la
 * maison ne doit jamais rien a personne pendant plus d'un instant. Ici la mise
 * part le vendredi et le resultat tombe le samedi. Entre les deux, la maison
 * porte un ENGAGEMENT, et trois choses peuvent mal tourner sans que personne
 * ne le voie avant le moment de payer :
 *
 *   • une COTE qui change entre la prise du pari et le reglement. Corriger une
 *     faute de frappe dans le catalogue ne doit pas toucher ce qu'un joueur a
 *     deja accepte ;
 *   • un ENGAGEMENT qui depasse ce que le coffre peut porter. Le plafond
 *     compte l'issue la PIRE, pas la somme des mises — c'est la seule mesure
 *     qui dit ce qu'on devra vraiment sortir ;
 *   • un match REGLE DEUX FOIS, qui cree de l'argent en silence.
 *
 * Et une quatrieme, qui ne se voit qu'apres un redeploiement : des paris qui
 * ne survivent pas au redemarrage. Le vendredi soir, ca efface tout ce qui a
 * ete pose pour le samedi.
 */
const assert = require('assert');
const { ethers } = require('ethers');
const { Game } = require('./game');
const paris = require('./paris');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const W = (v) => ethers.utils.parseUnits(String(v), cfg.DECIMALS);
/* Le solde des PARIS : un pari se joue en $SWOGEBET, jamais en $SWOGE. */
const sol = (g, a) => Number(g.betBalanceStr(a));
const AVANT = Date.parse('2026-08-15T09:00:00Z');   // avant tous les coups d'envoi
const APRES = Date.parse('2026-08-15T20:00:00Z');   // apres tous
const M = 'efl-20260815-bol-pre';                    // Bolton-Preston, 2.12 / 3.22 / 3.17

function jeu(credit) {
  const g = new Game();
  for (const a of [A, B]) { g._p(a).balance = W(credit || 1000000); g._p(a).betBalance = W(credit || 1000000); }
  return g;
}

// ============================ LE CATALOGUE PORTE UNE VRAIE MARGE
/* C'est ce qui rend tout le systeme viable : on recopie les cotes d'un
   bookmaker, et son benefice devient le notre. Sans marge, on offrirait un
   pari equitable a des gens qui savent compter. */
{
  const c = paris.catalogue();
  eq(c.matchs.filter((m) => m.sport === 'foot').length, 8, 'les huit matchs de football');
  eq(c.matchs.filter((m) => m.sport === 'tennis').length, 14, 'et les quatorze de tennis');
  let mini = 1;
  for (const m of c.matchs) {
    ok(m.marge >= paris.MARGE_MIN, `${m.domicile}-${m.exterieur} : marge ${(m.marge * 100).toFixed(2)} %`);
    mini = Math.min(mini, m.marge);
  }
  ok(mini > 0.05, `la plus faible marge du lot vaut ${(mini * 100).toFixed(2)} % — ` +
     'l avantage de la maison est trois fois celui du casino');
  eq(c.sports.filter((s) => s.actif).map((s) => s.cle).join(','), 'foot,tennis',
     'football et tennis sont ouverts, la NBA pas encore');
  /* LE TENNIS N A PAS DE MATCH NUL. Proposer un « N » a 0 % serait offrir un
     pari qui ne peut jamais passer. */
  const t = c.matchs.find((m) => m.sport === 'tennis');
  eq(t.issues.join(','), '1,2', 'un match de tennis n a que deux issues');
  eq(c.matchs.find((m) => m.sport === 'foot').issues.join(','), '1,N,2',
     'un match de football en a trois');
}

// ============================ un catalogue de travers NE SE CHARGE PAS
/* Le seul endroit du serveur ou une faute de frappe devient directement de
   l'argent. Un fichier refuse arrete le serveur, ce qui se voit ; une cote
   absurde acceptee ne se voit qu'au moment de payer. */
{
  const bon = { sports: [{ cle: 'foot', nom: 'Football', actif: true }],
                matchs: [{ id: 'essai-un', sport: 'foot', debut: '2026-09-01T12:00:00Z',
                           domicile: 'A', exterieur: 'B', cotes: { 1: 2.1, N: 3.2, 2: 3.2 } }] };
  ok(paris.valide(JSON.parse(JSON.stringify(bon))), 'un catalogue correct passe');

  const casse = (f, re, quoi) => {
    const c = JSON.parse(JSON.stringify(bon)); f(c);
    jete(() => paris.valide(c), re, quoi);
  };
  casse((c) => { c.matchs[0].cotes['1'] = 21; }, /marge/i,
        'une cote a 21 au lieu de 2,1 : la marge devient negative, on refuse');
  casse((c) => { c.matchs[0].cotes['1'] = 1.001; }, /hors bornes/,
        'une cote sous 1,01 ne rapporte rien');
  casse((c) => { c.matchs[0].cotes['1'] = 500; }, /hors bornes/,
        'une cote a 500 engagerait la maison pour cinquante millions');
  casse((c) => { delete c.matchs[0].cotes.N; }, /cote/, 'une issue manquante');
  casse((c) => { c.matchs[0].debut = 'samedi'; }, /date/, 'une date illisible');
  casse((c) => { c.matchs[0].sport = 'curling'; }, /sport inconnu/, 'un sport hors liste');
  casse((c) => { c.matchs.push(JSON.parse(JSON.stringify(c.matchs[0]))); }, /en double/,
        'DEUX MATCHS DE MEME IDENTIFIANT : ils partageraient paris et reglement');
}

// ================================ poser un pari, et ce qu il coute
{
  const g = jeu();
  const p = g.parie(A, M, '1', 1000, AVANT);
  eq(sol(g, A), 999000, 'la mise quitte le solde tout de suite');
  eq(p.cote, 2.12, 'la cote du catalogue est recopiee DANS le pari');
  eq(p.rapport, 2120, 'et le rapport est calcule une fois pour toutes');
  eq(g.engagementMatch(M), 2120, 'la maison porte cet engagement jusqu au reglement');

  const mien = g.mesParis(A);
  eq(mien.length, 1, 'le joueur retrouve son pari');
  eq(mien[0].domicile, 'Bolton', 'avec le nom des equipes, pas juste un identifiant');
}

// ==================== LA COTE NE BOUGE PLUS, MEME SI LE CATALOGUE CHANGE
/* Le defaut le plus insidieux : on corrige une coquille dans le catalogue le
   samedi matin, et les paris du vendredi se reglent au nouveau tarif. */
{
  const g = jeu();
  g.parie(A, M, '1', 1000, AVANT);
  const m = paris.match(M);
  /* Les cotes vivent DANS leur marche depuis qu'un match en porte plusieurs :
     le 1-N-2 n'est que le premier d'entre eux. */
  const lot = m.marches[paris.MARCHE_BASE].cotes;
  const vraie = lot['1'];
  lot['1'] = 1.10;                           // quelqu un « corrige » le catalogue
  try {
    const r = g.regleMatch(M, '1');
    eq(r.paye, 2120, 'le pari est paye a la cote ACCEPTEE (2,12), pas a la nouvelle');
  } finally { lot['1'] = vraie; }
}

// ================================ LES SIX MARCHES
/*
 * ---- CE QUI ETAIT DEMANDE ----
 * « Les deux equipes marquent, double chance, plus/moins de 2,5 buts, score
 * exact, handicap. »
 *
 * ---- CE QU UN MARCHE DOIT DIRE, ET POURQUOI EN UN SEUL ENDROIT ----
 * Quelles reponses il accepte, comment il se REGLE a partir du score, et
 * combien de fois ses reponses couvrent l espace des resultats. Eparpillees,
 * elles finiraient par ne plus parler du meme marche — et c est celle qu on
 * oublie qui paie les mauvaises personnes.
 */
{
  eq(paris.marchesDuSport('foot').join(','), '1n2,dc,btts,ou25,score,hand',
     'le football porte les six marches');
  eq(paris.marchesDuSport('tennis').join(','), '1n2',
     'le tennis n en porte qu un : une double chance sur deux issues couvrirait'
     + ' tout et se paierait a coup sur');
  eq(paris.marchesDuSport('nba').join(','), '1n2', 'la NBA non plus');
}
/* ---- CHAQUE MARCHE SE REGLE DEPUIS LE SCORE, ET RIEN D AUTRE ----
 * C est ce qui garantit que deux marches ne peuvent pas se contredire sur la
 * meme rencontre : ils lisent le meme couple de nombres. */
{
  const g2 = (c, i, s) => paris.gagne(c, i, paris.scoreLu(s));
  ok(g2('1n2', '1', '2-1') && !g2('1n2', '1', '1-2'), '1-N-2 : le domicile l emporte');
  ok(g2('1n2', 'N', '1-1'), 'et le nul se lit dans l egalite');

  ok(g2('btts', 'oui', '2-1'), 'les deux equipes marquent sur un 2-1');
  ok(g2('btts', 'non', '2-0'), 'et non sur un 2-0');
  ok(g2('btts', 'non', '0-0'), 'ni sur un 0-0');
  ok(!g2('btts', 'oui', '3-0'), "trois buts d un cote ne suffisent pas : c est l AUTRE"
     + ' qui doit marquer aussi');

  ok(g2('dc', '1X', '1-0') && g2('dc', '1X', '1-1') && !g2('dc', '1X', '0-1'),
     'double chance 1X : la victoire a domicile ou le nul');
  ok(g2('dc', '12', '1-0') && g2('dc', '12', '0-1') && !g2('dc', '12', '1-1'),
     'double chance 12 : l un ou l autre, mais pas le nul');
  ok(g2('dc', 'X2', '1-1') && g2('dc', 'X2', '0-1') && !g2('dc', 'X2', '1-0'),
     'double chance X2 : le nul ou l exterieur');

  ok(g2('ou25', 'plus', '2-1') && !g2('ou25', 'plus', '1-1'),
     'plus de deux buts et demi : trois buts oui, deux non');
  ok(g2('ou25', 'moins', '2-0') && g2('ou25', 'moins', '0-0'),
     'et le moins prend tout ce qui est en dessous');

  ok(g2('score', '2-1', '2-1') && !g2('score', '2-1', '1-2'),
     'le score exact ne pardonne pas le sens');
  ok(g2('score', 'autre', '5-0') && !g2('score', 'autre', '2-1'),
     "« autre » ramasse ce que la grille ne nomme pas — sans lui, un 5-0 ne"
     + ' paierait personne ET ne perdrait personne, ce qui n est pas un pari');

  ok(g2('hand', '1', '2-0') && !g2('hand', '1', '2-1'),
     'handicap moins un but et demi : il faut gagner de DEUX');
  ok(g2('hand', '2', '2-1') && g2('hand', '2', '0-0') && g2('hand', '2', '1-3'),
     'et l autre reponse prend tout le reste');
}
/* ---- LA DEMI-LIGNE SUPPRIME LE REMBOURSEMENT AU LIEU DE LE GERER ----
 * Une ligne ENTIERE — « plus de 2 buts » sur un match a 2 — demanderait
 * d annuler ce pari-la et lui seul, alors que le remboursement ne sait
 * aujourd hui annuler qu une rencontre entiere. Sur toute la grille des
 * scores plausibles, exactement une reponse tombe, jamais zero ni deux. */
{
  for (const [cle, iss] of [['ou25', ['plus', 'moins']], ['hand', ['1', '2']],
                            ['btts', ['oui', 'non']], ['1n2', ['1', 'N', '2']]]) {
    let toujoursUne = true;
    for (let a2 = 0; a2 <= 6; a2++) for (let b2 = 0; b2 <= 6; b2++) {
      const n2 = iss.filter((i) => paris.gagne(cle, i, { a: a2, b: b2 })).length;
      if (n2 !== 1) toujoursUne = false;
    }
    ok(toujoursUne, `« ${cle} » : sur les quarante-neuf scores de zero a six,`
       + ' exactement une reponse tombe — jamais zero, jamais deux');
  }
  /* La double chance, elle, en fait tomber DEUX sur trois. Ce n est pas un
     defaut, c est sa definition — et c est pourquoi sa marge se mesure
     autrement. */
  let deuxPartout = true;
  for (let a2 = 0; a2 <= 6; a2++) for (let b2 = 0; b2 <= 6; b2++) {
    const n2 = ['1X', '12', 'X2'].filter((i) => paris.gagne('dc', i, { a: a2, b: b2 })).length;
    if (n2 !== 2) deuxPartout = false;
  }
  ok(deuxPartout, 'la double chance en fait tomber DEUX sur trois, toujours :'
     + ' c est sa definition, et c est pourquoi sa couverture vaut deux');
}
/* ---- ET LA MARGE SE MESURE AVEC LA COUVERTURE ----
 * La prendre pour un annoncerait la double chance a 105 % et laisserait passer
 * un lot ou la maison perd a coup sur. On le PROUVE en fabriquant un lot juste
 * — marge nulle — et en verifiant que les deux lectures ne disent pas la meme
 * chose. */
{
  const juste = { '1X': 1 / 0.6, 12: 1 / 0.75, X2: 1 / 0.65 };   // somme des probas = 2
  const bonne = paris.margeDe(juste, ['1X', '12', 'X2'], 2);
  const fausse = paris.margeDe(juste, ['1X', '12', 'X2'], 1);
  ok(Math.abs(bonne) < 1e-9,
     `un lot juste a une marge nulle quand on compte la couverture (${bonne.toFixed(6)})`);
  ok(fausse > 0.9,
     `et l annoncerait a ${(fausse * 100).toFixed(0)} % si on la prenait pour un —`
     + ' le validateur laisserait alors passer n importe quoi');
}
/* ---- LE CATALOGUE REFUSE CE QU IL NE SAIT PAS REGLER ---- */
{
  const base = JSON.parse(JSON.stringify(
    { sports: [{ cle: 'foot', nom: 'Football', actif: true }],
      matchs: [{ id: 'essai-marches', sport: 'foot', domicile: 'A', exterieur: 'B',
                 debut: '2030-01-01T12:00:00Z',
                 marches: { '1n2': { cotes: { 1: 2.4, N: 3.4, 2: 3.0 } },
                            btts: { cotes: { oui: 1.8, non: 1.9 } } } }] }));
  const v = paris.valide(base);
  eq(Object.keys(v.matchs[0].marches).sort().join(','), '1n2,btts',
     'un match peut porter plusieurs marches');
  eq(paris.coteDe(v.matchs[0], 'btts', 'oui'), 1.8, 'et chacun garde ses cotes');

  const casse2 = (f, re, quoi) => {
    const c = JSON.parse(JSON.stringify(base)); f(c);
    jete(() => paris.valide(c), re, quoi);
  };
  casse2((c) => { delete c.matchs[0].marches['1n2']; }, /n a pas de marche/,
     'un match sans 1-N-2 est refuse : c est le seul que tout sport porte, et'
     + ' celui dont le reglement deduit les autres');
  casse2((c) => { c.matchs[0].marches.zzz = { cotes: { a: 2 } }; }, /marche inconnu/,
     'un marche que personne ne sait regler est refuse');
  casse2((c) => { c.matchs[0].sport = 'tennis';
                  c.sports.push({ cle: 'tennis', nom: 'Tennis', actif: true });
                  /* Une vraie marge sur le 1-N-2 : sans elle c est LUI qui
                     tomberait en premier, et l'essai croirait avoir prouve le
                     refus du marche alors qu'il n'aurait prouve que le sien. */
                  c.matchs[0].marches['1n2'] = { cotes: { 1: 1.8, 2: 2.0 } }; },
     /n existe pas en tennis/, 'ni un marche que le sport ne porte pas');
  casse2((c) => { delete c.matchs[0].marches.btts.cotes.non; }, /cote « btts.non »/,
     'une reponse sans cote est refusee, et le message NOMME laquelle');
  casse2((c) => { c.matchs[0].marches.btts.cotes.oui = 8; }, /marge trop faible/,
     'et un lot sans marge aussi, marche par marche');
}

// ============ CE QUI PART VERS LA PAGE GARDE LE 1-N-2 A PLAT
/* ---- UNE PAGE DEJA SERVIE NE SE MET PAS A JOUR ----
 * Elle lit `m.cotes[c]`. Elle est dans le navigateur de quelqu un, elle ne
 * change pas parce qu on a deploye — et sans ce champ elle affiche « NaN » sur
 * chaque bouton. C est ARRIVE : le champ a ete retire du message, et la grille
 * de cotes est devenue illisible en production le temps d un deploiement.
 * Ce n est pas une seconde source : il est recopie a UN endroit depuis le
 * marche de base, et le catalogue n en porte plus qu une. */
{
  const v = paris.vue(paris.match(M));
  const base = paris.match(M).marches[paris.MARCHE_BASE].cotes;
  for (const i of ['1', 'N', '2'])
    eq(v.cotes[i], base[i], `la vue porte encore la cote « ${i} » a plat`);
  ok(v.marches && v.marches[paris.MARCHE_BASE], 'et les marches a cote');
  eq(paris.match(M).cotes, undefined,
     'mais le CATALOGUE, lui, n en porte plus qu une : l echo ne vit que sur le fil');
}

// ============================ ON REGLE PAR LE SCORE, ET LE RESULTAT S EN DEDUIT
/*
 * ---- POURQUOI CE CHANGEMENT ----
 * Le reglement recevait « 1 », « N » ou « 2 ». C etait assez tant qu un match
 * ne portait qu un seul pari possible — celui-la meme. Des qu on veut proposer
 * « les deux equipes marquent » ou « plus de deux buts et demi », la lettre ne
 * suffit plus : un 1-0 et un 3-2 donnent tous deux « 1 » et ne paient pas les
 * memes gens.
 *
 * ---- ET LA DONNEE ETAIT DEJA LA ----
 * Le fournisseur rend le score exact depuis le premier jour : l import le lit,
 * l affiche — « Bolton 2-1 Preston » — puis n en gardait que la lettre.
 *
 * ---- UN SEUL ARGUMENT ----
 * Pas de score ET de resultat cote a cote : ils se contrediraient un jour, et
 * rien ne dirait lequel croire pendant que l un des deux paie les mauvaises
 * personnes.
 */
{
  const g = jeu();
  const p = g.parie(A, M, '1', 1000, AVANT);
  const avant = sol(g, A);
  const r = g.regleMatch(M, '2-1');
  eq(r.resultat, '1', 'un score « 2-1 » se lit comme une victoire a domicile');
  eq(r.score, '2-1', 'et le score PART avec le reglement, il n est plus jete');
  eq(r.gagnants, 1, 'le parieur du 1 est paye');
  eq(Math.round(sol(g, A) - avant), Math.round(p.rapport), 'du bon montant');
  eq(g.parisRegles[M].score, '2-1',
     'le score est GARDE dans la table : c est lui qui rendra reglables les'
     + ' marches autres que le 1-N-2, y compris retroactivement');
}
/* Les trois lectures, et le nul qui n en est une que la ou il existe. */
{
  const g = jeu();
  g.parie(A, M, 'N', 1000, AVANT);
  const avant = sol(g, A);
  eq(g.regleMatch(M, '1-1').resultat, 'N', 'un score a egalite donne le nul');
  ok(sol(g, A) > avant, 'et le parieur du nul est paye');
}
{
  const g = jeu();
  g.parie(A, M, '2', 1000, AVANT);
  eq(g.regleMatch(M, '0-3').resultat, '2', 'et l exterieur l emporte quand il marque plus');
}
/* ---- LE MEME PARI, LES DEUX FORMES, LE MEME PAIEMENT ----
 * C est la verification qui compte : si les deux chemins ne payaient pas
 * pareil, le score aurait introduit un second reglement a cote de l ancien. */
{
  const parLettre = jeu(), parScore = jeu();
  parLettre.parie(A, M, '1', 1000, AVANT);
  parScore.parie(A, M, '1', 1000, AVANT);
  const a1 = sol(parLettre, A), a2 = sol(parScore, A);
  const r1 = parLettre.regleMatch(M, '1');
  const r2 = parScore.regleMatch(M, '4-0');
  eq(r1.paye, r2.paye, 'la lettre et le score paient exactement la meme somme');
  eq(sol(parLettre, A) - a1, sol(parScore, A) - a2, 'et le solde bouge pareil');
  eq(r1.score, null,
     'mais la lettre ne laisse AUCUN score — et une rencontre reglee sans score'
     + ' ne le sera jamais : on ne deduit pas un score d une lettre');
}
/* ---- UN NUL LA OU IL N EXISTE PAS ----
 * Le tennis se cote en deux issues. Un score a egalite ne peut pas venir du
 * court, il vient de la saisie — et le laisser passer ferait perdre tout le
 * monde en silence, ce qui est la pire facon de se tromper. */
{
  /* Nomme ici plutot que plus bas : les deux essais du tennis sont separes de
     deux cents lignes, et une constante lue avant sa declaration ne leve pas
     une erreur d'orthographe mais une erreur d'ORDRE, qui se cherche mal. */
  const TEN = 'atp-20260815-djo-tir';               // Djokovic 1.25 / Tirante 3.80
  const g = jeu();
  g.parie(A, TEN, '1', 1000, AVANT);
  jete(() => g.regleMatch(TEN, '2-2'), /level score .* is impossible here/,
    'un score a egalite est refuse la ou le nul n existe pas');
  ok(!g.parisRegles[TEN], 'et rien n est grave : la rencontre reste a regler');
  eq(g.regleMatch(TEN, '2-0').resultat, '1', 'un vrai score, lui, passe');
}
/* Ce qui ne ressemble a rien reste refuse — le score n a pas elargi la porte. */
{
  const g = jeu();
  g.parie(A, M, '1', 1000, AVANT);
  jete(() => g.regleMatch(M, '2:1'), /must be a score like 2-1/,
    'deux points ne font pas un score');
  jete(() => g.regleMatch(M, 'X'), /must be a score like 2-1/, 'ni une lettre inventee');
  jete(() => g.regleMatch(M, '-1-2'), /must be a score like 2-1/, 'ni un score negatif');
}

// ================================ PARIER SUR LES SIX MARCHES
/*
 * Le calendrier du depot ne porte que des 1-N-2 : il a ete ecrit avant que les
 * marches existent. On en fabrique donc un, avec les six, et on le rend au
 * module — c'est la seule facon d'essayer ce qui n'est pas encore en
 * production sans attendre le prochain import.
 */
const fs2 = require('fs');
const os2 = require('os');
const path2 = require('path');
const cotes2 = require('./cotes');
const MM = 'six-marches-20260815';
{
  /* Une equipe sans force fait desormais REFUSER la cote — la reparation du
     soir ou « AS Monaco » ne tombait sur aucune clef et sortait a 5,04 contre
     2,2 partout ailleurs. Deux equipes d'essai doivent donc etre declarees. */
  cotes2.poseNote('foot', 'Alpha', 1600);
  cotes2.poseNote('foot', 'Beta', 1500);
  const brut = {
    sports: [{ cle: 'foot', nom: 'Football', actif: true }],
    matchs: [{
      id: MM, sport: 'foot', competition: 'Essai', pays: 'England',
      domicile: 'Alpha', exterieur: 'Beta', debut: '2026-08-15T15:00:00Z',
      marches: cotes2.marchesDe('foot', 'Alpha', 'Beta'),
    }, {
      /* Une rencontre qui ne porte QUE le 1-N-2, comme tout le calendrier
         d aujourd hui : c est elle qui prouve qu on refuse un marche absent
         plutot que de le fabriquer a la volee au moment de la mise. */
      id: 'un-seul-marche-20260815', sport: 'foot', competition: 'Essai',
      pays: 'England', domicile: 'Gamma', exterieur: 'Delta',
      debut: '2026-08-15T15:00:00Z',
      marches: { '1n2': { cotes: { 1: 2.4, N: 3.4, 2: 3.0 } } },
    }],
  };
  const f = path2.join(fs2.mkdtempSync(path2.join(os2.tmpdir(), 'paris-marches-')), 'cat.json');
  fs2.writeFileSync(f, JSON.stringify(brut));
  paris.charge(f);
  const m = paris.match(MM);
  eq(Object.keys(m.marches).sort().join(','), '1n2,btts,dc,hand,ou25,score',
     'le calendrier d essai porte bien les six marches');
}
/* ---- ON PARIE, ET LE SCORE PAIE ---- */
{
  const g = jeu();
  const p = g.parieSur(A, MM, 'btts', 'oui', 1000, AVANT);
  eq(p.jambes[0].marche, 'btts', 'la jambe porte son marche');
  eq(p.cote, paris.coteDe(paris.match(MM), 'btts', 'oui'),
     'et la cote vient de CE marche, pas du 1-N-2');
  const avant = sol(g, A);
  g.regleMatch(MM, '2-1');
  eq(Math.round(sol(g, A) - avant), Math.round(p.rapport),
     'un 2-1 fait marquer les deux equipes : le pari est paye');
}
{
  const g = jeu();
  g.parieSur(A, MM, 'btts', 'oui', 1000, AVANT);
  const avant = sol(g, A);
  g.regleMatch(MM, '2-0');
  eq(sol(g, A), avant, 'un 2-0 ne les fait pas marquer toutes les deux : rien n est rendu');
}
/* Les cinq autres, chacun sur le score qui les fait gagner puis sur celui qui
   les fait perdre. Une table plutot que cinq blocs : ce sont cinq fois la meme
   verification, et cinq copies auraient fini par ne plus verifier la meme
   chose. */
{
  const cas = [
    ['dc', '1X', '1-1', '0-2'], ['dc', '12', '2-0', '1-1'], ['dc', 'X2', '0-1', '3-1'],
    ['ou25', 'plus', '2-1', '1-1'], ['ou25', 'moins', '1-0', '2-2'],
    ['score', '2-1', '2-1', '2-2'], ['score', 'autre', '5-1', '1-1'],
    ['hand', '1', '3-1', '2-1'], ['hand', '2', '2-1', '4-0'],
    ['1n2', '1', '1-0', '0-1'],
  ];
  for (const [marche, choix, gagnant, perdant] of cas) {
    const g1 = jeu(), g0 = jeu();
    const p1 = g1.parieSur(A, MM, marche, choix, 1000, AVANT);
    g0.parieSur(A, MM, marche, choix, 1000, AVANT);
    const a1 = sol(g1, A), a0 = sol(g0, A);
    g1.regleMatch(MM, gagnant);
    g0.regleMatch(MM, perdant);
    ok(Math.round(sol(g1, A) - a1) === Math.round(p1.rapport) && sol(g0, A) === a0,
       `« ${marche} ${choix} » gagne sur ${gagnant} et perd sur ${perdant}`);
  }
}
/* ---- CE QUI EST REFUSE ---- */
{
  const g = jeu();
  jete(() => g.parieSur(A, MM, 'zzz', 'oui', 1000, AVANT), /unknown market/,
    'un marche qui n existe pas');
  jete(() => g.parieSur(A, MM, 'btts', 'peut-etre', 1000, AVANT), /pick oui, non/,
    'une reponse qui n appartient pas au marche — et le message NOMME celles qui vont');
  jete(() => g.parieSur(A, 'un-seul-marche-20260815', 'btts', 'oui', 1000, AVANT),
    /no Both teams to score/,
    'et un marche que la rencontre ne porte pas — on le REFUSE plutot que de le'
    + ' fabriquer a la volee : une cote calculee au moment de la mise ne serait'
    + ' pas celle qu on a affichee');
}
/* ---- L ENGAGEMENT SE COMPTE PAR SCORE, PAS PAR REPONSE ----
 * C est LA verification de ce commit. Un 2-1 fait gagner en meme temps le
 * « 1 », le « 1X », le « 12 », le « oui », le « plus » et le score exact.
 * Compte reponse par reponse, l engagement aurait annonce le sixieme du vrai —
 * et le plafond n aurait plus rien plafonne. */
{
  const g = jeu(100000000);
  const surDeuxUn = [['1n2', '1'], ['dc', '1X'], ['dc', '12'], ['btts', 'oui'],
                     ['ou25', 'plus'], ['score', '2-1']];
  let somme = 0, plusCher = 0;
  for (const [marche, choix] of surDeuxUn) {
    const p = g.parieSur(A, MM, marche, choix, 200, AVANT);
    somme += p.rapport;
    plusCher = Math.max(plusCher, p.rapport);
  }
  const eng = g.engagementMatch(MM);
  ok(Math.abs(eng - somme) < 1,
     `six paris qui gagnent TOUS sur un 2-1 engagent leur somme : ${Math.round(eng)}`);
  ok(eng > plusCher * 1.5,
     `et non le plus cher d entre eux, qui n en vaut que ${Math.round(plusCher)} —`
     + ` compter par reponse aurait annonce ${Math.round(plusCher)} au lieu de`
     + ` ${Math.round(eng)}`);
  /* ---- LA GRILLE EST UNE ENVELOPPE, PAS UN ECHANTILLON ----
   * Au-dela de quatre buts par equipe, l ensemble des reponses gagnantes ne
   * change plus : un 12-0 paie exactement les memes paris qu un 8-0. On le
   * PROUVE en refaisant le calcul sur une grille de zero a trente. */
  const lignes = [];
  for (const p of g.paris) {
    for (const j of p.jambes) lignes.push({ marche: j.marche, choix: j.choix, rapport: p.rapport });
  }
  let large = 0;
  for (let a2 = 0; a2 <= 30; a2++) for (let b2 = 0; b2 <= 30; b2++) {
    let t2 = 0;
    for (const l of lignes) if (paris.gagne(l.marche, l.choix, { a: a2, b: b2 })) t2 += l.rapport;
    if (t2 > large) large = t2;
  }
  ok(Math.abs(large - eng) < 1,
     `une grille de zero a trente ne trouve pas pire que celle de zero a huit :`
     + ` ${Math.round(large)} contre ${Math.round(eng)}`);
}
/* ---- ET LA LETTRE NE PEUT PLUS TRANCHER CE QU ELLE NE SAIT PAS LIRE ----
 * « 1 » ne dit pas si les deux equipes ont marque : un 1-0 et un 3-2 donnent
 * la meme lettre. Regler a la lettre une rencontre portant un pari « les deux
 * equipes marquent » ferait PERDRE tout le monde en silence. */
{
  const g = jeu();
  g.parieSur(A, MM, 'btts', 'oui', 1000, AVANT);
  jete(() => g.regleMatch(MM, '1'), /settle it with the final score/,
    'la lettre est refusee des qu un pari demande le score');
  ok(!g.parisRegles[MM], 'et rien n est grave : la rencontre reste a regler');
  eq(g.regleMatch(MM, '2-1').gagnants, 1, 'le score, lui, la tranche');
}
{
  /* Une rencontre qui ne porte QUE des 1-N-2 se regle encore a la lettre :
     c est ce qui permet de payer un gagnant quand la rencontre a quitte le
     calendrier et qu il ne reste que le souvenir du resultat. */
  const g = jeu();
  g.parieSur(A, MM, '1n2', '1', 1000, AVANT);
  eq(g.regleMatch(MM, '1').gagnants, 1,
     'une rencontre sans autre marche se tranche encore a la lettre');
}
/* On rend le calendrier du depot a ceux qui suivent. */
paris.charge();

// ================================ LE PLAFOND D ENGAGEMENT
/* Il ne compte pas les mises : il compte ce qu il faudra SORTIR si la pire
   issue tombe. C est la seule mesure qui dit la verite. */
{
  const g = jeu(1000000000);
  const plafond = cfg.PARI_ENGAGEMENT_MAX;

  /* ---- CE QUI BORNE VRAIMENT UNE GROSSE MISE ----
   *
   * Ce n'est PAS `PARI_MAX`. Une mise engage la maison a hauteur de
   * mise x cote, et c'est cet engagement-la qui est plafonne, par RENCONTRE.
   * La plus grosse mise reellement posable sur une affiche vide vaut donc
   * `ENGAGEMENT_MAX / cote` — et elle passe SOUS `PARI_MAX` des que la cote
   * depasse le rapport entre les deux.
   *
   * L'essai posait `PARI_MAX` en dur et comptait les acceptations. Il a
   * commence a rendre « 0 paris acceptes » le jour ou la mise maximale est
   * passee a un million : a 3,17, un seul pari au plafond engage 3,17
   * millions, soit plus que les deux millions de la rencontre. Ce n'etait pas
   * une panne, c'etait la borne qui parlait — et l'essai ne savait pas
   * l'entendre.
   */
  /* Par `coteDe`, et non `m.cotes[...]` : le 1-N-2 vit dans `marches` depuis
     que la rencontre en porte six, et `cotes` a plat n'existe plus sur l'objet
     valide — seulement sur le fil, pour les pages deja servies. */
  const cote = paris.coteDe(paris.match(M), '1n2', '2');
  const posable = Math.floor(plafond / cote);
  ok(posable < cfg.PARI_MAX,
     `a la cote ${cote}, l engagement borne la mise a ${posable} bien avant le`
     + ` plafond de mise (${cfg.PARI_MAX}) — c'est LUI qui mord`);
  /* Et la consequence, dite en clair : au plafond de mise, sur une rencontre
     VIDE, le pari est refuse d'emblee. Le joueur ne se cogne pas au plafond
     de mise mais a celui de l'engagement, et le message doit donc parler de
     la rencontre — « full » — et non de la mise. */
  jete(() => g.parie(A, M, '2', cfg.PARI_MAX, AVANT), /is full/,
       `une mise au plafond (${cfg.PARI_MAX}) a la cote ${cote} est refusee sur une`
       + ' affiche VIDE : c est l engagement qui parle, pas la mise');

  let pose = 0;
  /* On empile sur la meme issue jusqu a saturer, en posant ce qui PASSE. */
  const pas = Math.floor(posable / 3);
  for (let i = 0; i < 200; i++) {
    try { g.parie(A, M, '2', pas, AVANT); pose++; }
    catch (e) { ok(/full/.test(e.message), 'passe le plafond, on refuse en le disant : ' + e.message); break; }
  }
  ok(pose > 0, `${pose} paris de ${pas} ont ete acceptes avant saturation`);
  ok(g.engagementMatch(M) <= plafond,
     `l engagement reste sous la borne (${g.engagementMatch(M)} <= ${plafond})`);
  /* Et l autre issue reste ouverte : le plafond est PAR ISSUE au pire, pas
     une fermeture du match. */
  const p = g.parie(A, M, '1', 1000, AVANT);
  ok(p, 'une autre issue reste pariable — le plafond vise le risque, pas le volume');
}

// ================================ ce qui est refuse
{
  const g = jeu();
  jete(() => g.parie(A, 'inconnu', '1', 1000, AVANT), /unknown match/, 'un match qui n existe pas');
  jete(() => g.parie(A, M, 'X', 1000, AVANT), /pick 1, N, 2/, 'une issue hors des trois');
  jete(() => g.parie(A, M, '1', 1, AVANT), /minimum/, 'sous le minimum');
  jete(() => g.parie(A, M, '1', cfg.PARI_MAX + 1, AVANT), /maximum/,
       `au-dessus du plafond de ${cfg.PARI_MAX}`);
  jete(() => g.parie(A, M, '1', 1000, APRES), /closed/,
       'APRES LE COUP D ENVOI : parier sur un match commence, c est parier en regardant le score');
  const pauvre = '0x' + 'cc'.repeat(20);
  jete(() => g.parie(pauvre, M, '1', 1000, AVANT), /not enough/, 'sans les jetons');
}

// ================================ le reglement paie, et une seule fois
{
  const g = jeu();
  g.parie(A, M, '1', 1000, AVANT);       // 2.12 -> 2120
  g.parie(B, M, '2', 1000, AVANT);       // perdant
  const avant = sol(g, A) + sol(g, B);

  const r = g.regleMatch(M, '1');
  eq(r.gagnants, 1, 'un seul gagnant');
  eq(r.paye, 2120, 'paye au rapport fige');
  eq(r.mise, 2000, 'sur deux mille mises');
  eq(Number(r.net.toFixed(6)), -120, 'la maison perd 120 sur CE match — un lot n est pas une moyenne');
  eq(sol(g, A), 1000000 - 1000 + 2120, 'le gagnant est credite');
  eq(sol(g, B), 1000000 - 1000, 'le perdant ne recupere rien');
  eq(sol(g, A) + sol(g, B) - avant, 2120, 'et rien d autre n a bouge');

  jete(() => g.regleMatch(M, '1'), /already settled/,
       'UN MATCH NE SE REGLE PAS DEUX FOIS : ce serait de l argent cree');
  jete(() => g.regleMatch(M, 'N'), /already settled/, 'meme avec un autre resultat');
  eq(g.engagementMatch(M), 0, 'et l engagement retombe a zero');
}

// ================================ le remboursement
{
  const g = jeu();
  g.parie(A, M, '1', 5000, AVANT);
  g.parie(B, M, 'N', 3000, AVANT);
  const r = g.rembourseMatch(M);
  eq(r.rendu, 8000, 'tout est rendu : un match qui ne se joue pas n a produit aucun resultat');
  eq(sol(g, A), 1000000, 'chacun retrouve exactement sa mise');
  eq(sol(g, B), 1000000, 'les deux');
  jete(() => g.regleMatch(M, '1'), /already settled/, 'et on ne peut plus le regler ensuite');
}

// ============ LES PARIS SURVIVENT AU REDEMARRAGE
/* Sans ca, un redeploiement le vendredi soir efface tout ce qui a ete pose
   pour le samedi — et l argent est deja parti des soldes. */
{
  const g = jeu();
  g.parie(A, M, '1', 4000, AVANT);
  const instantane = JSON.parse(JSON.stringify(g.serialize()));

  const g2 = new Game();
  g2.hydrate(instantane);
  eq(g2.mesParis(A).length, 1, 'le pari est toujours la apres relecture');
  eq(g2.mesParis(A)[0].cote, 2.12, 'avec sa cote');
  eq(g2.engagementMatch(M), 8480, 'et l engagement de la maison aussi');

  const r = g2.regleMatch(M, '1');
  eq(r.paye, 8480, 'il se regle normalement de l autre cote du redemarrage');
  eq(Math.round(sol(g2, A)), 1000000 - 4000 + 8480, 'et le joueur est paye');
}

// ============ LE PARI PASSE PAR LE POINT DE REGLAGE COMMUN
/* Sinon il serait invisible au classement du mois, au revenu et a la mesure
   d usage — exactement comme l etaient le pusher et le poker ce matin. */
{
  const g = jeu();
  g.parie(A, M, '1', 1000, AVANT);
  g.parie(B, M, '2', 1000, AVANT);
  eq(g.comptes().mises, 0, 'rien n est comptabilise tant que le match n est pas joue');
  g.regleMatch(M, '2');
  const c = g.comptes();
  eq(c.mises, 2000, 'au reglement, les deux mises entrent dans la comptabilite');
  eq(c.rendus, 3170, 'et ce qui a ete rendu');
  eq(g._p(B).moisMise, 1000, 'le volume du MOIS compte, donc le classement aussi');
  const u = g.usageJour(new Date().toISOString().slice(0, 10)).find((x) => x.jeu === 'paris');
  ok(u, 'et les paris apparaissent dans la mesure d usage');
  eq(u.joueurs, 2, 'avec leurs deux joueurs');
}



// ============================================ LE COMBINE
/* Les cotes se multiplient et TOUTES les jambes doivent passer. Une seule
   fausse et le pari entier tombe — c'est ce qui le rend interessant des deux
   cotes : des rapports impossibles en simple pour le joueur, des marges qui
   se multiplient pour la maison. */
const T1 = 'atp-20260815-djo-tir';   // Djokovic 1.25 / Tirante 3.80
const T2 = 'atp-20260815-pau-hur';   // Paul 1.53 / Hurkacz 2.25
const T3 = 'atp-20260815-fer-duc';   // Fery 1.53 / Duckworth 2.24

{
  const g = jeu();
  const p = g.parieCombine(A, [{ match: T1, choix: '1' }, { match: T2, choix: '1' }], 1000, AVANT);
  eq(p.jambes.length, 2, 'deux jambes');
  eq(p.cote, 1.9125, 'les cotes se MULTIPLIENT : 1,25 x 1,53');
  eq(p.rapport, 1912.5, 'et le rapport suit');
  eq(sol(g, A), 999000, 'une seule mise part, pas une par jambe');
  eq(g.engagementMatch(T1), 1912.5, 'le gain ENTIER pese sur la premiere jambe…');
  eq(g.engagementMatch(T2), 1912.5, '…et sur la seconde : un garde-fou doit majorer');
}

// ---- une jambe fausse fait tomber tout le pari, sans attendre les autres
{
  const g = jeu();
  g.parieCombine(A, [{ match: T1, choix: '1' }, { match: T2, choix: '1' }], 1000, AVANT);
  const r = g.regleMatch(T1, '2');                 // Djokovic perd : le combine est mort
  eq(r.perdus, 1, 'le combine est perdu des la premiere jambe fausse');
  eq(r.enAttente, 0, 'on n attend pas le second match pour le dire');
  eq(sol(g, A), 999000, 'et rien n est rendu');
  eq(g.engagementMatch(T2), 0, 'l engagement du second match retombe aussi');
}

// ---- une jambe gagnee NE PAIE PAS : il faut les avoir toutes
{
  const g = jeu();
  g.parieCombine(A, [{ match: T1, choix: '1' }, { match: T2, choix: '1' }], 1000, AVANT);
  const r1 = g.regleMatch(T1, '1');                 // premiere jambe gagnee
  eq(r1.gagnants, 0, 'une jambe gagnee ne paie rien…');
  eq(r1.enAttente, 1, '…le pari reste en attente de la seconde');
  eq(sol(g, A), 999000, 'le solde ne bouge pas');

  const r2 = g.regleMatch(T2, '1');                 // seconde gagnee
  eq(r2.gagnants, 1, 'la derniere jambe declenche le paiement');
  eq(r2.paye, 1912.5, 'au rapport combine');
  eq(sol(g, A), 999000 + 1912.5, 'et le joueur est credite une seule fois');
}

// ---- ce qui est refuse sur un combine
{
  const g = jeu();
  jete(() => g.parieCombine(A, [], 1000, AVANT), /at least one/, 'un bulletin vide');
  jete(() => g.parieCombine(A, [{ match: T1, choix: '1' }, { match: T1, choix: '2' }], 1000, AVANT),
       /one selection per match/,
       'DEUX JAMBES SUR LE MEME MATCH : contradictoires, ou un simple deguise en combine');
  jete(() => g.parieCombine(A, [{ match: T1, choix: 'N' }], 1000, AVANT), /pick 1, 2/,
       'un match nul au tennis, ca n existe pas');
  const trop = [];
  for (const m of paris.catalogue().matchs.slice(0, cfg.PARI_JAMBES_MAX + 1))
    trop.push({ match: m.id, choix: '1' });
  jete(() => g.parieCombine(A, trop, 1000, AVANT), /at most/,
       `au-dela de ${cfg.PARI_JAMBES_MAX} jambes, on refuse`);
}

// ---- LE PLAFOND DE GAIN, qui n existait pas pour un simple
/* Cinq selections a 2,00 font trente-deux fois la mise : au plafond, c est
   plusieurs millions dus sur UN pari. */
{
  const g = jeu(100000000);
  const grosses = [{ match: T1, choix: '2' }, { match: T2, choix: '2' },
                   { match: T3, choix: '2' }, { match: 'atp-20260815-hal-dem', choix: '1' }];
  let cote = 1;
  for (const j of grosses) cote *= paris.coteDe(paris.match(j.match), paris.MARCHE_BASE, j.choix);
  ok(cote > 50, `quatre outsiders font une cote de ${cote.toFixed(1)}`);
  jete(() => g.parieCombine(A, grosses, cfg.PARI_MAX, AVANT), /the cap is/,
       'au plafond de mise, ce combine depasse le gain maximum et il est refuse');
  /* Avec une mise raisonnable, il passe : c est un plafond de GAIN, pas une
     interdiction du combine. */
  const p = g.parieCombine(A, grosses, 1000, AVANT);
  ok(p.rapport <= cfg.PARI_GAIN_MAX, `a mise raisonnable il passe (${Math.round(p.rapport)})`);
}

// ---- un combine survit au redemarrage, jambes comprises
{
  const g = jeu();
  g.parieCombine(A, [{ match: T1, choix: '1' }, { match: T2, choix: '1' }], 2000, AVANT);
  const g2 = new Game();
  g2.hydrate(JSON.parse(JSON.stringify(g.serialize())));
  eq(g2.mesParis(A)[0].jambes.length, 2, 'les deux jambes sont relues');
  g2.regleMatch(T1, '1'); g2.regleMatch(T2, '1');
  eq(Math.round(sol(g2, A)), Math.round(1000000 - 2000 + 3825), 'et le combine se paie apres relecture');
}

/* ---- ce que le profil montre : « Open bets » et « Settled bets »
 *
 * Le panneau de profil sert ces deux onglets depuis le MOTEUR, pas depuis le
 * journal : un pari change d'etat apres avoir ete ecrit, et un journal ne se
 * reecrit pas. Ce qui est verifie ici, c'est le contrat dont la page depend —
 * la separation en cours / regle, et le fait que CHAQUE jambe porte le nom de
 * sa rencontre. Sans ce dernier point, un combine regle s'affiche avec une
 * seule ligne, les autres matchs n'etant plus au calendrier ouvert.
 */
{
  const g = jeu();
  g.parieCombine(A, [{ match: T1, choix: '1' }], 1000, AVANT);
  g.parieCombine(A, [{ match: T2, choix: '1' }, { match: T3, choix: '1' }], 500, AVANT);
  g.parieCombine(B, [{ match: T1, choix: '2' }], 300, AVANT);

  const tousA = () => g.mesParis(A, 100);
  const ouverts = () => tousA().filter((x) => !x.regle);
  const regles = () => tousA().filter((x) => x.regle);

  eq(ouverts().length, 2, 'les deux paris de A sont en cours');
  eq(regles().length, 0, 'et aucun n est encore solde');
  eq(tousA().length, 2, 'le pari de B ne figure pas chez A');

  /* Chaque jambe porte SA rencontre — c est ce que la page affiche. */
  const combine = ouverts().filter((x) => x.jambes.length === 2)[0];
  ok(combine.jambes.every((j) => j.domicile && j.domicile !== '?'),
     'chaque jambe du combine porte le nom de son match');
  ok(combine.jambes.every((j) => Array.isArray(j.issues) && j.issues.length >= 2),
     'et ses issues, dont la page tire « Home / Draw / Away » ou « Player 1 / 2 »');
  /* LA JAMBE RANGEE PORTE SA FICHE, DES LA POSE. Elle ne la portait pas : les
     noms etaient recolles a l'affichage depuis le calendrier du jour, et le
     jour ou une rencontre en sortait, le pari devenait « ? – ? » — plus
     affichable, et plus reglable non plus. Ce qui a ete vendu au joueur se
     garde sur le ticket. */
  ok(g.paris.every((x) => x.jambes.every((j) => j.domicile && j.match && j.choix)),
     'le pari range dans le moteur porte sa fiche des la pose');
  /* Ce qui reste vrai : la page recoit une COPIE. L'objet range sert au
     reglement, et le maquiller casserait le paiement. */
  ouverts()[0].jambes[0].domicile = 'MAQUILLE';
  ok(g.paris.every((x) => x.jambes.every((j) => j.domicile !== 'MAQUILLE')),
     'et retoucher la vue ne touche pas le pari range dans le moteur');

  g.regleMatch(T1, '1');
  eq(ouverts().length, 1, 'le simple regle quitte les paris en cours');
  eq(regles().length, 1, 'et rejoint les paris finis');
  eq(regles()[0].gagne, true, 'gagne, en l occurrence');

  g.regleMatch(T2, '2');
  eq(ouverts().length, 0, 'une jambe perdue solde tout le combine');
  eq(regles().filter((x) => x.gagne === false).length, 1, 'du cote perdant');

  /* La pagination du panneau : un rang dans la liste, pas une position dans
     un fichier — la liste est refaite a chaque demande. */
  const page = (debut, n) => regles().slice(debut, debut + n);
  eq(page(0, 1).length, 1, 'la premiere page rend une ligne');
  eq(page(1, 1).length, 1, 'la seconde en rend une autre');
  ok(page(0, 1)[0].id !== page(1, 1)[0].id, 'et ce ne sont pas les memes');
  eq(page(2, 1).length, 0, 'passe la fin, il n y a plus rien');
}

/* ---- les sports a deux issues ne sont pas tous des duels
 *
 * NFL, NBA et cricket n'ont que deux issues, comme le tennis. Mais leurs
 * deux cotes sont des EQUIPES : afficher « Player 1 » sur un match des
 * Chiefs fait douter de ce sur quoi on parie, au moment precis ou l'on mise
 * — et au moment ou l'on REGLE, ce qui est pire. La distinction se fait donc
 * sur le SPORT, jamais sur le nombre d'issues.
 */
{
  eq(paris.issues('nfl').length, 2, 'la NFL se cote en deux issues');
  eq(paris.issues('cricket').length, 2, 'le cricket en format limite aussi');
  eq(paris.issues('foot').length, 3, 'le football en garde trois');
  /* Le cricket TEST finit reellement par un nul une fois sur trois. Il n'est
     pas suivi, et c'est deliberé : l'ajouter sans troisieme issue paierait
     le mauvais camp. Si un jour il l'est, ce test doit tomber. */
  eq(paris.ISSUES_PAR_SPORT.cricket.indexOf('N'), -1,
     'le cricket n a pas de nul ici — donc pas de format Test au calendrier');
  for (const s of ['foot', 'nba', 'nfl', 'cricket'])
    ok(paris.SPORTS_EQUIPE.indexOf(s) >= 0, s + ' oppose des equipes');
  eq(paris.SPORTS_EQUIPE.indexOf('tennis'), -1, 'seul le tennis oppose deux personnes');

  /* ---- UN SPORT INCONNU LEVE, ET NE RETOMBE PLUS SUR LE FOOTBALL ----
   *
   * CET ESSAI DISAIT L INVERSE, et son argument etait serieux : « un catalogue
   * qui refuse de se charger arrete le serveur ». Il est ecarte pour deux
   * raisons, et la seconde repond a la premiere.
   *
   * UN. Le repli donnait TROIS issues a un sport qui n en a peut-etre que
   * deux, avec un nul cote au hasard. Rien ne cassait, rien ne le disait, et
   * le mauvais camp etait paye. Entre un serveur qui refuse de demarrer — ce
   * qui se voit dans la minute — et un nul fantome qui paie de travers
   * pendant des semaines, il n y a pas de choix.
   *
   * DEUX. Le cas n arrive plus par le chemin normal. `ODDS_API_LIGUES` ecarte
   * desormais toute ligue dont le sport n est pas declare, AVANT que la
   * moindre rencontre n entre au catalogue — verifie dans
   * `paris_import.test.js`. Pour atteindre cette exception, il faudrait avoir
   * ecrit un sport a la main dans le fichier ; et alors, s arreter est
   * exactement ce qu on veut.
   */
  jete(() => paris.issues('petanque'), /sport inconnu/,
       'un sport non declare leve, au lieu de recevoir les issues du football');
  ok(/declarez-le dans SPORTS/.test((() => {
       try { paris.issues('petanque'); return ''; } catch (e) { return e.message; }
     })()),
     'et le message dit QUOI FAIRE, pas seulement ce qui ne va pas');
  ok(paris.sportConnu('foot') && !paris.sportConnu('petanque'),
     '`sportConnu` repond a la seule question a poser avant d accepter un sport');

  /* ---- ET AJOUTER UN SPORT TIENT EN UNE LIGNE ----
   *
   * C est l objet du registre. Un sport se declarait a QUATRE endroits : ses
   * issues et « equipe ou joueur » ici, son nom d affichage dans l import, son
   * avantage du terrain dans `cotes.js`. L oubli le plus probable etait le
   * plus cher : sans avantage du terrain il vaut ZERO, et le favori a
   * domicile est sous-cote a chaque match, en silence.
   *
   * On verifie donc que les trois vues d avant sont bien des LECTURES du
   * registre, et non des copies qui se perimeraient.
   */
  for (const c of Object.keys(paris.SPORTS)) {
    const S = paris.SPORTS[c];
    ok(S.nom && Array.isArray(S.issues) && typeof S.terrain === 'number',
       `« ${c} » declare tout ce qu il faut en une ligne : ${S.nom},`
       + ` ${S.issues.join('/')}, terrain ${S.terrain}`);
    eq(paris.ISSUES_PAR_SPORT[c], S.issues,
       `et ISSUES_PAR_SPORT.${c} est la MEME reference, pas une copie`);
    eq(paris.SPORTS_EQUIPE.indexOf(c) >= 0, !!S.equipes,
       `et SPORTS_EQUIPE suit son drapeau`);
  }
  eq(require('./cotes').TERRAIN.foot, paris.SPORTS.foot.terrain,
     'l avantage du terrain que lit le modele de cotes vient du registre');
}

console.log(`paris.test.js : ${n} verifications OK`);
