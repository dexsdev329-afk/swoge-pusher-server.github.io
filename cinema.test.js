'use strict';
/*
 * LES GALERIES DES SALLES A ECRAN : CE QUI ENTRE, CE QUI N'ENTRE PAS, ET CE
 * QUI SURVIT.
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
 * ---- ET DEPUIS QU'IL Y A PLUSIEURS SALLES ----
 *
 * Le Nexus a trois salles a ecran. Le danger n'est pas dans la troisieme : il
 * est dans l'idee de recopier la mecanique une fois par salle. La regle
 * durcie dans la salle qu'on a sous les yeux, oubliee dans les deux autres, et
 * il suffit de poser la seance dans la salle la moins surveillee. CE FICHIER
 * NE NOMME DONC AUCUNE SALLE : il relit la table de la configuration et
 * rejoue les memes refus dans CHACUNE. Une salle ajoutee a la table est
 * automatiquement mise a l'epreuve ici.
 *
 * ---- ET L'ETAT DEJA EN PRODUCTION ----
 *
 * Le proprietaire a des seances enregistrees. Une relecture qui ne
 * connaitrait que la forme du jour les effacerait au premier redemarrage —
 * sans erreur, sans trace, et personne ne l'aurait su avant d'avoir traverse
 * le hall. C'est le dernier bloc de ce fichier, et c'est celui qui compte.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/cine-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Game } = require('./game');
/* Ni le plafond ni les salles ne sont recopies ici : on les demande a la meme
   source que le moteur. Un « 12 » ou un « manga » ecrit dans cet essai
   resterait vert le jour ou quelqu'un change la table, et c'est exactement le
   jour ou il faut qu'il tombe. */
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const SALLES = cfg.SALLES_ECRAN;
/* Sans ce garde-fou, tout ce fichier passerait sur une table VIDE : chaque
   boucle ferait zero tour et l'essai feliciterait le neant. */
ok(Array.isArray(SALLES) && SALLES.length >= 2,
   `la table declare ${SALLES.length} salles a ecran`);
for (const s of SALLES)
  ok(!!s.cle && !!s.nom && /^[a-z0-9_]+$/.test(s.cle),
     `la salle « ${s.cle} » a une cle utilisable et un nom lisible (« ${s.nom} »)`);

console.log('\n-- une seance valable, DANS CHAQUE SALLE --');
{
  const g = new Game({});
  for (const s of SALLES) {
    const c = g.ajouteCinema(s.cle, { titre: 'SWOGE NIGHT ' + s.cle,
                                      affiche: 'https://exemple.test/a.jpg',
                                      vf: 'https://exemple.test/vf',
                                      vo: 'https://exemple.test/vo' });
    ok(!!c, `« ${s.nom} » accepte une seance`);
    eq(c.titre, 'SWOGE NIGHT ' + s.cle, 'le titre est garde');
    eq(c.vf, 'https://exemple.test/vf', 'la version francaise aussi');
    eq(c.vo, 'https://exemple.test/vo', 'et la version originale');
    eq(g.cinemas[s.cle].length, 1, `et elle est entree dans la galerie de « ${s.cle} »`);
  }
  /* LA PREUVE QUE LES GALERIES SONT SEPAREES : chacune n'a QUE la sienne.
     Une seule galerie partagee aurait donne le meme compte partout, et le
     bloc precedent serait passe sans rien prouver. */
  for (const s of SALLES) {
    eq(g.cinemas[s.cle].length, 1, `« ${s.cle} » n'a que sa propre seance`);
    eq(g.cinemas[s.cle][0].titre, 'SWOGE NIGHT ' + s.cle,
       "et c'est bien la sienne");
  }
}

