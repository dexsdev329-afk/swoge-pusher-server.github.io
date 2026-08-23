'use strict';
/*
 * OU SE TROUVENT LES PANNEAUX DU PANNEAU D'ADMINISTRATION.
 *
 * ---- POURQUOI CE FICHIER EXISTE ----
 *
 * La section « Cinema » a ete ecrite, testee cote serveur, deployee — et le
 * proprietaire ne l'a pas trouvee. Elle n'etait pas cassee : elle etait rangee
 * dans l'onglet « Jeux & paris », ou personne ne va chercher une seance de
 * cinema. Aucun essai ne regardait OU vivait un panneau, seulement s'il
 * fonctionnait. Un reglage introuvable ne vaut pas mieux qu'un reglage absent.
 *
 * Deux facons de rendre un panneau introuvable, et les deux etaient presentes :
 *
 *  1. LUI DONNER UNE VUE SANS ONGLET. La feuille de style cache tout ce qui
 *     porte `data-vue` et ne montre que la vue courante. Une vue qu'aucun
 *     bouton du menu ne demande n'apparait jamais.
 *  2. NE PAS LUI DONNER DE VUE DU TOUT. La regle ne s'applique qu'a ce qui
 *     porte `data-vue` : un panneau sans attribut echappe au filtre et
 *     s'affiche sur les NEUF onglets a la fois. C'etait le cas du panneau des
 *     rencontres, visible jusque dans « Systeme ».
 *
 * ---- CE QUE CE FICHIER NE FAIT PAS ----
 *
 * Il ne contient la liste ni des onglets, ni des panneaux, ni des champs, ni
 * des salles a ecran. Tout est relu dans la page rendue, dans `game.js` et
 * dans la table de `config.js`. Une liste recopiee ici serait une deuxieme
 * verite : elle resterait verte le jour ou quelqu'un renomme un onglet ou une
 * salle, et c'est exactement le jour ou il faut qu'elle tombe.
 *
 * ---- ET DEPUIS QU'IL Y A TROIS SALLES A ECRAN ----
 *
 * Les sections du cinema, de la salle manga et de la salle series sont
 * ENGENDREES par une boucle sur la table. Le defaut qu'on surveille ici n'est
 * donc plus « la section est introuvable » mais « la section a ete recopiee » :
 * trois copies, c'est trois verites, et la correction suivante ira dans celle
 * qu'on a sous les yeux. On verifie donc qu'il y a une section PAR ENTREE DE
 * LA TABLE, que leurs identifiants sont uniques, et que le script ne nomme
 * aucune salle en clair.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/advues-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const admin = require('./admin');
const { Game } = require('./game');
/* La table des salles vient de la SOURCE, jamais recopiee ici : un « manga »
   ecrit dans cet essai resterait vert le jour ou la table change de nom, et
   c'est exactement le jour ou il faut qu'il tombe. */
const cfg = require('./config');
const SALLES = cfg.SALLES_ECRAN;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const PAGE = admin.page('jeton-de-test');
/* Le menu s'arrete au premier </nav> : un `data-go` ecrit plus bas dans le
   corps ne serait pas un onglet, et le compter en ferait un a tort. */
const MENU = PAGE.slice(PAGE.indexOf('<nav'), PAGE.indexOf('</nav>'));
const SCRIPT = PAGE.slice(PAGE.lastIndexOf('<script>'));

const uniq = (re, s) => {
  const v = new Set(); let m;
  while ((m = re.exec(s))) v.add(m[1]);
  return v;
};

const ONGLETS = uniq(/data-go="([a-z]+)"/g, MENU);
const VUES = uniq(/data-vue="([a-z]+)"/g, PAGE);
/* Une vue peut aussi etre ouverte par le script lui-meme — la fiche d'un
   joueur s'ouvre depuis une ligne de la liste, pas depuis le menu. On ne
   l'inscrit pas en dur : on constate que le routage la connait. */
const ROUTEES = uniq(/VUE === "([a-z]+)"/g, SCRIPT);

