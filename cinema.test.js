'use strict';
/*
 * LA GALERIE DU CINEMA : CE QUI ENTRE, CE QUI N'ENTRE PAS, ET CE QUI SURVIT.
 *
 * ---- POURQUOI CE FICHIER EXISTE ----
 *
 * Ces quatre chaines viennent du panneau d'administration et finissent dans un
 * `iframe.src` SUR LA PAGE DE CHAQUE JOUEUR. Une chaine `javascript:` posee la
 * s'executerait dans le contexte du site, avec la session de celui qui
 * regarde. Ce n'est pas une faute de gout, c'est une porte ouverte.
 *
 * « Ca vient de l'admin, donc c'est sur » est le raisonnement qui perd : le
 * proprietaire peut coller la mauvaise chose sans le vouloir, et le jour ou la
 * cle d'admin fuit, c'est cette validation-la qui decide si le site sert du
 * code a ses joueurs. Elle est donc cote SERVEUR — la page ne revalide rien,
 * parce que deux regles pour une meme question finissent par ne plus dire la
 * meme chose, et que celle du serveur est la seule qu'on ne puisse pas
 * contourner en ouvrant la console.
 *
 * ---- ET LA MOITIE DE SEANCE ----
 *
 * Un titre sans version, ou une version sans titre, donnerait un ecran qui
 * annonce quelque chose et ne montre rien. Le joueur traverse la salle pour
 * rien — c'est pire qu'un ecran eteint, qui au moins ne promet pas.
 *
 * ---- ET DEPUIS QU'IL Y EN A PLUSIEURS ----
 *
 * Il n'y avait qu'UNE seance, dans un champ `cinema`. Il y en a maintenant une
 * liste. Le vrai danger du passage n'est pas dans le code neuf : c'est dans
 * l'etat DEJA SAUVEGARDE en production, qui contient l'ancienne forme. Une
 * relecture qui ne connaitrait que la nouvelle aurait efface, au premier
 * redemarrage, la seule seance que le proprietaire ait jamais enregistree —
 * sans erreur, sans trace, et personne ne l'aurait su avant d'avoir traverse
 * le hall. C'est le dernier bloc de ce fichier, et c'est celui qui compte.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/cine-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Game } = require('./game');
/* Le plafond n'est PAS recopie ici : on le demande a la meme source que le
   moteur. Un « 12 » ecrit dans cet essai resterait vert le jour ou quelqu'un
   change le reglage, et c'est exactement le jour ou il faut qu'il tombe. */
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const g = new Game({});

console.log('-- une seance valable --');
{
  const c = g.ajouteCinema({ titre: 'SWOGE NIGHT', affiche: 'https://exemple.test/a.jpg',
                             vf: 'https://exemple.test/vf', vo: 'https://exemple.test/vo' });
  ok(!!c, 'elle est acceptee');
  eq(c.titre, 'SWOGE NIGHT', 'le titre est garde');
  eq(c.vf, 'https://exemple.test/vf', 'la version francaise aussi');
  eq(c.vo, 'https://exemple.test/vo', 'et la version originale');
  eq(g.cinemas.length, 1, 'et elle est entree dans la galerie');
  eq(g.cinemas[0].titre, 'SWOGE NIGHT', 'a sa place');
}

console.log('\n-- plusieurs seances tiennent ensemble --');
{
  /* C'est toute la fonction : la deuxieme ne remplace pas la premiere. La
     version d'avant ecrasait, et le proprietaire ne pouvait donc annoncer
     qu'une chose a la fois. */
  g.ajouteCinema({ titre: 'DEUXIEME', vo: 'https://exemple.test/2' });
  g.ajouteCinema({ titre: 'TROISIEME', vf: 'https://exemple.test/3' });
  eq(g.cinemas.length, 3, 'trois seances a l\'affiche');
  eq(g.cinemas[0].titre, 'SWOGE NIGHT', 'la premiere est toujours la');
  eq(g.cinemas[2].titre, 'TROISIEME', 'et la derniere est en dernier');
}