console.log('\n-- une salle inconnue est REFUSEE, jamais rabattue sur le cinema --');
{
  /* ---- LE DEFAUT QU'ON EVITE ----
   * Retomber sur le cinema quand la cle ne dit rien serait le pire des deux
   * mondes : la seance partirait sur l'ecran de tous les joueurs et personne
   * ne comprendrait pourquoi — ni celui qui l'a posee, qui a vu son geste
   * accepte, ni celui qui la regarde. */
  const g = new Game({});
  const avant = JSON.stringify(g.galeriesToutes());
  const INCONNUES = ['', null, undefined, 'salon', 'CINEMA ', '../cinema', 'cinema2',
                     '__proto__', 'constructor', 'toString'];
  for (const mauvaise of INCONNUES) {
    /* On ASSERTE que la table ne la reconnait pas, on ne saute pas le tour.
       Un « if ... continue » aurait rendu ce bloc complice du defaut qu'il
       surveille : le jour ou la cle inconnue est rabattue sur le cinema,
       `salleEcran` repond oui pour tout, chaque tour est saute, et l'essai
       felicite le vide. */
    eq(Game.salleEcran(mauvaise), null,
       `la table ne reconnait pas « ${String(mauvaise)} »`);
    let leve = null;
    try { g.ajouteCinema(mauvaise, { titre: 'X', vo: 'https://exemple.test/v' }); }
    catch (e) { leve = e.message; }
    ok(!!leve, `« ${String(mauvaise)} » est refusee, et le refus se dit`);
    let leve2 = null;
    try { g.retireCinema(mauvaise, 0); } catch (e) { leve2 = e.message; }
    ok(!!leve2, `« ${String(mauvaise)} » est refusee au retrait aussi`);
    let leve3 = null;
    try { g.modifieCinema(mauvaise, 0, { titre: 'X', vo: 'https://exemple.test/v' }); }
    catch (e) { leve3 = e.message; }
    ok(!!leve3, `« ${String(mauvaise)} » est refusee a la modification aussi`);
  }
  /* Et AUCUNE galerie n'a bouge : le refus ne doit pas avoir depose la seance
     quelque part « en attendant ». */
  eq(JSON.stringify(g.galeriesToutes()), avant, 'et aucune galerie n\'a bouge');
  /* Le message de refus ne recopie pas la cle telle qu'elle est arrivee : un
     message d'erreur est un endroit ou l'on recopie sans y penser. */
  let dit = '';
  try { g.ajouteCinema('<img src=x onerror=1>', { titre: 'X', vo: 'https://e.test/v' }); }
  catch (e) { dit = e.message; }
  ok(dit.indexOf('<') < 0 && dit.indexOf('=') < 0,
     `le refus ne recrache pas la cle telle quelle (« ${dit} »)`);
}

console.log('\n-- plusieurs seances tiennent ensemble, dans chaque salle --');
{
  const g = new Game({});
  for (const s of SALLES) {
    g.ajouteCinema(s.cle, { titre: 'PREMIERE', vo: 'https://exemple.test/1' });
    g.ajouteCinema(s.cle, { titre: 'DEUXIEME', vo: 'https://exemple.test/2' });
    g.ajouteCinema(s.cle, { titre: 'TROISIEME', vf: 'https://exemple.test/3' });
    eq(g.cinemas[s.cle].length, 3, `« ${s.cle} » tient trois seances`);
    eq(g.cinemas[s.cle].map((c) => c.titre).join(','), 'PREMIERE,DEUXIEME,TROISIEME',
       'dans l\'ordre ou elles ont ete posees');
  }
}

console.log('\n-- UNE SEULE PORTE POUR LES TROIS SALLES --');
{
  /* ---- CE QUE CE BLOC PROUVE ----
   * Que l'ajout ET la modification, DANS CHAQUE SALLE, passent par
   * `Game.seanceCinema` — le seul endroit qui nettoie et valide. Le prouver
   * par les refus seulement laisserait vivre une deuxieme porte tant qu'elle
   * refuse les memes choses aujourd'hui ; on veut qu'il n'y ait qu'un chemin,
   * pas deux chemins d'accord entre eux.
   * On compte donc les passages : on remplace la porte par une porte qui
   * compte, et l'on verifie qu'aucun geste ne passe a cote. */
  const vraie = Game.seanceCinema;
  let passages = 0;
  Game.seanceCinema = function (x) { passages++; return vraie.call(Game, x); };
  try {
    const g = new Game({});
    let attendus = 0;
    for (const s of SALLES) {
      g.ajouteCinema(s.cle, { titre: 'A', vo: 'https://exemple.test/a' });
      attendus++;
      eq(passages, attendus, `l'ajout dans « ${s.cle} » passe par la porte unique`);
      g.modifieCinema(s.cle, 0, { titre: 'B', vo: 'https://exemple.test/b' });
      attendus++;
      eq(passages, attendus, `la modification dans « ${s.cle} » aussi`);
    }
    ok(attendus === SALLES.length * 2 && attendus > 0,
       `${attendus} gestes, ${passages} passages : aucun chemin de controle a cote`);
  } finally { Game.seanceCinema = vraie; }
}

