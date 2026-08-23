'use strict';
/*
 * LES SALLES A ECRAN, VUES DU DEHORS : LES ROUTES ET LE FIL.
 *
 * ---- POURQUOI CE FICHIER EXISTE, A COTE DE cinema.test.js ----
 *
 * `cinema.test.js` verifie ce que le MOTEUR accepte. Il ne dit rien de ce qui
 * sort sur le fil, et c'est pourtant la que se joue la panne la plus couteuse
 * de ce chantier : la page qui dessine les galeries vit dans un AUTRE depot et
 * lit des noms de champs precis. Si le serveur les appelle autrement, rien ne
 * leve d'erreur — ni ici, ni la-bas. La salle est simplement vide, pour tout
 * le monde, et l'on cherche le defaut dans le dessin.
 *
 * Les trois choses qui doivent se repondre, et qui sont verifiees les unes
 * CONTRE les autres plutot que recopiees trois fois :
 *
 *   1. ce que la route d'administration REND apres un enregistrement ;
 *   2. ce que le `hello` porte a une page qui se connecte ;
 *   3. ce que la diffusion pousse aux pages deja ouvertes.
 *
 * ---- CE QUI EST ECRIT EN DUR, ET POURQUOI SEULEMENT CA ----
 *
 * Les NOMS DE CHAMPS du fil, et rien d'autre. C'est le contrat avec la page
 * d'en face : il vit dans un depot que cet essai ne peut pas lire, et c'est
 * precisement pour ca qu'il doit etre epingle ici. Les salles, leurs noms,
 * leur ordre et le plafond viennent tous de la configuration — les recopier
 * ferait passer cet essai le jour ou la table change, et c'est le jour ou il
 * faut qu'il tombe.
 */
const assert = require('assert');
const fs = require('fs');
const WebSocket = require('ws');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const CLE = 'cle-de-test-cine';
process.env.DATA_DIR = fs.mkdtempSync('/tmp/cine-srv-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = CLE;
process.env.GAME_IMAGE_BASE = 'https://example.invalid/media';
/* Le port se pose AVANT le chargement de la configuration, qui le lit une fois
   pour toutes : plus bas, le serveur ecouterait sur 8080 pendant que l'essai
   frappe ailleurs, et le seul symptome serait « connexion refusee ». */
process.env.PORT = String(9500 + (process.pid % 300));
const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {},
  chatEstPublic() { return true; }, enabled() { return true; } } };

const cfg = require('./config');

/* ---- LE CONTRAT DE FIL, epingle une fois ----
 * `SALLES` : la liste des salles, en tete de `hello` et de chaque diffusion.
 * `CLE`/`NOM`/`SEANCES` : ce que porte chaque entree de cette liste.
 * `HERITE` : l'ancien champ, garde le temps que la page d'en face rattrape. */
const F_SALLES = 'salles';
const F_CLE = 'cle', F_NOM = 'nom', F_SEANCES = 'seances';
const F_HERITE = 'cinemas';

const TABLE = cfg.SALLES_ECRAN;
ok(TABLE.length >= 2, `la table declare ${TABLE.length} salles a ecran`);
/* La salle que l'ancien champ porte. « cinema » est epingle ici parce que
   c'est le contrat de l'accommodation elle-meme — la page en service ne
   connait que le cinema — et non parce qu'on recopierait la table. */
const HERITEE = TABLE.some((s) => s.cle === 'cinema') ? 'cinema' : TABLE[0].cle;

const BASE = 'http://127.0.0.1:' + process.env.PORT;
const entetes = { 'content-type': 'application/json', 'x-admin-key': CLE };
const poste = async (route, corps) => {
  const r = await fetch(BASE + route, { method: 'POST', headers: entetes,
                                        body: JSON.stringify(corps || {}) });
  return { statut: r.status, j: await r.json() };
};
const lit = async (route) => {
  const r = await fetch(BASE + route, { headers: { 'x-admin-key': CLE } });
  return { statut: r.status, j: await r.json() };
};
const dort = (ms) => new Promise((r) => setTimeout(r, ms));
const seance = (t, i) => ({ titre: t, affiche: 'https://exemple.test/a' + i + '.jpg',
                            vf: 'https://exemple.test/vf' + i,
                            vo: 'https://exemple.test/vo' + i });
const galerie = (cle) => lit('/admin/cinema?salle=' + encodeURIComponent(cle));

