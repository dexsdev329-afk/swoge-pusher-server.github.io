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
 * Il ne contient la liste ni des onglets, ni des panneaux, ni des champs du
 * cinema. Tout est relu dans la page rendue et dans `game.js`. Une liste
 * recopiee ici serait une deuxieme verite : elle resterait verte le jour ou
 * quelqu'un renomme un onglet, et c'est exactement le jour ou il faut qu'elle
 * tombe.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/advues-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const admin = require('./admin');
const { Game } = require('./game');

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

console.log('-- la section cinema est reellement atteignable --');
{
  /* Les identifiants ne sont pas recopies ici : on prend ceux que le bouton
     d'enregistrement LIT vraiment, en relisant son propre code. Renommer un
     champ dans le HTML sans le renommer dans l'envoi fait tomber cet essai.

     On vise l'ENVOI (`post`), pas la premiere mention de l'adresse : depuis que
     le panneau relit la galerie, il la LIT aussi (`lit`), et une recherche sur
     l'adresse seule serait tombee sur la relecture — qui ne lit aucun champ. */
  const i = SCRIPT.indexOf('post("/admin/cinema"');
  ok(i > 0, "la page connait la route d'enregistrement de la seance");
  const envoi = SCRIPT.slice(i, i + 500);
  const champs = uniq(/\$\("#(\w+)"\)/g, envoi);
  ok(champs.size >= 4, `le bouton lit ${champs.size} champs`);

  /* Le panneau qui contient ces champs : on remonte du champ vers la balise
     ouvrante la plus proche au-dessus de lui. */
  const panneauDe = (id) => {
    const j = PAGE.indexOf('id="' + id + '"');
    if (j < 0) return null;
    const avant = PAGE.slice(0, j);
    const k = avant.lastIndexOf('<div data-vue=');
    return k < 0 ? null : (PAGE.slice(k).match(/data-vue="([a-z]+)"/) || [])[1];
  };
  for (const c of champs) {
    const v = panneauDe(c);
    ok(v !== null, `le champ « ${c} » existe dans la page (vue ${v})`);
    ok(ONGLETS.has(v), `et un onglet du menu l'ouvre (${v})`);
  }

  /* La seance se pousse aux joueurs a chaud, sans redemarrage : elle vit donc
     la ou vivent les autres reglages a chaud. On ne nomme pas l'onglet, on
     lit celui du panneau des reglages — le jour ou il demenage, la seance
     doit demenager avec lui. */
  eq(panneauDe('cineGo'), panneauDe('rgCorps'),
     'la seance est rangee avec les autres reglages a chaud');
}

console.log('-- la page envoie exactement ce que le serveur lit --');
{
  /* On ne recopie pas les quatre noms : on demande au serveur lesquels il
     regarde, en lui passant une sonde qui note chaque lecture. */
  const lus = new Set();
  const sonde = new Proxy({}, {
    get(t, k) { if (typeof k === 'string') lus.add(k); return 'https://exemple.test/x'; },
  });
  new Game({}).ajouteCinema(sonde);

  const i = SCRIPT.indexOf('post("/admin/cinema"');
  const envoi = SCRIPT.slice(i, i + 500);
  const envoyes = uniq(/(\w+)\s*:\s*\$\("#\w+"\)\.value/g, envoi);

  ok(lus.size >= 4, `le serveur lit ${lus.size} champs`);
  for (const c of lus) ok(envoyes.has(c), `la page envoie « ${c} », que le serveur lit`);
  for (const c of envoyes) ok(lus.has(c), `le serveur lit « ${c} », que la page envoie`);
}

console.log('-- la galerie du cinema se voit et se defait --');
{
  /* ---- POURQUOI CE BLOC EXISTE ----
   * Le panneau ne savait qu'ECRIRE. On pouvait enregistrer douze seances sans
   * jamais voir la premiere, et il n'existait aucun geste pour en retirer une :
   * la galerie n'aurait fait que grossir jusqu'au plafond, apres quoi le
   * panneau aurait refuse tout ajout sans que personne puisse rien liberer.
   *
   * Rien n'est recopie ici non plus : le rang de retrait vient de la liste
   * peinte, et les deux adresses sont relues dans le script de la page. */
  /* Ce que la page peint doit porter le nom que le serveur RETIENT : on
     demande au moteur de quoi il tient une liste, et l'on verifie que le
     panneau parle bien de ce champ-la. */
  const g = new Game({});
  g.ajouteCinema({ titre: 'T', vo: 'https://exemple.test/vo' });
  ok(Array.isArray(g.cinemas), 'le moteur tient une LISTE de seances');
  ok(/cinemas/.test(SCRIPT), 'et le panneau lit ce meme nom de champ');

  ok(SCRIPT.indexOf('lit("/admin/cinema")') > 0,
     'la page RELIT la galerie retenue par le serveur');
  ok(SCRIPT.indexOf('post("/admin/cinema/retire"') > 0,
     'et connait la route qui retire une seance');
  /* Le retrait ne peut pas viser une place inventee : le numero envoye est lu
     sur le bouton que la liste vient de peindre. */
  ok(/data-cine-retire/.test(PAGE), 'le rang a retirer vient du bouton de la liste');
  /* Et la liste vit dans le MEME onglet que les champs : une galerie rangee
     ailleurs que sa saisie serait deux moities d'un meme reglage. */
  const panneauDe = (id) => {
    const j = PAGE.indexOf('id="' + id + '"');
    if (j < 0) return null;
    const k = PAGE.slice(0, j).lastIndexOf('<div data-vue=');
    return k < 0 ? null : (PAGE.slice(k).match(/data-vue="([a-z]+)"/) || [])[1];
  };
  eq(panneauDe('cineListe'), panneauDe('cineGo'),
     'la galerie et les champs sont dans le meme panneau');
}

console.log(`\n${n} verifications, 0 echec.`);