console.log('-- le script de la page se compile --');
{
  /* ---- CE QUI A MANQUE LE PLUS LONGTEMPS ----
   * Aucun essai ne compilait le script de cette page. `node --check admin.js`
   * passait — et passera toujours — parce que la page est un GABARIT DE
   * CHAINE : pour node, ces mille cinq cents lignes sont du texte, pas du
   * code. Une barre echappee dans le gabarit a suffi pour que la regex
   * arrive au navigateur sans etre fermee, et TOUT le panneau est mort :
   * plus un chiffre, plus un bouton, plus un retrait. Rien ne l'a dit. Les
   * essais d'ici relisaient le HTML avec des expressions regulieres, ce qui
   * ne demande jamais au texte s'il est du JavaScript valide.
   * `new Function` le demande : il COMPILE sans executer. */
  const blocs = [...PAGE.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok(blocs.length >= 2, `la page porte ${blocs.length} blocs de script`);
  /* Un seuil, sinon « tout compile » serait vrai d'une page sans code : le
     jour ou le decoupage ci-dessus ne trouve plus rien, l'essai doit tomber
     et non feliciter le vide. */
  const lignes = blocs.reduce((n, b) => n + b.split('\n').length, 0);
  ok(lignes > 800, `et ${lignes} lignes de code au total`);
  blocs.forEach((b, i) => {
    let faute = null;
    try { new Function(b); } catch (e) { faute = e.message; }
    ok(faute === null, `le bloc ${i + 1} se compile${faute ? ' — ' + faute : ''}`);
  });
}

console.log('-- le menu et les panneaux se repondent --');
ok(ONGLETS.size >= 5, `le menu a des onglets (${ONGLETS.size})`);
ok(VUES.size >= ONGLETS.size, `et chaque onglet a de quoi remplir (${VUES.size} vues)`);

for (const v of VUES) {
  ok(ONGLETS.has(v) || ROUTEES.has(v),
     `la vue « ${v} » est joignable ${ONGLETS.has(v) ? 'par le menu' : 'par le script'}`);
}
for (const o of ONGLETS) {
  ok(VUES.has(o), `l'onglet « ${o} » ouvre au moins un panneau`);
}

console.log('-- aucun panneau ne flotte hors des onglets --');
{
  /* On relit les balises ouvrantes des panneaux plutot que leur titre : c'est
     l'attribut qui decide de l'affichage, pas le texte. */
  const orphelins = [];
  const re = /<div ([^>]*class="panel"[^>]*)>/g;
  let m, total = 0;
  while ((m = re.exec(PAGE))) {
    total++;
    if (!/data-vue="/.test(m[1])) {
      /* On nomme le coupable par son titre : « un panneau » ne se retrouve pas. */
      const t = PAGE.slice(m.index, m.index + 260).match(/<h2>([^<]*)<\/h2>/);
      orphelins.push(t ? t[1] : m[1]);
    }
  }
  ok(total >= 10, `la page a bien des panneaux (${total})`);
  eq(orphelins.length, 0,
     `aucun panneau sans onglet — sinon il s'affiche sur les ${ONGLETS.size} a la fois` +
     (orphelins.length ? ` : ${orphelins.join(', ')}` : ''));
}

ok(SALLES.length >= 2, `la table declare ${SALLES.length} salles a ecran`);

/* On remonte d'un identifiant vers la vue du panneau qui le contient. */
const panneauDe = (id) => {
  const j = PAGE.indexOf('id="' + id + '"');
  if (j < 0) return null;
  const k = PAGE.slice(0, j).lastIndexOf('<div data-vue=');
  return k < 0 ? null : (PAGE.slice(k).match(/data-vue="([a-z]+)"/) || [])[1];
};

console.log('-- IL Y A UNE SECTION PAR SALLE, ET ELLES SONT ENGENDREES --');
{
  /* ---- CE QUE CE BLOC EMPECHE ----
   * Recopier la section une fois par salle. Le jour ou l'on corrige un
   * libelle, un identifiant ou un geste, la correction va dans celle qu'on a
   * sous les yeux et la salle oubliee garde le vieux defaut. On ne verifie
   * donc pas « il y a trois sections » : on verifie qu'il y en a UNE PAR
   * ENTREE DE LA TABLE, quelle que soit la table. Ajouter une quatrieme salle
   * doit faire apparaitre une quatrieme section sans toucher a admin.js. */
  for (const S of SALLES) {
    ok(PAGE.indexOf('id="cine_' + S.cle + '_liste"') > 0,
       `« ${S.nom} » a sa galerie dans la page`);
    /* Le NOM LISIBLE vient de la table, pas d'un titre ecrit a la main : deux
       verites qui divergent au premier renommage, et c'est la page qu'on lit. */
    ok(PAGE.indexOf(S.nom) > 0, `et son nom lisible y est affiche (« ${S.nom} »)`);
  }
  /* Et pas une de plus : une section restee d'une salle retiree de la table
     ecrirait dans une salle que le serveur refuse, sans que rien ne le dise
     avant le clic. */
  const vues = new Set();
  const re = /id="cine_([a-z0-9_]+)_liste"/g;
  let m;
  while ((m = re.exec(PAGE))) vues.add(m[1]);
  eq([...vues].sort().join(','), SALLES.map((s) => s.cle).sort().join(','),
     'et la page ne montre QUE les salles de la table');
}

console.log('-- chaque section est complete, et rangee au bon endroit --');
{
  /* Ce que la section actuelle sait faire doit exister DANS CHAQUE SALLE : la
     liste des seances, un bouton par ligne, les champs pour ajouter, le bouton
     d'abandon. Une salle a qui il manquerait le retrait ne ferait que grossir
     jusqu'au plafond, apres quoi le panneau refuserait tout sans que personne
     puisse rien liberer. */
  const MORCEAUX = ['liste', 'titre', 'aff', 'vf', 'vo', 'go', 'annule', 'msg'];
  for (const S of SALLES) {
    for (const quoi of MORCEAUX)
      ok(PAGE.indexOf('id="cine_' + S.cle + '_' + quoi + '"') > 0,
         `« ${S.cle} » a son element « ${quoi} »`);
    /* Les trois sections restent dans l'onglet des reglages a chaud : une
       seance se pousse aux joueurs sans redemarrage, elle vit donc la ou
       vivent les autres reglages a chaud. On ne nomme pas l'onglet, on lit
       celui du panneau des reglages — le jour ou il demenage, les salles
       demenagent avec lui. */
    eq(panneauDe('cine_' + S.cle + '_go'), panneauDe('rgCorps'),
       `« ${S.cle} » est rangee avec les autres reglages a chaud`);
    eq(panneauDe('cine_' + S.cle + '_liste'), panneauDe('cine_' + S.cle + '_go'),
       `et sa galerie est dans le meme panneau que ses champs`);
    ok(ONGLETS.has(panneauDe('cine_' + S.cle + '_go')),
       `qu'un onglet du menu ouvre (${panneauDe('cine_' + S.cle + '_go')})`);
  }
}

console.log('-- les identifiants sont UNIQUES, salle par salle --');
{
  /* ---- LE DEFAUT QU'ON EVITE ----
   * Trois sections partageant un meme id="cineTitre" : le navigateur ne rend
   * que le premier, et l'on aurait ecrit dans la salle manga en voyant le
   * cinema se remplir. Rien n'aurait leve. */
  const tous = [];
  const re = /id="([a-zA-Z0-9_]+)"/g;
  let m;
  while ((m = re.exec(PAGE))) tous.push(m[1]);
  const doubles = tous.filter((x, i) => tous.indexOf(x) !== i);
  ok(tous.length > 40, `la page porte ${tous.length} identifiants`);
  eq(doubles.length, 0,
     'aucun identifiant en double dans la page' +
     (doubles.length ? ` : ${[...new Set(doubles)].join(', ')}` : ''));
}

console.log('-- le script ne parle d\'aucune salle en dur --');
{
  /* ---- CE QUE CE BLOC PROUVE ----
   * Que la troisieme section n'est pas une copie de la premiere. Si le script
   * nommait les salles, il faudrait le rouvrir pour en ajouter une — et c'est
   * precisement ce qu'on refuse. Il recoit la table du serveur et boucle
   * dessus.
   * On ne cherche pas les cles une par une : une salle nommee « series » se
   * confondrait avec le mot anglais. On cherche les IDENTIFIANTS ecrits en
   * clair, qui eux ne peuvent venir que d'une section recopiee. */
  for (const S of SALLES)
    ok(SCRIPT.indexOf('#cine_' + S.cle + '_') < 0,
       `le script ne designe aucun element de « ${S.cle} » en clair`);
  /* Et il recoit bien la table : sans elle, la boucle n'aurait rien a
     parcourir et les sections resteraient muettes. */
  const i = SCRIPT.indexOf('var SALLES =');
  ok(i > 0, 'le script recoit la table des salles du serveur');
  const decl = SCRIPT.slice(i, SCRIPT.indexOf(';', i) + 1);
  let table = null;
  try { table = new Function(decl + ' return SALLES;')(); } catch (e) { table = null; }
  ok(Array.isArray(table), 'et elle se relit comme une liste');
  eq(table.map((s) => s.cle).join(','), SALLES.map((s) => s.cle).join(','),
     'exactement la table de la configuration, dans le meme ordre');
  for (const S of SALLES)
    eq((table.find((x) => x.cle === S.cle) || {}).nom, S.nom,
       `avec le nom lisible de « ${S.cle} », que la page n'a donc pas a ecrire`);
}

console.log('-- la page envoie exactement ce que le serveur lit --');
{
  /* On ne recopie pas les quatre noms de champs : on demande au serveur
     lesquels il regarde, en lui passant une sonde qui note chaque lecture. La
     salle, elle, n'est pas un champ du formulaire — c'est le premier argument
     du moteur, parce qu'elle ne vient pas de ce que quelqu'un a tape mais de
     la section dans laquelle on ecrit. */
  const lus = new Set();
  const sonde = new Proxy({}, {
    get(t, k) { if (typeof k === 'string') lus.add(k); return 'https://exemple.test/x'; },
  });
  new Game({}).ajouteCinema(SALLES[0].cle, sonde);

  const i = SCRIPT.indexOf('$(cineId(cle,"go")).onclick');
  ok(i > 0, "la page a un bouton d'enregistrement de la seance");
  const envoi = SCRIPT.slice(i, i + 1100);
  const envoyes = uniq(/(\w+)\s*:\s*\$\(cineId\(cle,"\w+"\)\)\.value/g, envoi);

  ok(lus.size >= 4, `le serveur lit ${lus.size} champs`);
  for (const c of lus) ok(envoyes.has(c), `la page envoie « ${c} », que le serveur lit`);
  for (const c of envoyes) ok(lus.has(c), `le serveur lit « ${c} », que la page envoie`);
  /* Et elle dit DE QUELLE SALLE il s'agit, sinon le serveur refuse : une
     salle absente est aussi inconnue qu'une salle mal ecrite. */
  ok(/salle\s*:\s*cle/.test(envoi), 'et elle joint la salle a chaque enregistrement');
}

console.log('-- les galeries se voient et se defont --');
{
  /* ---- POURQUOI CE BLOC EXISTE ----
   * Le panneau ne savait qu'ECRIRE. On pouvait enregistrer douze seances sans
   * jamais voir la premiere, et il n'existait aucun geste pour en retirer une :
   * la galerie n'aurait fait que grossir jusqu'au plafond, apres quoi le
   * panneau aurait refuse tout ajout sans que personne puisse rien liberer.
   *
   * Rien n'est recopie ici non plus : le rang de retrait vient de la liste
   * peinte, et le nom du champ vient de ce que le SERVEUR retient. */
  const g = new Game({});
  g.ajouteCinema(SALLES[0].cle, { titre: 'T', vo: 'https://exemple.test/vo' });
  ok(Array.isArray(g.galerieCinema(SALLES[0].cle)),
     'le moteur tient une LISTE de seances par salle');
  ok(SCRIPT.indexOf('j.seances') > 0,
     'et le panneau peint ce que la route rend pour CETTE salle');

  ok(SCRIPT.indexOf('lit(cineRoute(cle))') > 0,
     'la page RELIT la galerie retenue par le serveur, salle par salle');
  ok(SCRIPT.indexOf('post("/admin/cinema/retire"') > 0,
     'et connait la route qui retire une seance');
  ok(SCRIPT.indexOf('post(enEdition ? "/admin/cinema/modifie" : "/admin/cinema"') > 0,
     'et celle qui en modifie une');
  /* Le retrait ne peut pas viser une place inventee : le numero envoye est lu
     sur le bouton que la liste vient de peindre. */
  ok(/data-cine-retire/.test(PAGE), 'le rang a retirer vient du bouton de la liste');
  ok(/data-cine-edit/.test(PAGE), 'le rang a corriger aussi');
  /* Le bouton d'abandon d'edition : sans lui, commencer une correction par
     erreur laisse le formulaire coince en mode remplacement. */
  ok(SCRIPT.indexOf('cineModeAjout(cle)') > 0, 'et l\'abandon d\'edition revient a l\'ajout');
}

console.log(`\n${n} verifications, 0 echec.`);