console.log('\n-- les memes refus dans TOUTES les salles --');
{
  /* Chaque forme est un vrai vecteur, pas une curiosite : `javascript:` execute,
     `data:` sert une page entiere fabriquee, `vbscript:` marche encore sur de
     vieux moteurs, et l'espace initial est la facon dont on fait passer un
     filtre qui coupe avant de comparer. */
  const MAUVAIS = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'java	script:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//exemple.test/sans-schema',
    '/relatif',
    'exemple.test/sans-schema-du-tout',
  ];
  for (const s of SALLES) {
    const g = new Game({});
    g.ajouteCinema(s.cle, { titre: 'BASE', affiche: 'https://exemple.test/a.jpg',
                            vf: 'https://exemple.test/vf', vo: 'https://exemple.test/vo' });
    for (const mauvais of MAUVAIS) {
      /* A L'AJOUT. */
      const nb = g.cinemas[s.cle].length;
      eq(g.ajouteCinema(s.cle, { titre: 'PIRATE', vf: mauvais, vo: mauvais }), null,
         `« ${s.cle} » : « ${mauvais.trim().slice(0, 24)} » n'entre pas`);
      eq(g.cinemas[s.cle].length, nb, 'et le refus n\'a rien ajoute');
      /* A LA MODIFICATION — la porte derobee qu'on ferme ici : il aurait suffi
         de poser une seance valable puis de la MODIFIER. */
      const intact = JSON.stringify(g.cinemas[s.cle][0]);
      g.modifieCinema(s.cle, 0, { titre: 'PIRATE', affiche: mauvais, vf: mauvais, vo: mauvais });
      eq(JSON.stringify(g.cinemas[s.cle][0]), intact,
         `« ${s.cle} » : la modification ne la fait pas passer non plus`);
    }
    /* Le refus ne doit pas emporter ce qui etait bon a cote. */
    const c = Game.seanceCinema({ titre: 'X', vf: 'javascript:alert(1)',
                                  vo: 'https://exemple.test/vo' });
    eq(c.vo, 'https://exemple.test/vo', 'la version valable a cote survit au refus');
    /* L'affiche passe par le meme filtre : elle finit dans un `<img src>`, ce
       qui est moins grave qu'un iframe mais se refuse pour la meme raison. */
    const d = Game.seanceCinema({ titre: 'X', affiche: 'javascript:alert(1)',
                                  vo: 'https://exemple.test/vo' });
    eq(d.affiche, '', 'l\'affiche passe par le meme filtre');
  }
}

console.log('\n-- pas de moitie de seance, dans aucune salle --');
{
  for (const s of SALLES) {
    const g = new Game({});
    eq(g.ajouteCinema(s.cle, { titre: '', vf: 'https://exemple.test/vf' }), null,
       `« ${s.cle} » : un titre vide n'entre pas`);
    eq(g.ajouteCinema(s.cle, { titre: 'Sans rien derriere' }), null,
       `« ${s.cle} » : un titre sans aucune version ne s'affiche pas`);
    eq(g.ajouteCinema(s.cle, { titre: 'Refusees', vf: 'javascript:x', vo: 'data:x' }), null,
       `« ${s.cle} » : ni un titre dont les deux versions ont ete refusees`);
    eq(g.cinemas[s.cle].length, 0, 'et aucun refus n\'a grossi la galerie');
    /* UNE seule version suffit : on ne force pas le proprietaire a trouver les
       deux avant de pouvoir projeter quoi que ce soit. */
    ok(!!g.ajouteCinema(s.cle, { titre: 'Une seule', vo: 'https://exemple.test/vo' }),
       `« ${s.cle} » : mais UNE version suffit`);
  }
}

