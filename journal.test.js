'use strict';
/*
 * Le journal du joueur.
 *
 * Ce qui merite d'etre verifie ici n'est pas « ca ecrit et ca relit » — c'est
 * la LECTURE PAR LA FIN. Le fichier d'un joueur ancien fait des megaoctets ;
 * on en lit la queue par morceaux de 64 Ko, en remontant, et une ligne coupee
 * en deux par une frontiere de morceau doit se recoller correctement. Un bug
 * la-dedans ne se voit pas sur dix lignes : il se voit sur dix mille, quand
 * une ligne sur mille disparait.
 *
 * Le second controle qui compte : le curseur. On demande « ce qui precede cet
 * instant », donc parcourir tout l'historique page apres page doit rendre
 * chaque evenement UNE fois et n'en sauter aucun.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// le journal lit cfg.DATA_DIR au chargement : on le detourne avant de l'exiger
const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-journal-'));
process.env.DATA_DIR = bac;
delete require.cache[require.resolve('./config')];
delete require.cache[require.resolve('./journal')];
const journal = require('./journal');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

// ------------------------------------------------- le fichier porte l'adresse
{
  ok(String(journal.fichier(A)).endsWith(A.toLowerCase() + '.jsonl'), 'un fichier par joueur');
  eq(journal.fichier('pas une adresse'), null, 'une adresse invalide ne cree aucun fichier');
  eq(journal.fichier('../../etc/passwd'), null, 'et ne peut pas sortir du dossier');
  eq(journal.fichier(A.toUpperCase()), journal.fichier(A), 'la casse ne cree pas deux fichiers');
}

// ------------------------------------------------ rien a lire, rien ne casse
{
  const r = journal.lit(B, { limite: 10 });
  eq(r.evenements.length, 0, 'un joueur sans historique rend une liste vide');
  eq(r.encore, false, 'et rien de plus a charger');
  eq(journal.resume(B).lignes, 0, 'son resume est a zero');
}

// ------------------------------------------------------- l'ordre et le genre
{
  for (let i = 0; i < 5; i++) journal.ajouteSync(A, { t: 1000 + i, k: 'r', g: 'plinko', m: 10, p: i });
  journal.ajouteSync(A, { t: 2000, k: 'dep', m: '500', tx: '0xabc' });
  journal.ajouteSync(A, { t: 3000, k: 'wd', m: '120' });

  const tout = journal.lit(A, { limite: 50 });
  eq(tout.evenements.length, 7, 'les sept evenements sont la');
  eq(tout.evenements[0].t, 3000, 'le plus RECENT en premier');
  eq(tout.evenements[6].t, 1000, 'le plus ancien en dernier');

  eq(journal.lit(A, { genre: 'dep', limite: 50 }).evenements.length, 1, 'on peut ne demander que les depots');
  eq(journal.lit(A, { genre: 'wd', limite: 50 }).evenements.length, 1, 'que les retraits');
  eq(journal.lit(A, { genre: 'r', limite: 50 }).evenements.length, 5, 'que les manches');
  eq(journal.lit(A, { genre: 'dep', limite: 50 }).evenements[0].tx, '0xabc',
     'et le detail de l evenement est rendu tel quel');
}

// ------------------------------- BEAUCOUP de lignes, lues par morceaux
/* Le vrai controle. Assez de lignes pour depasser plusieurs morceaux de 64 Ko,
   avec un contenu de longueur VARIABLE pour que les coupures ne tombent pas
   toujours au meme endroit — une frontiere de morceau doit couper une ligne
   en plein milieu au moins une fois, sinon on ne teste pas le recollage. */
{
  const C = '0x3333333333333333333333333333333333333333';
  const N = 4000;
  for (let i = 0; i < N; i++)
    journal.ajouteSync(C, { t: 1000000 + i, k: 'r', g: 'plinko', m: i,
                            p: i * 2, note: 'x'.repeat(i % 37) });
  const octets = journal.resume(C).octets;
  ok(octets > 64 * 1024 * 2, `le fichier depasse plusieurs morceaux (${Math.round(octets / 1024)} Ko)`);
  eq(journal.resume(C).lignes, N, 'toutes les lignes sont comptees');
  eq(journal.resume(C).depuis, 1000000, 'et la date de la premiere est retrouvee');

  const page = journal.lit(C, { limite: 25 });
  eq(page.evenements.length, 25, 'une page rend le nombre demande');
  eq(page.evenements[0].t, 1000000 + N - 1, 'et commence par le tout dernier');
  eq(page.evenements[0].note.length, (N - 1) % 37, 'le contenu de la ligne est intact');
  eq(page.encore, true, 'il en reste');

  /* On remonte TOUT l'historique page par page : chaque evenement doit
     apparaitre une fois et une seule. C'est ce qui attrape a la fois une
     ligne perdue a la frontiere d'un morceau et un curseur qui repete. */
  const vus = new Set();
  let curseur = null, tours = 0, doublon = null;
  for (;;) {
    const r = journal.lit(C, { limite: 200, curseur });
    if (!r.evenements.length) break;
    for (const e of r.evenements) {
      if (vus.has(e.t)) { doublon = e.t; break; }
      vus.add(e.t);
    }
    if (doublon !== null) break;
    curseur = r.curseur;
    if (!r.encore) break;
    if (++tours > 60) break;
  }
  eq(doublon, null, 'aucun evenement rendu deux fois');
  eq(vus.size, N, `les ${N} evenements sont tous retrouves en remontant page par page`);
}