require('./server');

(async () => {
  await dort(900);

  /* Une page DEJA OUVERTE : c'est elle qui doit recevoir la diffusion. Sans
     elle, la seance n'apparaitrait qu'a ceux qui rechargent, et le
     proprietaire croirait l'avoir ratee. */
  const ouvreSocket = () => new Promise((res, rej) => {
    const s = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    s.on('open', () => res(s)); s.on('error', rej);
  });
  const dernier = (s, t) => [...s.recus].reverse().find((m) => m.type === t);

  const page = await ouvreSocket();
  await dort(300);

  console.log('-- LE FIL DIT QUELLES SALLES EXISTENT, COMMENT LES NOMMER, DANS QUEL ORDRE --');
  {
    /* ---- CE QUE CE BLOC EMPECHE ----
     * La page range les rangees du catalogue avec la salle ou le joueur se
     * tient en tete, puis les autres « dans l'ordre ou le serveur les
     * annonce ». Si elle devait ecrire les noms de son cote, elle dirait
     * « Movies » pendant que la table dit autre chose, et c'est la page qu'on
     * croirait puisque c'est elle qu'on lit. Elle doit pouvoir repondre aux
     * trois questions en ne lisant QUE ce qui arrive. */
    const h = dernier(page, 'hello');
    ok(!!h, 'la page recoit son bonjour');
    const v = h[F_SALLES];
    ok(Array.isArray(v),
       `le bonjour porte « ${F_SALLES} », et c'est une LISTE — l'ordre des cles ` +
       'd\'un objet n\'est pas un contrat');
    eq(v.length, TABLE.length, `elle annonce les ${TABLE.length} salles de la table`);
    /* L'ORDRE, relu de la table et non recopie ici. */
    eq(v.map((s) => s[F_CLE]).join(','), TABLE.map((s) => s.cle).join(','),
       'dans l\'ordre exact de la table');
    for (let i = 0; i < TABLE.length; i++) {
      eq(v[i][F_NOM], TABLE[i].nom,
         `« ${TABLE[i].cle} » arrive avec son nom lisible (« ${TABLE[i].nom} »)`);
      ok(Array.isArray(v[i][F_SEANCES]),
         `et sa galerie « ${F_SEANCES} », une liste meme quand elle est vide`);
      eq(v[i][F_SEANCES].length, 0, 'vide au demarrage');
    }
    /* L'ACCOMMODATION DATEE : la page en service ne lit que l'ancien champ. La
       retirer aujourd'hui viderait le cinema pour tout le monde entre les deux
       deploiements. */
    ok(Array.isArray(h[F_HERITE]),
       `l'ancien champ « ${F_HERITE} » est encore la, accommodation datee`);
    /* Un champ qui vaut tantot `null`, tantot un objet, tantot une liste
       oblige la page a redemander de quelle forme il est aujourd'hui. */
    eq(h.cinema, undefined, 'mais le champ au singulier, lui, a bien disparu');
  }

  console.log('\n-- enregistrer une seance, DANS CHAQUE SALLE, la pousse a tout le monde --');
  {
    for (const s of TABLE) {
      page.recus.length = 0;
      const { statut, j } = await poste('/admin/cinema',
        Object.assign({ salle: s.cle }, seance('PREMIERE ' + s.cle, 1)));
      eq(statut, 200, `« ${s.cle} » : la route repond`);
      eq(j.salle, s.cle, 'et redit de quelle salle elle parle');
      ok(!!j.ajoutee, 'elle dit ce qu\'elle a retenu');
      eq(j.ajoutee.titre, 'PREMIERE ' + s.cle, 'avec le titre');
      eq(j[F_SEANCES].length, 1, 'et rend la galerie entiere, pas seulement l\'ajout');
      await dort(200);
      const d = dernier(page, 'cinema');
      ok(!!d, 'la page ouverte recoit une diffusion');
      ok(Array.isArray(d[F_SALLES]), `la diffusion porte « ${F_SALLES} », comme le bonjour`);
      const dedans = d[F_SALLES].find((x) => x[F_CLE] === s.cle);
      ok(!!dedans, `et l'entree de « ${s.cle} » y est`);
      /* Les sources se verifient l'une contre l'autre : c'est ce qui rend
         impossible de renommer un champ a un seul endroit. */
      eq(JSON.stringify(dedans[F_SEANCES]), JSON.stringify(j[F_SEANCES]),
         'la diffusion dit exactement ce que la route a retenu');
      eq(dedans[F_NOM], s.nom, 'avec le nom lisible, a chaque diffusion');
      eq(d[F_SALLES].map((x) => x[F_CLE]).join(','), TABLE.map((x) => x.cle).join(','),
         'et l\'ordre de la table, a chaque diffusion');
      const g = await galerie(s.cle);
      eq(JSON.stringify(g.j[F_SEANCES]), JSON.stringify(j[F_SEANCES]),
         'la relecture du panneau aussi');
      eq(g.j.max, cfg.CINEMA_MAX, 'et elle annonce le plafond, que le panneau affiche');
    }
    /* L'ANCIEN CHAMP suit la salle du cinema, et elle seule. */
    const d = dernier(page, 'cinema');
    const cine = d[F_SALLES].find((x) => x[F_CLE] === HERITEE);
    eq(JSON.stringify(d[F_HERITE]), JSON.stringify(cine[F_SEANCES]),
       `« ${F_HERITE} » porte la galerie de « ${HERITEE} », et rien d'autre`);
  }

  console.log('\n-- LES SALLES NE SE MELANGENT PAS --');
  {
    /* Le defaut qu'on cherche : une galerie commune derriere trois panneaux.
       Elle se verrait ici, et nulle part ailleurs. */
    const a = TABLE[0].cle, b = TABLE[1].cle;
    const avantB = (await galerie(b)).j[F_SEANCES].length;
    await poste('/admin/cinema', Object.assign({ salle: a }, seance('SEULEMENT DANS ' + a, 7)));
    const ga = (await galerie(a)).j[F_SEANCES];
    const gb = (await galerie(b)).j[F_SEANCES];
    ok(ga.some((c) => c.titre === 'SEULEMENT DANS ' + a), `« ${a} » a recu la seance`);
    ok(!gb.some((c) => c.titre === 'SEULEMENT DANS ' + a), `« ${b} » ne l'a pas recue`);
    eq(gb.length, avantB, `et « ${b} » n'a pas bouge du tout`);
  }

  console.log('\n-- UNE SALLE INCONNUE EST REFUSEE, JAMAIS RABATTUE SUR LE CINEMA --');
  {
    const cine = TABLE[0].cle;
    const avant = (await galerie(cine)).j[F_SEANCES].length;
    for (const mauvaise of ['', 'salon', 'CINEMA ', '../cinema', '__proto__']) {
      if (TABLE.some((s) => s.cle === mauvaise)) continue;
      const r = await poste('/admin/cinema',
        Object.assign({ salle: mauvaise }, seance('EGAREE', 5)));
      eq(r.statut, 400, `« ${mauvaise} » est refusee a l'ajout`);
      ok(!!r.j.error, 'et le refus se dit');
      const m = await poste('/admin/cinema/modifie', { salle: mauvaise, i: 0, titre: 'X', vo: 'https://e.test/v' });
      eq(m.statut, 400, `« ${mauvaise} » est refusee a la modification`);
      const t = await poste('/admin/cinema/retire', { salle: mauvaise, i: 0 });
      eq(t.statut, 400, `« ${mauvaise} » est refusee au retrait`);
      const g = await lit('/admin/cinema?salle=' + encodeURIComponent(mauvaise));
      eq(g.statut, 400, `« ${mauvaise} » est refusee a la lecture`);
    }
    /* LE POINT DU BLOC : la seance egaree n'a atterri NULLE PART, et surtout
       pas dans le cinema. */
    eq((await galerie(cine)).j[F_SEANCES].length, avant,
       'et rien n\'est tombe dans le cinema par defaut');
    for (const s of TABLE)
      ok(!(await galerie(s.cle)).j[F_SEANCES].some((c) => c.titre === 'EGAREE'),
         `« ${s.cle} » n'a pas recueilli la seance egaree`);
    /* Une salle ABSENTE se refuse comme une salle inconnue : sans quoi il
       suffirait d'oublier le champ pour retomber dans le cinema. */
    const sans = await poste('/admin/cinema', seance('SANS SALLE', 6));
    eq(sans.statut, 400, 'une salle absente est refusee comme une salle inconnue');
    const sansGet = await lit('/admin/cinema');
    eq(sansGet.statut, 400, 'a la lecture aussi');
  }

  console.log('\n-- une seance refusee n\'entre pas, et le panneau le voit --');
  {
    for (const s of TABLE) {
      const avant = (await galerie(s.cle)).j[F_SEANCES].length;
      const { statut, j } = await poste('/admin/cinema',
        { salle: s.cle, titre: 'PIEGE', vf: 'javascript:alert(1)', vo: 'data:text/html,x' });
      eq(statut, 200, `« ${s.cle} » : la route repond quand meme`);
      eq(j.ajoutee, null, 'mais elle n\'a rien retenu');
      eq(j[F_SEANCES].length, avant, 'et la galerie n\'a pas grossi');
      /* Ce que le panneau repeint vient de la REPONSE, jamais de ce qu'il a
         envoye : c'est ce qui empeche une adresse refusee de rester affichee
         en ayant l'air enregistree. */
      ok(!(await galerie(s.cle)).j[F_SEANCES].some((c) => c.titre === 'PIEGE'),
         'la seance piegee n\'apparait nulle part apres relecture');
    }
  }

  console.log('\n-- modifier passe par la MEME porte, dans chaque salle --');
  {
    for (const s of TABLE) {
      const avant = (await galerie(s.cle)).j[F_SEANCES];
      const r = await poste('/admin/cinema/modifie',
        Object.assign({ salle: s.cle, i: 0 }, seance('CORRIGEE ' + s.cle, 8)));
      eq(r.statut, 200, `« ${s.cle} » : la modification repond`);
      eq(r.j.modifiee.titre, 'CORRIGEE ' + s.cle, 'et dit ce qu\'elle a retenu');
      eq(r.j[F_SEANCES].length, avant.length, 'remplacer ne fait pas grandir la galerie');
      /* LA PORTE DEROBEE QU'ON FERME : poser une seance valable, puis la
         MODIFIER pour glisser n'importe quelle adresse dans l'iframe. */
      const intact = JSON.stringify((await galerie(s.cle)).j[F_SEANCES][0]);
      const p = await poste('/admin/cinema/modifie',
        { salle: s.cle, i: 0, titre: 'PIRATE', vf: 'javascript:alert(1)', vo: 'data:text/html,x' });
      eq(p.statut, 400, `« ${s.cle} » : une adresse hostile est refusee a la modification`);
      eq(JSON.stringify((await galerie(s.cle)).j[F_SEANCES][0]), intact,
         'et la seance en place n\'a pas bouge');
    }
  }

  console.log('\n-- retirer une seance, et une seule, dans la bonne salle --');
  {
    const s = TABLE[TABLE.length - 1].cle;
    page.recus.length = 0;
    const avant = (await galerie(s)).j[F_SEANCES].length;
    const { statut, j } = await poste('/admin/cinema/retire', { salle: s, i: 0 });
    eq(statut, 200, 'la route de retrait repond');
    eq(j[F_SEANCES].length, avant - 1, 'il y a une seance de moins');
    await dort(200);
    const d = dernier(page, 'cinema');
    const dedans = d[F_SALLES].find((x) => x[F_CLE] === s);
    eq(JSON.stringify(dedans[F_SEANCES]), JSON.stringify(j[F_SEANCES]),
       'le retrait part aux pages ouvertes comme l\'ajout');

    /* Un rang qui n'existe pas ne doit RIEN retirer : « retirer la derniere
       par politesse » ferait disparaitre une seance que personne n'a
       designee. */
    const r = await poste('/admin/cinema/retire', { salle: s, i: 42 });
    eq(r.statut, 400, 'un rang hors bornes est refuse');
    ok(!!r.j.error, 'et le refus se dit');
    eq((await galerie(s)).j[F_SEANCES].length, avant - 1, 'la galerie n\'a pas bouge');
  }

  console.log('\n-- LE PLAFOND EST PAR SALLE --');
  {
    const pleine = TABLE[0].cle, autre = TABLE[1].cle;
    const dedans = () => galerie(pleine).then((r) => r.j[F_SEANCES].length);
    let i = 100;
    while (await dedans() < cfg.CINEMA_MAX) {
      const { j } = await poste('/admin/cinema',
        Object.assign({ salle: pleine }, seance('REMPLISSAGE ' + i, i)));
      ok(!!j.ajoutee, `la seance no ${await dedans()} entre dans « ${pleine} »`);
      i++;
    }
    eq(await dedans(), cfg.CINEMA_MAX, `« ${pleine} » est pleine a ${cfg.CINEMA_MAX}`);
    const trop = await poste('/admin/cinema',
      Object.assign({ salle: pleine }, seance('DE TROP', 999)));
    eq(trop.statut, 400, 'la suivante est refusee');
    ok(trop.j.error && trop.j.error.includes(String(cfg.CINEMA_MAX)),
       `et le refus nomme le plafond (« ${trop.j.error} »)`);
    eq(await dedans(), cfg.CINEMA_MAX, 'la galerie n\'a pas bouge');
    /* LE POINT DU BLOC : une salle pleine ne ferme pas la porte aux autres. */
    const ailleurs = await poste('/admin/cinema',
      Object.assign({ salle: autre }, seance('AILLEURS', 998)));
    ok(!!ailleurs.j.ajoutee, `« ${autre} » accepte encore, elle a son propre plafond`);
    await poste('/admin/cinema/retire', { salle: pleine, i: 0 });
    const rouvre = await poste('/admin/cinema',
      Object.assign({ salle: pleine }, seance('ENFIN', 997)));
    ok(!!rouvre.j.ajoutee, 'une place liberee reprend une seance');
  }

  console.log('\n-- une page qui arrive apres coup voit la meme chose --');
  {
    const tard = await ouvreSocket();
    await dort(300);
    const h = dernier(tard, 'hello');
    for (const s of TABLE) {
      const g = await galerie(s.cle);
      const dedans = h[F_SALLES].find((x) => x[F_CLE] === s.cle);
      eq(JSON.stringify(dedans[F_SEANCES]), JSON.stringify(g.j[F_SEANCES]),
         `« ${s.cle} » : le bonjour porte exactement ce que le serveur a retenu`);
    }
    ok(h[F_SALLES].some((x) => x[F_SEANCES].length > 0),
       'et il y a bien quelque chose a l\'affiche quelque part');
    eq(JSON.stringify(h[F_HERITE]),
       JSON.stringify(h[F_SALLES].find((x) => x[F_CLE] === HERITEE)[F_SEANCES]),
       `l'ancien champ suit toujours « ${HERITEE} », dans le bonjour comme dans la diffusion`);
    tard.close();
  }

  console.log('\n-- ce que le journal admin garde --');
  {
    const { j } = await lit('/adminlog?limite=500');
    const lignes = j.evenements || j.lignes || j;
    const liste = Array.isArray(lignes) ? lignes : [];
    ok(liste.some((e) => e.action === 'cinema'),
       'un ajout laisse une trace au journal admin');
    for (const nom of ['cinema-retire', 'cinema-modifie'])
      ok(liste.some((e) => e.action === nom), `« ${nom} » a son propre nom d'action`);
    const retrait = liste.find((e) => e.action === 'cinema-retire');
    /* Le TITRE, pas le rang : six mois plus tard, « qui a retire la seance de
       samedi » ne se repond pas avec un numero de place. */
    ok(retrait.cible && retrait.cible.indexOf('(inconnue)') < 0,
       `le journal garde le titre retire (« ${retrait.cible} »)`);
    /* ---- ET LA SALLE ----
     * Avec une seule galerie, le titre suffisait. Avec trois, deux salles
     * peuvent annoncer le meme film et la ligne ne dirait pas laquelle a
     * bouge. On ne recopie pas la cle : on la relit dans la table. */
    for (const nom of ['cinema', 'cinema-retire', 'cinema-modifie']) {
      const vues = liste.filter((e) => e.action === nom)
                        .map((e) => String(e.cible || '').split(' : ')[0]);
      ok(vues.length > 0, `« ${nom} » a des lignes a examiner (${vues.length})`);
      ok(vues.every((c) => TABLE.some((s) => s.cle === c)),
         `chaque ligne « ${nom} » nomme une salle de la table`);
    }
    const sallesTracees = new Set(liste.filter((e) => e.action === 'cinema')
                                       .map((e) => String(e.cible || '').split(' : ')[0]));
    eq(sallesTracees.size, TABLE.length,
       `les ${TABLE.length} salles apparaissent au journal, distinctes`);
  }

  page.close();
  console.log(`\ncinema_serveur.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC :', (e && e.stack) || e); process.exit(1); });