console.log('\n-- on en retire une, et une seule --');
{
  ok(g.retireCinema(1), 'le rang du milieu se retire');
  eq(g.cinemas.length, 2, 'il en reste deux');
  eq(g.cinemas.map((c) => c.titre).join(','), 'SWOGE NIGHT,TROISIEME',
     'et ce sont les deux autres, dans l\'ordre');
  /* Un rang qui n'existe pas ne doit RIEN retirer. « Retirer la derniere par
     politesse » ferait disparaitre une seance que personne n'a designee. */
  eq(g.retireCinema(9), false, 'un rang hors bornes ne retire rien');
  eq(g.retireCinema(-1), false, 'un rang negatif non plus');
  eq(g.retireCinema('deux'), false, 'ni un rang qui n\'est pas un nombre');
  eq(g.cinemas.length, 2, 'la galerie n\'a pas bouge');
}

/* ================== LE POINT QUI COMPTE ================== */
console.log('\n-- ce qui n\'est PAS une adresse est refuse --');
{
  /* Chaque forme est un vrai vecteur, pas une curiosite : `javascript:` execute,
     `data:` sert une page entiere fabriquee, `vbscript:` marche encore sur de
     vieux moteurs, et l'espace initial est la facon dont on fait passer un
     filtre qui coupe avant de comparer. */
  const MAUVAIS = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//exemple.test/sans-schema',
    '/relatif',
    'exemple.test/sans-schema-du-tout',
  ];
  for (const mauvais of MAUVAIS) {
    const c = Game.seanceCinema({ titre: 'X', vf: mauvais, vo: 'https://exemple.test/vo' });
    eq(c.vf, '', `« ${mauvais.trim().slice(0, 32)} » est refuse`);
  }
  /* Et le refus ne doit pas emporter ce qui etait bon a cote. */
  const c = Game.seanceCinema({ titre: 'X', vf: 'javascript:alert(1)', vo: 'https://exemple.test/vo' });
  eq(c.vo, 'https://exemple.test/vo', 'la version valable a cote survit au refus');
  /* L'affiche passe par le meme filtre : elle finit dans un `<img src>`, ce qui
     est moins grave qu'un iframe mais se refuse pour la meme raison. */
  const d = Game.seanceCinema({ titre: 'X', affiche: 'javascript:alert(1)', vo: 'https://exemple.test/vo' });
  eq(d.affiche, '', 'l\'affiche passe par le meme filtre');
}

console.log('\n-- pas de moitie de seance --');
{
  const avant = g.cinemas.length;
  eq(g.ajouteCinema({ titre: '', vf: 'https://exemple.test/vf' }), null,
     'un titre vide n\'entre pas');
  eq(g.ajouteCinema({ titre: 'Sans rien derriere' }), null,
     'un titre sans aucune version ne s\'affiche pas');
  eq(g.ajouteCinema({ titre: 'Refusees', vf: 'javascript:x', vo: 'data:x' }), null,
     'ni un titre dont les deux versions ont ete refusees');
  /* Le refus ne doit rien AJOUTER : une seance a moitie posee serait pire
     qu'un refus, parce qu'elle aurait l'air enregistree. */
  eq(g.cinemas.length, avant, 'et aucun refus n\'a grossi la galerie');
  /* UNE seule version suffit : on ne force pas le proprietaire a trouver les
     deux avant de pouvoir projeter quoi que ce soit. */
  ok(!!g.ajouteCinema({ titre: 'Une seule', vo: 'https://exemple.test/vo' }),
     'mais UNE version suffit');
}