console.log('\n-- on en modifie une, et une seule --');
{
  const s = SALLES[0].cle;
  const g = new Game({});
  g.ajouteCinema(s, { titre: 'ALPHA', affiche: 'https://x.test/a.jpg',
                      vf: 'https://x.test/a-vf', vo: 'https://x.test/a-vo' });
  g.ajouteCinema(s, { titre: 'BETA', affiche: 'https://x.test/b.jpg',
                      vf: 'https://x.test/b-vf', vo: '' });
  const c = g.modifieCinema(s, 1, { titre: 'BETA CORRIGE', affiche: 'https://x.test/b2.jpg',
                                    vf: 'https://x.test/b2-vf', vo: 'https://x.test/b2-vo' });
  ok(!!c, 'la seance du rang demande est remplacee');
  eq(g.cinemas[s][1].titre, 'BETA CORRIGE', 'le nouveau titre est en place');
  eq(g.cinemas[s][1].vo, 'https://x.test/b2-vo', 'et la version qui manquait est arrivee');
  /* Le voisin, sinon « ca marche » voudrait dire « ca a ecrit quelque part ». */
  eq(g.cinemas[s][0].titre, 'ALPHA', 'la seance voisine n\'a pas bouge');
  eq(g.cinemas[s][0].vf, 'https://x.test/a-vf', 'ses adresses non plus');
  eq(g.cinemas[s].length, 2, 'et remplacer ne fait pas grandir la galerie');

  /* Les bornes. Un rang hors liste ne doit RIEN toucher — surtout pas la
     derniere par politesse — et une seance vide ne doit pas effacer a moitie
     celle qui etait la. */
  const intact = JSON.stringify(g.cinemas[s]);
  eq(g.modifieCinema(s, 9, { titre: 'X', vf: 'https://x.test/v' }), null, 'un rang hors bornes ne modifie rien');
  eq(g.modifieCinema(s, -1, { titre: 'X', vf: 'https://x.test/v' }), null, 'un rang negatif non plus');
  eq(g.modifieCinema(s, 0, { titre: '', vf: 'https://x.test/v' }), null, 'une seance sans titre est refusee');
  eq(g.modifieCinema(s, 0, { titre: 'T', vf: 'javascript:x', vo: '' }), null,
     'une seance sans aucune version valable aussi');
  eq(JSON.stringify(g.cinemas[s]), intact, 'et apres ces quatre refus la galerie est intacte');

  const g3 = new Game({});
  g3.hydrate(JSON.parse(JSON.stringify(g.serializeTete())));
  eq(g3.cinemas[s].map((x) => x.titre).join(','), 'ALPHA,BETA CORRIGE',
     'la correction survit a la sauvegarde et a la reprise');
}

console.log('\n-- on en retire une, et une seule, dans la bonne salle --');
{
  const g = new Game({});
  for (const s of SALLES) {
    g.ajouteCinema(s.cle, { titre: 'UNE', vo: 'https://exemple.test/1' });
    g.ajouteCinema(s.cle, { titre: 'DEUX', vo: 'https://exemple.test/2' });
    g.ajouteCinema(s.cle, { titre: 'TROIS', vo: 'https://exemple.test/3' });
  }
  const visee = SALLES[0].cle;
  ok(g.retireCinema(visee, 1), 'le rang du milieu se retire');
  eq(g.cinemas[visee].map((c) => c.titre).join(','), 'UNE,TROIS',
     'il reste les deux autres, dans l\'ordre');
  /* LE POINT DU BLOC : les autres salles n'ont PAS bouge. Un retrait qui
     taperait dans une galerie commune se verrait ici, et nulle part ailleurs. */
  for (const s of SALLES.slice(1))
    eq(g.cinemas[s.cle].length, 3, `« ${s.cle} » n'a rien perdu`);
  /* Un rang qui n'existe pas ne doit RIEN retirer. « Retirer la derniere par
     politesse » ferait disparaitre une seance que personne n'a designee. */
  eq(g.retireCinema(visee, 9), false, 'un rang hors bornes ne retire rien');
  eq(g.retireCinema(visee, -1), false, 'un rang negatif non plus');
  eq(g.retireCinema(visee, 'deux'), false, 'ni un rang qui n\'est pas un nombre');
  eq(g.cinemas[visee].length, 2, 'la galerie n\'a pas bouge');
}