// -------------------------- LE MEME INSTANT POUR TOUT LE MONDE
/* Le cas qui a mordu pour de vrai : trente manches lancees d'affilee tombent
   dans la MEME milliseconde. Un curseur qui dit « ce qui precede cet instant »
   en saute alors une a chaque changement de page — silencieusement, et
   seulement chez les joueurs rapides. Une position dans le fichier designe une
   ligne et une seule. */
{
  const F = '0x6666666666666666666666666666666666666666';
  const M = 120, INSTANT = 1700000000000;
  for (let i = 0; i < M; i++)
    journal.ajouteSync(F, { t: INSTANT, k: 'r', g: 'plinko', m: 10, p: i });   // MEME t

  const vus = new Set();
  let curseur = null, total = 0, tours = 0;
  for (;;) {
    const r = journal.lit(F, { limite: 25, curseur });
    if (!r.evenements.length) break;
    for (const e of r.evenements) { vus.add(e.p); total++; }
    curseur = r.curseur;
    if (!r.encore) break;
    if (++tours > 30) break;
  }
  eq(total, M, `les ${M} evenements du meme instant sont tous rendus`);
  eq(vus.size, M, 'et chacun une seule fois');

  const p1 = journal.lit(F, { limite: 25 });
  const p2 = journal.lit(F, { limite: 25, curseur: p1.curseur });
  eq(p1.evenements[24].p, M - 25, 'la premiere page finit sur le bon element');
  eq(p2.evenements[0].p, M - 26, 'et la suivante reprend exactement apres, sans en sauter un');
}

// ---------------------------------------------- deux joueurs ne se melangent pas
{
  const D = '0x4444444444444444444444444444444444444444';
  const E = '0x5555555555555555555555555555555555555555';
  journal.ajouteSync(D, { t: 10, k: 'r', g: 'bj', m: 1, p: 2 });
  journal.ajouteSync(E, { t: 11, k: 'r', g: 'bj', m: 3, p: 4 });
  eq(journal.lit(D, { limite: 10 }).evenements.length, 1, 'chacun ne voit que le sien');
  eq(journal.lit(E, { limite: 10 }).evenements[0].m, 3, 'et voit bien le sien');
}

// ------------------------------------------ une ecriture ratee ne casse rien
{
  journal.ajoute('pas une adresse', { k: 'r' });
  journal.ajouteSync(null, { k: 'r' });
  journal.ajouteSync(A, null);
  ok(true, 'ecrire n importe quoi ne jette pas : le journal ne doit jamais arreter une partie');
}

// ---------------------------------------- une RAFALE ne perd aucune ligne
/*
 * CE QUI ARRIVAIT VRAIMENT : chaque `ajoute` ouvrait son propre descripteur.
 * Quelques milliers d'ecritures lancees d'affilee — une table animee, un
 * audit, dix-neuf fins de manche dans la meme seconde — et le systeme
 * refusait d'en ouvrir davantage : « EMFILE, too many open files ». Chaque
 * ligne refusee etait une ligne d'historique perdue, avec un simple
 * avertissement dans les traces.
 *
 * Le test ecrit donc bien plus de lignes qu'il n'y a de descripteurs
 * disponibles, et exige de toutes les relire — dans l'ordre.
 */
{
  const F = '0x' + 'f'.repeat(40);
  const COMBIEN = 4000;
  for (let i = 0; i < COMBIEN; i++) journal.ajoute(F, { k: 'r', g: 'plinko', m: i });
  journal.draine(() => {
    const contenu = fs.readFileSync(journal.fichier(F), 'utf8').trim().split('\n');
    ok(true, `${COMBIEN} ecritures d affilee : aucune n a fait tomber le journal`);
    eq(contenu.length, COMBIEN, `les ${COMBIEN} lignes sont sur le disque, aucune perdue`);
    const premiers = contenu.slice(0, 3).map((l) => JSON.parse(l).m);
    assert.deepStrictEqual(premiers, [0, 1, 2], 'et dans l ordre ou elles ont ete jouees'); n++;
    const dernier = JSON.parse(contenu[contenu.length - 1]).m;
    eq(dernier, COMBIEN - 1, 'jusqu a la derniere');

    fs.rmSync(bac, { recursive: true, force: true });
    console.log(`journal.test.js : ${n} verifications OK`);
  });
}