console.log('\n-- les bornes --');
{
  const long = 'https://exemple.test/' + 'a'.repeat(900);
  const c = Game.seanceCinema({ titre: 'T'.repeat(300), vo: long });
  ok(c.titre.length <= 80, `le titre est coupe a ${c.titre.length} caracteres`);
  ok(c.vo.length <= 500, `l'adresse est coupee a ${c.vo.length}`);
  /* Une adresse coupee reste une adresse : le schema est en tete, donc le
     filtre ne peut pas la transformer en autre chose en la raccourcissant. */
  ok(/^https:\/\//.test(c.vo), 'et elle commence toujours par https');
}

console.log('\n-- la galerie a un plafond, et il se dit --');
{
  /* ---- POURQUOI UN PLAFOND ----
   * La galerie part dans le `hello` de CHAQUE connexion. Sans plafond, c'est
   * un message qui grossit a chaque enregistrement, paye par tous les joueurs
   * a chaque ouverture de page. */
  const p = new Game({});
  for (let i = 0; i < cfg.CINEMA_MAX; i++)
    ok(!!p.ajouteCinema({ titre: 'S' + i, vo: 'https://exemple.test/' + i }),
       `la seance no ${i + 1} entre`);
  eq(p.cinemas.length, cfg.CINEMA_MAX, `la galerie est pleine a ${cfg.CINEMA_MAX}`);
  /* Le refus du plafond LEVE, la ou une seance mal ecrite rend `null` : ce ne
     sont pas les memes reproches, et les confondre aurait fait relire son
     adresse a quelqu'un dont l'adresse etait bonne. */
  let dit = null;
  try { p.ajouteCinema({ titre: 'DE TROP', vo: 'https://exemple.test/x' }); }
  catch (e) { dit = e.message; }
  ok(!!dit, 'la treizieme est refusee, et le refus se dit');
  ok(dit.includes(String(cfg.CINEMA_MAX)),
     `le message nomme le plafond (« ${dit} »)`);
  eq(p.cinemas.length, cfg.CINEMA_MAX, 'et la galerie n\'a pas bouge');
  /* En retirer une doit rouvrir une place — sinon le plafond serait un
     cul-de-sac, et le panneau n'aurait plus jamais rien a proposer. */
  ok(p.retireCinema(0), 'on en retire une');
  ok(!!p.ajouteCinema({ titre: 'ENFIN', vo: 'https://exemple.test/x' }),
     'et la place liberee reprend une seance');
}

console.log('\n-- elle survit a un redemarrage --');
{
  const dump = JSON.parse(JSON.stringify(g.serializeTete()));
  ok(Array.isArray(dump.cinemas), 'la galerie part dans la sauvegarde');
  eq(dump.cinemas.length, g.cinemas.length, 'entiere');
  const g2 = new Game({});
  g2.hydrate(dump);
  eq(g2.cinemas.map((c) => c.titre).join(','), g.cinemas.map((c) => c.titre).join(','),
     'et elle revient telle quelle apres relecture');
}

console.log('\n-- L\'ANCIENNE FORME N\'EST PAS PERDUE --');
{
  /* ---- LE DEFAUT QU'ON EVITE ICI ----
   * L'etat en service contient `cinema`, UN objet, pose du temps ou il n'y
   * avait qu'une seance. Ne relire que `cinemas` l'aurait effacee au premier
   * redemarrage. On ne rejoue donc pas une sauvegarde fabriquee a la main :
   * on reproduit EXACTEMENT ce que l'ancien code ecrivait — un champ `cinema`
   * portant les quatre memes cles que celles que le moteur retient
   * aujourd'hui, et rien d'autre. */
  const seance = Game.seanceCinema({ titre: 'DEJA EN PRODUCTION',
                                     affiche: 'https://exemple.test/a.jpg',
                                     vf: 'https://exemple.test/vf',
                                     vo: 'https://exemple.test/vo' });
  const vieux = { cinema: seance };
  const g3 = new Game({});
  g3.hydrate(vieux);
  eq(g3.cinemas.length, 1, 'l\'ancienne forme devient une galerie d\'un element');
  eq(g3.cinemas[0].titre, 'DEJA EN PRODUCTION', 'avec la seance intacte');
  for (const k of Object.keys(seance))
    eq(g3.cinemas[0][k], seance[k], `le champ « ${k} » a traverse la conversion`);
  /* Et ce qui est converti se re-sauvegarde dans la NOUVELLE forme : sans ca
     la conversion se rejouerait a chaque demarrage, ce qui la rendrait
     impossible a retirer un jour. */
  const redump = JSON.parse(JSON.stringify(g3.serializeTete()));
  ok(Array.isArray(redump.cinemas), 'la sauvegarde suivante est au pluriel');
  eq(redump.cinema, undefined, 'et l\'ancien champ n\'est plus ecrit');

  /* Un etat SANS aucun cinema ne doit pas produire de galerie fantome. */
  const g4 = new Game({});
  g4.hydrate({});
  eq(g4.cinemas.length, 0, 'un etat sans cinema donne une galerie vide');
  /* Et une ancienne seance vide — le champ existait, valant `null` — ne doit
     pas entrer comme une seance sans titre. */
  const g5 = new Game({});
  g5.hydrate({ cinema: null });
  eq(g5.cinemas.length, 0, 'une ancienne seance absente ne devient pas une entree vide');
}

console.log(`\ncinema.test.js : ${n} verifications OK`);