console.log('\n-- les bornes de la seance --');
{
  const long = 'https://exemple.test/' + 'a'.repeat(900);
  const c = Game.seanceCinema({ titre: 'T'.repeat(300), vo: long });
  ok(c.titre.length <= 80, `le titre est coupe a ${c.titre.length} caracteres`);
  ok(c.vo.length <= 500, `l'adresse est coupee a ${c.vo.length}`);
  /* Une adresse coupee reste une adresse : le schema est en tete, donc le
     filtre ne peut pas la transformer en autre chose en la raccourcissant. */
  ok(/^https:\/\//.test(c.vo), 'et elle commence toujours par https');
}

console.log('\n-- LE PLAFOND EST PAR SALLE --');
{
  /* ---- POURQUOI UN PLAFOND ----
   * Les galeries partent dans le `hello` de CHAQUE connexion. Sans plafond,
   * c'est un message qui grossit a chaque enregistrement, paye par tous les
   * joueurs a chaque ouverture de page.
   * ---- ET POURQUOI PAR SALLE ----
   * Un plafond commun aurait laisse une salle bien remplie fermer la porte aux
   * deux autres, et le proprietaire aurait lu « la galerie est pleine » devant
   * une galerie vide. */
  const p = new Game({});
  const pleine = SALLES[0].cle;
  for (let i = 0; i < cfg.CINEMA_MAX; i++)
    ok(!!p.ajouteCinema(pleine, { titre: 'S' + i, vo: 'https://exemple.test/' + i }),
       `la seance no ${i + 1} entre dans « ${pleine} »`);
  eq(p.cinemas[pleine].length, cfg.CINEMA_MAX, `« ${pleine} » est pleine a ${cfg.CINEMA_MAX}`);
  /* Le refus du plafond LEVE, la ou une seance mal ecrite rend `null` : ce ne
     sont pas les memes reproches, et les confondre aurait fait relire son
     adresse a quelqu'un dont l'adresse etait bonne. */
  let dit = null;
  try { p.ajouteCinema(pleine, { titre: 'DE TROP', vo: 'https://exemple.test/x' }); }
  catch (e) { dit = e.message; }
  ok(!!dit, 'la suivante est refusee, et le refus se dit');
  ok(dit.includes(String(cfg.CINEMA_MAX)), `le message nomme le plafond (« ${dit} »)`);
  eq(p.cinemas[pleine].length, cfg.CINEMA_MAX, 'et la galerie n\'a pas bouge');
  /* LE POINT DU BLOC : les autres salles restent ouvertes. On ATTRAPE le refus
     plutot que de le laisser remonter : un plafond commun ferait lever ici, et
     l'essai s'arreterait sur une exception nue au lieu de dire laquelle de ses
     promesses est rompue. */
  for (const s of SALLES.slice(1)) {
    let entree = null, refus = null;
    try { entree = p.ajouteCinema(s.cle, { titre: 'AILLEURS', vo: 'https://exemple.test/y' }); }
    catch (e) { refus = e.message; }
    ok(!!entree, `« ${s.cle} » accepte encore, elle a son propre plafond` +
                 (refus ? ` — refus recu : « ${refus} »` : ''));
  }
  /* En retirer une doit rouvrir une place — sinon le plafond serait un
     cul-de-sac, et le panneau n'aurait plus jamais rien a proposer. */
  ok(p.retireCinema(pleine, 0), 'on en retire une');
  ok(!!p.ajouteCinema(pleine, { titre: 'ENFIN', vo: 'https://exemple.test/x' }),
     'et la place liberee reprend une seance');
}

console.log('\n-- toutes les salles survivent a un redemarrage --');
{
  const g = new Game({});
  for (const s of SALLES)
    g.ajouteCinema(s.cle, { titre: 'A L\'AFFICHE ' + s.cle, vo: 'https://exemple.test/' + s.cle });
  const dump = JSON.parse(JSON.stringify(g.serializeTete()));
  ok(dump.cinemas && !Array.isArray(dump.cinemas) && typeof dump.cinemas === 'object',
     'la sauvegarde porte les galeries rangees par salle');
  for (const s of SALLES)
    eq(dump.cinemas[s.cle].length, 1, `« ${s.cle} » est dans la sauvegarde`);
  const g2 = new Game({});
  g2.hydrate(dump);
  for (const s of SALLES)
    eq(g2.cinemas[s.cle].map((c) => c.titre).join(','),
       g.cinemas[s.cle].map((c) => c.titre).join(','),
       `« ${s.cle} » revient telle quelle apres relecture`);
}

console.log('\n-- LES ANCIENNES FORMES NE SONT PAS PERDUES --');
{
  /* ---- LE DEFAUT QU'ON EVITE ICI ----
   * L'etat en service a connu DEUX formes avant celle du jour : `cinemas`, une
   * liste, du temps ou il n'y avait qu'une salle ; et avant elle `cinema`, UN
   * objet, du temps ou il n'y avait qu'une seance. Ne relire que la forme du
   * jour les aurait effacees toutes les deux au premier redemarrage.
   * On ne fabrique pas ces sauvegardes a la main : on reproduit ce que
   * l'ancien code ecrivait — des seances passees par le filtre qui existe
   * encore aujourd'hui. */
  /* La salle ou atterrit l'heritage n'est pas ecrite ici : c'est celle que le
     moteur reconnait comme le cinema historique, ou a defaut la premiere de
     la table. */
  const HERITEE = Game.salleEcran('cinema') || SALLES[0].cle;

  console.log('   (forme 2 : `cinemas`, une liste)');
  const liste = [Game.seanceCinema({ titre: 'LISTE UN', vo: 'https://exemple.test/1' }),
                 Game.seanceCinema({ titre: 'LISTE DEUX', vf: 'https://exemple.test/2' })];
  const g2 = new Game({});
  g2.hydrate({ cinemas: liste });
  eq(g2.cinemas[HERITEE].length, 2, 'la liste devient la galerie du cinema');
  eq(g2.cinemas[HERITEE].map((c) => c.titre).join(','), 'LISTE UN,LISTE DEUX',
     'avec les seances dans l\'ordre');
  for (const s of SALLES.filter((x) => x.cle !== HERITEE))
    eq(g2.cinemas[s.cle].length, 0, `et « ${s.cle} » reste vide, elle n'a jamais rien eu`);

  console.log('   (forme 3 : `cinema`, un objet unique)');
  const seance = Game.seanceCinema({ titre: 'DEJA EN PRODUCTION',
                                     affiche: 'https://exemple.test/a.jpg',
                                     vf: 'https://exemple.test/vf',
                                     vo: 'https://exemple.test/vo' });
  const g3 = new Game({});
  g3.hydrate({ cinema: seance });
  eq(g3.cinemas[HERITEE].length, 1, 'l\'objet unique devient une galerie d\'un element');
  eq(g3.cinemas[HERITEE][0].titre, 'DEJA EN PRODUCTION', 'avec la seance intacte');
  for (const k of Object.keys(seance))
    eq(g3.cinemas[HERITEE][0][k], seance[k],
       `le champ « ${k} » a traverse la conversion`);

  /* Et ce qui est converti se re-sauvegarde dans la forme DU JOUR : sans ca la
     conversion se rejouerait a chaque demarrage, ce qui la rendrait impossible
     a retirer un jour. */
  for (const [quoi, gx] of [['la liste', g2], ['l\'objet unique', g3]]) {
    const redump = JSON.parse(JSON.stringify(gx.serializeTete()));
    ok(redump.cinemas && !Array.isArray(redump.cinemas),
       `apres relecture de ${quoi}, la sauvegarde suivante est rangee par salle`);
    eq(redump.cinema, undefined, 'et l\'ancien champ au singulier n\'est plus ecrit');
    for (const s of SALLES)
      ok(Array.isArray(redump.cinemas[s.cle]), `« ${s.cle} » y a sa galerie`);
  }

  /* Un etat SANS aucune galerie ne doit pas produire de salle fantome. */
  const g4 = new Game({});
  g4.hydrate({});
  for (const s of SALLES)
    eq(g4.cinemas[s.cle].length, 0, `un etat sans cinema laisse « ${s.cle} » vide`);
  /* Et une ancienne seance vide — le champ existait, valant `null` — ne doit
     pas entrer comme une seance sans titre. */
  const g5 = new Game({});
  g5.hydrate({ cinema: null });
  eq(g5.cinemas[HERITEE].length, 0, 'une ancienne seance absente ne devient pas une entree vide');
  const g6 = new Game({});
  g6.hydrate({ cinemas: [null, { titre: '' }, { vo: 'https://exemple.test/x' }] });
  eq(g6.cinemas[HERITEE].length, 0, 'ni des entrees sans titre dans l\'ancienne liste');
}

console.log(`\ncinema.test.js : ${n} verifications OK`);
