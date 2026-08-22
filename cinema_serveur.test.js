'use strict';
/*
 * LA GALERIE DU CINEMA, VUE DU DEHORS : LES ROUTES ET LE FIL.
 *
 * ---- POURQUOI CE FICHIER EXISTE, A COTE DE cinema.test.js ----
 *
 * `cinema.test.js` verifie ce que le MOTEUR accepte. Il ne dit rien de ce qui
 * sort sur le fil, et c'est pourtant la que se joue la panne la plus couteuse
 * de ce chantier : la page qui dessine la galerie vit dans un AUTRE depot et
 * lit un nom de champ precis. Si le serveur l'appelle autrement, rien ne leve
 * d'erreur — ni ici, ni la-bas. La salle est simplement vide, pour tout le
 * monde, et l'on cherche le defaut dans le dessin.
 *
 * Les trois choses qui doivent se repondre, et qui sont verifiees les unes
 * CONTRE les autres plutot que recopiees trois fois :
 *
 *   1. ce que la route d'administration REND apres un enregistrement ;
 *   2. ce que le `hello` porte a une page qui se connecte ;
 *   3. ce que la diffusion pousse aux pages deja ouvertes.
 *
 * Une seule valeur est ecrite en dur dans ce fichier : le nom du champ. C'est
 * le contrat avec la page d'en face, il vit dans un depot que cet essai ne
 * peut pas lire, et c'est precisement pour ca qu'il doit etre epingle ici.
 * Tout le reste en est deduit.
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

/* LE NOM DU CHAMP, epingle une fois. La page d'en face lit `m.cinemas`. */
const CHAMP = 'cinemas';

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

  console.log('-- au depart, une galerie vide, pas un champ absent --');
  {
    const h = dernier(page, 'hello');
    ok(!!h, 'la page recoit son bonjour');
    ok(Array.isArray(h[CHAMP]),
       `le bonjour porte « ${CHAMP} », et c'est une liste meme quand elle est vide`);
    eq(h[CHAMP].length, 0, 'vide au demarrage');
    /* Un champ qui vaut tantot `null`, tantot un objet, tantot une liste
       oblige la page a redemander de quelle forme il est aujourd'hui. */
    eq(h.cinema, undefined, 'et l\'ancien champ au singulier n\'est plus sur le fil');
  }

  console.log('\n-- enregistrer une seance la pousse a tout le monde --');
  {
    page.recus.length = 0;
    const { statut, j } = await poste('/admin/cinema', seance('PREMIERE', 1));
    eq(statut, 200, 'la route repond');
    ok(!!j.ajoutee, 'elle dit ce qu\'elle a retenu');
    eq(j.ajoutee.titre, 'PREMIERE', 'avec le titre');
    eq(j[CHAMP].length, 1, 'et rend la galerie entiere, pas seulement l\'ajout');
    await dort(200);
    const d = dernier(page, 'cinema');
    ok(!!d, 'la page ouverte recoit une diffusion');
    ok(Array.isArray(d[CHAMP]), `la diffusion porte « ${CHAMP} », au pluriel`);
    /* Les trois sources se verifient l'une contre l'autre : c'est ce qui rend
       impossible de renommer le champ a un seul endroit. */
    eq(JSON.stringify(d[CHAMP]), JSON.stringify(j[CHAMP]),
       'et la diffusion dit exactement ce que la route a retenu');
    const g = await lit('/admin/cinema');
    eq(JSON.stringify(g.j[CHAMP]), JSON.stringify(j[CHAMP]),
       'la relecture du panneau aussi');
    eq(g.j.max, cfg.CINEMA_MAX, 'et elle annonce le plafond, que le panneau affiche');
  }

  console.log('\n-- une deuxieme seance ne remplace pas la premiere --');
  {
    const { j } = await poste('/admin/cinema', seance('DEUXIEME', 2));
    eq(j[CHAMP].length, 2, 'la galerie en compte deux');
    eq(j[CHAMP][0].titre, 'PREMIERE', 'la premiere est toujours la');
    eq(j[CHAMP][1].titre, 'DEUXIEME', 'et la nouvelle est apres');
  }

  console.log('\n-- une seance refusee n\'entre pas, et le panneau le voit --');
  {
    const avant = (await lit('/admin/cinema')).j[CHAMP].length;
    const { statut, j } = await poste('/admin/cinema',
      { titre: 'PIEGE', vf: 'javascript:alert(1)', vo: 'data:text/html,x' });
    eq(statut, 200, 'la route repond quand meme');
    eq(j.ajoutee, null, 'mais elle n\'a rien retenu');
    eq(j[CHAMP].length, avant, 'et la galerie n\'a pas grossi');
    /* Ce que le panneau repeint vient de la REPONSE, jamais de ce qu'il a
       envoye : c'est ce qui empeche une adresse refusee de rester affichee en
       ayant l'air enregistree. */
    const g = await lit('/admin/cinema');
    ok(!g.j[CHAMP].some((c) => c.titre === 'PIEGE'),
       'la seance piegee n\'apparait nulle part apres relecture');
  }

  console.log('\n-- retirer une seance, et une seule --');
  {
    page.recus.length = 0;
    const { statut, j } = await poste('/admin/cinema/retire', { i: 0 });
    eq(statut, 200, 'la route de retrait repond');
    eq(j[CHAMP].length, 1, 'il reste une seance');
    eq(j[CHAMP][0].titre, 'DEUXIEME', 'et c\'est l\'autre');
    await dort(200);
    const d = dernier(page, 'cinema');
    eq(JSON.stringify(d[CHAMP]), JSON.stringify(j[CHAMP]),
       'le retrait part aux pages ouvertes comme l\'ajout');

    /* Un rang qui n'existe pas ne doit RIEN retirer : « retirer la derniere
       par politesse » ferait disparaitre une seance que personne n'a
       designee. */
    const r = await poste('/admin/cinema/retire', { i: 42 });
    eq(r.statut, 400, 'un rang hors bornes est refuse');
    ok(!!r.j.error, 'et le refus se dit');
    eq((await lit('/admin/cinema')).j[CHAMP].length, 1, 'la galerie n\'a pas bouge');
  }

  console.log('\n-- le plafond se dit, et il se rouvre --');
  {
    const dedans = () => lit('/admin/cinema').then((r) => r.j[CHAMP].length);
    let i = 100;
    while (await dedans() < cfg.CINEMA_MAX) {
      const { j } = await poste('/admin/cinema', seance('REMPLISSAGE ' + i, i));
      ok(!!j.ajoutee, `la seance no ${await dedans()} entre`);
      i++;
    }
    eq(await dedans(), cfg.CINEMA_MAX, `la galerie est pleine a ${cfg.CINEMA_MAX}`);
    const trop = await poste('/admin/cinema', seance('DE TROP', 999));
    eq(trop.statut, 400, 'la suivante est refusee');
    ok(trop.j.error && trop.j.error.includes(String(cfg.CINEMA_MAX)),
       `et le refus nomme le plafond (« ${trop.j.error} »)`);
    eq(await dedans(), cfg.CINEMA_MAX, 'la galerie n\'a pas bouge');
    await poste('/admin/cinema/retire', { i: 0 });
    const rouvre = await poste('/admin/cinema', seance('ENFIN', 998));
    ok(!!rouvre.j.ajoutee, 'une place liberee reprend une seance');
  }

  console.log('\n-- une page qui arrive apres coup voit la meme galerie --');
  {
    const tard = await ouvreSocket();
    await dort(300);
    const h = dernier(tard, 'hello');
    const g = await lit('/admin/cinema');
    eq(JSON.stringify(h[CHAMP]), JSON.stringify(g.j[CHAMP]),
       'le bonjour porte exactement ce que le serveur a retenu');
    ok(h[CHAMP].length > 0, `et il y a bien quelque chose a l'affiche (${h[CHAMP].length})`);
    tard.close();
  }

  console.log('\n-- ce que le journal admin garde --');
  {
    const { j } = await lit('/adminlog?limite=200');
    const lignes = j.evenements || j.lignes || j;
    const liste = Array.isArray(lignes) ? lignes : [];
    ok(liste.some((e) => e.action === 'cinema'),
       'un ajout laisse une trace au journal admin');
    const retrait = liste.find((e) => e.action === 'cinema-retire');
    ok(!!retrait, 'un retrait aussi, sous son propre nom');
    /* Le TITRE, pas le rang : six mois plus tard, « qui a retire la seance de
       samedi » ne se repond pas avec un numero de place. */
    ok(retrait.cible && retrait.cible !== '(inconnue)',
       `et le journal garde le titre retire (« ${retrait.cible} »)`);
  }

  page.close();
  console.log(`\ncinema_serveur.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC :', (e && e.stack) || e); process.exit(1); });
