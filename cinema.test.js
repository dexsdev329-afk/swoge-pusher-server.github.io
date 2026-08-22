'use strict';
/*
 * LA SEANCE DU CINEMA : CE QUI EST ACCEPTE, ET CE QUI NE L'EST PAS.
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
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/cine-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Game } = require('./game');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const g = new Game({});

console.log('-- une seance valable --');
{
  const c = g.poseCinema({ titre: 'SWOGE NIGHT', affiche: 'https://exemple.test/a.jpg',
                           vf: 'https://exemple.test/vf', vo: 'https://exemple.test/vo' });
  ok(!!c, 'elle est acceptee');
  eq(c.titre, 'SWOGE NIGHT', 'le titre est garde');
  eq(c.vf, 'https://exemple.test/vf', 'la version francaise aussi');
  eq(c.vo, 'https://exemple.test/vo', 'et la version originale');
  eq(g.cinema.titre, 'SWOGE NIGHT', 'et elle est posee sur la partie');
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
    const c = g.poseCinema({ titre: 'X', vf: mauvais, vo: 'https://exemple.test/vo' });
    eq(c.vf, '', `« ${mauvais.trim().slice(0, 32)} » est refuse`);
  }
  /* Et le refus ne doit pas emporter ce qui etait bon a cote. */
  const c = g.poseCinema({ titre: 'X', vf: 'javascript:alert(1)', vo: 'https://exemple.test/vo' });
  eq(c.vo, 'https://exemple.test/vo', 'la version valable a cote survit au refus');
  /* L'affiche passe par le meme filtre : elle finit dans un `<img src>`, ce qui
     est moins grave qu'un iframe mais se refuse pour la meme raison. */
  const d = g.poseCinema({ titre: 'X', affiche: 'javascript:alert(1)', vo: 'https://exemple.test/vo' });
  eq(d.affiche, '', 'l\'affiche passe par le meme filtre');
}

console.log('\n-- pas de moitie de seance --');
{
  eq(g.poseCinema({ titre: '', vf: 'https://exemple.test/vf' }), null,
     'un titre vide retire la seance');
  eq(g.cinema, null, 'et la partie n\'en garde aucune');
  eq(g.poseCinema({ titre: 'Sans rien derriere' }), null,
     'un titre sans aucune version ne s\'affiche pas');
  eq(g.poseCinema({ titre: 'Refusees', vf: 'javascript:x', vo: 'data:x' }), null,
     'ni un titre dont les deux versions ont ete refusees');
  /* UNE seule version suffit : on ne force pas le proprietaire a trouver les
     deux avant de pouvoir projeter quoi que ce soit. */
  ok(!!g.poseCinema({ titre: 'Une seule', vo: 'https://exemple.test/vo' }),
     'mais UNE version suffit');
}

console.log('\n-- les bornes --');
{
  const long = 'https://exemple.test/' + 'a'.repeat(900);
  const c = g.poseCinema({ titre: 'T'.repeat(300), vo: long });
  ok(c.titre.length <= 80, `le titre est coupe a ${c.titre.length} caracteres`);
  ok(c.vo.length <= 500, `l'adresse est coupee a ${c.vo.length}`);
  /* Une adresse coupee reste une adresse : le schema est en tete, donc le
     filtre ne peut pas la transformer en autre chose en la raccourcissant. */
  ok(/^https:\/\//.test(c.vo), 'et elle commence toujours par https');
}

console.log('\n-- elle survit a un redemarrage --');
{
  g.poseCinema({ titre: 'APRES REDEMARRAGE', affiche: 'https://exemple.test/a.jpg',
                 vf: 'https://exemple.test/vf', vo: 'https://exemple.test/vo' });
  const dump = JSON.parse(JSON.stringify(g.serializeTete()));
  ok(!!dump.cinema, 'elle part dans la sauvegarde');
  const g2 = new Game({});
  g2.hydrate(dump);
  eq(g2.cinema && g2.cinema.titre, 'APRES REDEMARRAGE',
     'et elle revient telle quelle apres relecture');
}

console.log(`\ncinema.test.js : ${n} verifications OK`);
