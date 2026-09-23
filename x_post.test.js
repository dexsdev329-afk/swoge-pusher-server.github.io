'use strict';
/*
 * LES POSTS SUR X — ce qu on verifie sans toucher a X ni a OpenAI.
 *
 *  1. La signature OAuth 1.0a, contre l exemple CHIFFRE de la documentation
 *     de X (docs.x.com, « creating a signature », lu le 18 septembre 2026) :
 *     memes cles, meme nonce, meme horodatage, meme signature attendue au
 *     caractere pres. Une signature fausse donne un 401 sans autre detail.
 *  2. Sans les cles, rien ne part et le module DIT ce qui manque.
 *  3. L heure : midi et minuit a PARIS, ete comme hiver, et un creneau = une cle.
 *  4. Les scenes tournent : jamais une des six dernieres.
 *  5. Le texte respecte les regles quoi qu ait ecrit le modele.
 *  6. Des tours complets contre de faux serveurs : l ordre des appels, le
 *     corps du post, UN post par creneau, deux par jour avec des scenes et
 *     des angles differents, un refus de X qui ne fait pas repayer l image,
 *     la reprise, et un post special sur un sujet impose.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'xpost-'));
process.env.DATA_DIR = VOL;
for (const k of ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'X_LIEN', 'X_HEURE', 'X_HEURES', 'X_FUSEAU']) delete process.env[k];

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; console.log('  ok   ' + m); };

const x = require('./x_post');

(async () => {
  console.log('-- 1. la signature, contre l exemple de la documentation --');
  {
    const cles = { ck: 'xvz1evFS4wEEPTGEFPHBog', cs: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
                   at: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', as: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' };
    const s = x.signeOAuth('POST', 'https://api.x.com/1.1/statuses/update.json',
      { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' }, cles,
      { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958 });
    eq(s.base, 'POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
       'la chaine de base est celle de la documentation, au caractere pres');
    eq(s.signature, 'Ls93hJiZbQ3akF3HF3x1Bz8/zU4=', 'et la signature aussi');
    ok(/^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="/.test(s.entete) && /oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D"/.test(s.entete),
       'l en-tete porte la signature encodee, dans l ordre des cles');
    eq(x.enc("Hello Ladies + Gentlemen, a signed OAuth request!"), 'Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21',
       'l encodage suit la RFC 3986 : le point d exclamation aussi');
    eq(x.enc("!'()*"), '%21%27%28%29%2A', 'les cinq que encodeURIComponent laisse passer');
  }

  console.log('\n-- 2. sans cles, rien ne part --');
  {
    let appels = 0;
    const r = await x.tache({ prendre: async () => { appels++; throw new Error('ne doit pas etre appele'); } });
    eq(r.etat, 'inactif', 'le tour se dit inactif');
    eq(r.manque.join(','), 'X_CONSUMER_KEY,X_CONSUMER_SECRET,X_ACCESS_TOKEN,X_ACCESS_SECRET,OPENAI_API_KEY', 'et nomme ce qui manque, sans valeur');
    eq(appels, 0, 'aucun appel reseau');
    eq(x.planifie(), null, 'et le serveur n arme rien');
  }

  console.log('\n-- 3. midi et minuit a Paris, ete comme hiver --');
  {
    const H = ['12:00', '00:00'];
    eq(x.env().heures.join(','), '06:00,12:00,20:00,00:00', 'par defaut : 6h, midi, 20h, minuit');
    eq(x.env().fuseau, 'Europe/Paris', 'a l heure de Paris');
    eq(x.creneauDu(Date.parse('2026-09-18T21:59:00Z'), H, 'Europe/Paris').cle, '2026-09-18#12:00', 'a 23 h 59 a Paris (ete), le creneau en cours est celui de midi');
    eq(x.creneauDu(Date.parse('2026-09-18T22:00:00Z'), H, 'Europe/Paris').cle, '2026-09-19#00:00', 'a minuit pile a Paris, c est le creneau de minuit du jour suivant');
    eq(x.creneauDu(Date.parse('2026-09-19T09:59:00Z'), H, 'Europe/Paris').cle, '2026-09-19#00:00', 'a 11 h 59, toujours celui de minuit — pas encore midi');
    eq(x.creneauDu(Date.parse('2026-09-19T10:00:00Z'), H, 'Europe/Paris').cle, '2026-09-19#12:00', 'a midi pile, celui de midi');
    eq(x.creneauDu(Date.parse('2026-12-01T23:00:00Z'), H, 'Europe/Paris').cle, '2026-12-02#00:00', 'en hiver, minuit a Paris tombe a 23 h UTC : pas de recalcul a la main');
    eq(x.creneauDu(Date.parse('2026-09-19T08:00:00Z'), ['16:00'], 'UTC'), null, 'un seul horaire pas encore passe : aucun creneau, on attend');
  }

  console.log('\n-- 4. les scenes tournent --');
  {
    ok(x.SCENES.length >= 24, x.SCENES.length + ' scenes dans la banque');
    eq(new Set(x.SCENES.map((s) => s.nom)).size, x.SCENES.length, 'toutes de nom different');
    const journal = { jours: {} }; const vues = new Set(); let doublons = 0;
    const fenetre = [];
    for (let i = 0; i < 120; i++) {
      const cle = '2026-10-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + (i % 2 ? '#00:00' : '#12:00');
      const s = x.sceneSuivante(cle, journal);
      if (fenetre.includes(s.nom)) doublons++;
      fenetre.push(s.nom); if (fenetre.length > 6) fenetre.shift();
      journal.jours[cle] = { scene: s.nom, id: String(i), quand: new Date(Date.UTC(2026, 9, 1) + i * 43200000).toISOString() }; vues.add(s.nom);
    }
    eq(doublons, 0, 'jamais une des six dernieres, sur cent vingt posts');
    ok(vues.size >= 24, vues.size + ' scenes differentes en soixante jours');
    /* ---- PLUS DE PIECES A EMPREINTE DE PATTE ----
     * Elles etaient dans le STYLE, donc sur chaque image, scene apres scene.
     * Retirees le 19 septembre 2026 : elles remplissaient le fond sans rien
     * raconter. Le refus est ECRIT, pas seulement le motif retire — le modele
     * a vu ce motif sur des dizaines d images de la meme famille. */
    ok(x.SCENES.every((s) => !/paw print/i.test(s.prompt)), 'aucune scene ne demande d empreinte de patte');
    ok(x.SCENES.every((s) => /No paw prints anywhere/.test(x.promptImage(s, 'k'))), 'et chaque prompt la refuse explicitement');
    ok(!/paw print/i.test(x.promptImage(x.SCENES[0], 'k').replace(/No paw prints[^.]*\./, '')),
       'le style lui-meme n en porte plus');
    ok(/no text, no letters/i.test(x.promptImage(x.SCENES[0], 'k')) && /buff Doge/.test(x.promptImage(x.SCENES[0], 'k')),
       'le prompt porte le personnage et refuse le texte dans l image');
    /* ---- CHAQUE IMAGE A SON PROPRE MONDE ----
     * Releve du proprietaire, 19 septembre 2026 : les images se ressemblaient
     * toutes. La cause etait dans le code — un STYLE unique (bleu nuit, vert
     * electrique, traces de circuit) colle devant les trente scenes. Ce qui
     * est verifie ici est donc la CAUSE, pas le symptome : aucun decor commun,
     * un monde par scene, et une direction artistique tiree du creneau. */
    ok(x.SCENES.every((s) => s.monde && s.monde.length > 20), 'chaque scene porte son lieu, sa lumiere et sa palette');
    eq(new Set(x.SCENES.map((s) => s.monde)).size, x.SCENES.length, 'et deux scenes ne partagent jamais le meme monde');
    ok(x.SCENES.every((s) => x.promptImage(s, 'k').includes(s.monde)), 'le monde de la scene est bien dans le prompt');
    ok(x.RENDUS.length >= 10, x.RENDUS.length + ' directions artistiques');
    ok(x.RENDUS.every((r) => !/crypto|coin|chart|neon|circuit/i.test(r)),
       'aucune ne parle de crypto : c est le sujet qui raconte, pas la technique');
    {
      /* La meme scene, deux creneaux eloignes : si le rendu ne tournait pas,
         la banque de scenes ne suffirait pas a varier les images. */
      const vus = new Set();
      for (let i = 0; i < 60; i++) vus.add(x.renduDe('2026-10-' + String(1 + Math.floor(i / 2)).padStart(2, '0') + (i % 2 ? '#00:00' : '#12:00')));
      ok(vus.size >= 8, vus.size + ' rendus differents sur trente jours de posts');
      ok(x.promptImage(x.SCENES[0], 'a#12:00') !== x.promptImage(x.SCENES[0], 'b#00:00')
         || x.promptImage(x.SCENES[0], 'a#12:00') !== x.promptImage(x.SCENES[0], 'c#00:00'),
         'la meme scene revenue plus tard n est pas rendue de la meme facon');
      eq(x.renduDe('meme#cle'), x.renduDe('meme#cle'), 'mais une reprise du meme creneau refait exactement la meme image');
    }
    /* Les cliches que le modele ramene tout seul des qu il sent le sujet. */
    ok(/candlestick|trading screens/i.test(x.NEGATIF) && /floating coins/i.test(x.NEGATIF),
       'courbes, ecrans et pluie de pieces sont refuses par ecrit');
    ok(x.promptImage({ nom: 'special', prompt: 'on a boat with a cigar' }, 'k').length > 100,
       'une scene ecrite a la main depuis le panneau passe sans monde, sans casser le prompt');
    ok(x.ANGLES.length >= 8, x.ANGLES.length + ' angles d ecriture');
  }

  console.log('\n-- 5. le texte, quoi qu ait ecrit le modele --');
  {
    eq(x.nettoie('"  Big day for the dog!  "', false), 'Big day for the dog! $SWOGE', 'guillemets retires, $SWOGE ajoute s il manque');
    eq(x.nettoie('Go go go https://evil.example/x $SWOGE', false), 'Go go go $SWOGE', 'un lien que le modele a glisse est retire : il couterait treize fois le prix');
    const long = x.nettoie('word '.repeat(80) + '$SWOGE', false);
    ok(long.length <= 280 && /\$SWOGE/.test(long), 'coupe a 280 caracteres, $SWOGE toujours la (' + long.length + ')');
    const avec = x.nettoie('To the moon $SWOGE 🚀', true);
    ok(/\nhttps:\/\/swoleeswoge\.dog$/.test(avec) && avec.length <= 280, 'avec X_LIEN, le lien du site est ajoute en derniere ligne');
    ok(x.RESERVE.every((t) => x.nettoie(t, false).length <= 280 && /\$SWOGE/.test(x.nettoie(t, false))), 'les phrases de reserve passent les memes regles');
    const faits = x.faitsDuJour(Date.now());
    ok(faits.length >= 5 && faits.some((f) => /SWOGE Bet/.test(f)) && faits.some((f) => /AI agent/.test(f)), 'les faits du jour parlent du site, et de l agent lui-meme');
  }

  console.log('\n-- 5 bis. le journal du premier jour --');
  {
    /* Le 18 septembre 2026, il y avait un post par jour, sous la cle du jour.
       Elle se lit comme le creneau de midi : sinon le serveur, au premier
       tour apres deploiement, aurait « rattrape » un midi deja poste. */
    fs.mkdirSync(VOL, { recursive: true });
    fs.writeFileSync(path.join(VOL, 'x_posts.json'), JSON.stringify({ jours: { '2026-09-18': { scene: 'course', id: '1', quand: '2026-09-18T16:47:00.000Z', texte: 'x $SWOGE' } } }));
    const j = x.litJournal();
    ok(j.jours['2026-09-18#12:00'] && !j.jours['2026-09-18'], 'une cle sans creneau se lit comme le creneau de midi');
    fs.unlinkSync(path.join(VOL, 'x_posts.json'));
  }

  console.log('\n-- 6. des tours complets, contre de faux serveurs --');
  {
    Object.assign(process.env, { X_CONSUMER_KEY: 'ck', X_CONSUMER_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as',
                                 OPENAI_API_KEY: 'ok', ANTHROPIC_API_KEY: 'ak' });
    const appels = [];
    let refuseTweet = false; let nTexte = 0;
    const faux = async (url, o) => {
      const u = String(url); const corps = o && o.body ? JSON.parse(o.body) : null;
      appels.push({ u, corps, auth: (o && o.headers && (o.headers.authorization || o.headers['x-api-key'])) || '' });
      const rep = (statut, j) => ({ ok: statut < 300, status: statut, json: async () => j, text: async () => JSON.stringify(j) });
      if (/openai/.test(u)) return rep(200, { data: [{ b64_json: Buffer.from('PNG-factice').toString('base64') }], usage: { output_tokens: 6893 } });
      if (/anthropic/.test(u)) { nTexte++; return rep(200, { content: [{ type: 'text', text: `"Post number ${nTexte}, one very buff dog. $SWOGE Bet is LIVE 🏟️🐕 https://spam.example"` }] }); }
      if (/media\/upload/.test(u)) return rep(200, { data: { id: '777', media_key: '3_777' } });
      if (/2\/tweets/.test(u)) return refuseTweet ? rep(403, { detail: 'Forbidden' }) : rep(201, { data: { id: String(900 + appels.length), text: corps.text } });
      throw new Error('url inattendue ' + u);
    };
    const MIDI = Date.parse('2026-09-19T10:00:00Z');       // midi a Paris
    /* A 11 h, le creneau en cours est celui de 6 h, jamais parti : le
       serveur le rattrape, c est voulu (un redeploiement a 06 h 30 ne doit pas
       perdre le post de 6 h). Avec les quatre creneaux par defaut, 6 h est le
       dernier horaire passe avant 11 h. */
    let r = await x.tache({ maintenant: MIDI - 3600000, prendre: faux });
    eq(r.etat, 'poste', 'a 11 h, le creneau de 6 h n est pas parti : il part — un creneau manque se rattrape');
    eq(r.cle, '2026-09-19#06:00', 'sous la cle de 6 h');
    const journal6h = x.litJournal();
    ok(journal6h.jours['2026-09-19#06:00'].angle, 'un angle d ecriture est note : ' + journal6h.jours['2026-09-19#06:00'].angle.slice(0, 30));

    /* Un refus de X a midi : l image doit etre gardee. */
    refuseTweet = true;
    const avantMidi = appels.length;
    r = await x.tache({ maintenant: MIDI + 60000, prendre: faux });
    eq(r.etat, 'rate', 'X refuse a midi : le tour se dit rate');
    eq(r.cle, '2026-09-19#12:00', 'sous la cle de midi');
    ok(/HTTP 403/.test(r.erreur) && /Forbidden/.test(r.erreur), 'et l erreur dit le code et le detail de X : ' + r.erreur);
    ok(fs.existsSync(path.join(x.DOSSIER_IMAGES(), '2026-09-19_12_00.png')), 'l image est sur le volume');
    const demandeTexte = appels.slice(avantMidi).find((a) => /anthropic/.test(a.u)).corps.messages[0].content;
    ok(/Previous posts/.test(demandeTexte) && /Post number 1/.test(demandeTexte), 'le modele recoit les posts precedents pour ne pas les repeter');
    ok(/ANGLE: /.test(demandeTexte), 'et l angle du creneau');
    /* ---- LA PLUPART DES POSTS NE PARLENT PAS DU SITE ----
     * « Pas forcement parler du site, juste faire un tweet bullish » : huit
     * angles sur onze interdisent de nommer quoi que ce soit, et sur ceux-la
     * les faits ne sont donnes que pour ne pas etre contredits. */
    eq(x.ANGLES.filter((a) => !a.produit).length, 8, 'huit angles sur ' + x.ANGLES.length + ' sont du pur bullish, sans produit');
    ok(x.ANGLES.every((a) => a.a && typeof a.produit === 'boolean'), 'et chacun dit s il a le droit de nommer quelque chose');
    const sansProduit = x.ANGLES.find((a) => !a.produit).a;
    const avecProduit = x.ANGLES.find((a) => a.produit).a;
    let d1 = null;
    await x.ecritTexte(['fait A', 'fait B'], { scene: { prompt: 's' }, cle: 'k', angle: sansProduit },
                       async (u, o) => { d1 = JSON.parse(o.body).messages[0].content; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'pure vibes $SWOGE 🐕' }] }) }; });
    ok(/NO PRODUCT/.test(d1) && /do not quote any of it/.test(d1) && !/^Facts:/m.test(d1),
       'sur un angle sans produit, le modele recoit l interdiction et les faits en simple garde-fou');
    let d2 = null;
    await x.ecritTexte(['fait A'], { scene: { prompt: 's' }, cle: 'k', angle: avecProduit },
                       async (u, o) => { d2 = JSON.parse(o.body).messages[0].content; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'one thing $SWOGE 🐕' }] }) }; });
    ok(!/NO PRODUCT/.test(d2) && /^Facts:/m.test(d2), 'et sur un angle produit, il recoit les faits pour de bon');
    let d3 = null;
    await x.ecritTexte(['fait A'], { scene: { prompt: 's' }, cle: 'k', angle: sansProduit, sujet: 'une annonce' },
                       async (u, o) => { d3 = JSON.parse(o.body).messages[0].content; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'news $SWOGE 🐕' }] }) }; });
    ok(!/NO PRODUCT/.test(d3) && /Today.s announcement/.test(d3),
       'un post special parle TOUJOURS de son sujet, quel que soit l angle : c est sa raison d etre');

    refuseTweet = false;
    let signale = null;
    r = await x.tache({ maintenant: MIDI + 600000, prendre: faux, signale: (s) => { signale = s; } });
    eq(r.etat, 'poste', 'au tour suivant, poste');
    eq(appels.filter((a) => /openai/.test(a.u)).length, 2, 'deux images payees en tout : 6 h, midi — pas une de plus pour la reprise');
    eq(appels.filter((a) => /anthropic/.test(a.u)).length, 2, 'deux textes');
    const j = x.litJournal();
    ok(j.jours['2026-09-19#06:00'].scene !== j.jours['2026-09-19#12:00'].scene, 'deux scenes differentes le meme jour : ' + j.jours['2026-09-19#06:00'].scene + ' puis ' + j.jours['2026-09-19#12:00'].scene);
    ok(j.jours['2026-09-19#06:00'].texte !== j.jours['2026-09-19#12:00'].texte, 'et deux textes differents');
    const media = appels.find((a) => /media\/upload/.test(a.u));
    eq(media.corps.media_category, 'tweet_image', 'le media est declare image de post');
    eq(media.corps.media, Buffer.from('PNG-factice').toString('base64'), 'et porte le PNG en base64');
    ok(/^OAuth oauth_consumer_key="ck", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="at", oauth_version="1.0"$/.test(media.auth),
       'signe en OAuth 1.0a, jeton du compte, nonce neuf');
    const tweet = appels.filter((a) => /2\/tweets/.test(a.u)).pop();
    eq(tweet.corps.media.media_ids.join(','), '777', 'le post attache l identifiant du media');
    ok(/^Post number 2, one very buff dog\. \$SWOGE Bet is LIVE 🏟️🐕$/.test(tweet.corps.text), 'le texte est celui du modele, nettoye : guillemets et lien retires');
    ok(signale && signale.id === r.id && signale.url === 'https://x.com/SwoleDogeSwoge/status/' + r.id, 'et le Telegram est prevenu avec le lien du post');

    r = await x.tache({ maintenant: MIDI + 7200000, prendre: faux });
    eq(r.etat, 'deja', 'a 14 h, le creneau de midi est deja parti : rien');
    const d = x.derniere();
    ok(d.actif && d.derniere && d.derniere.cle === '2026-09-19#12:00' && d.derniere.image === '/x/image/2026-09-19_12_00.png' && d.recents.length === 2 && !JSON.stringify(d).includes('"ck"'),
       '/x/derniere dit le dernier post, son image, les recents, et aucune cle');

    /* Trois refus, et on s arrete ; puis la reprise. */
    refuseTweet = true;
    const MINUIT = Date.parse('2026-09-19T22:00:00Z');
    for (let i = 0; i < 3; i++) r = await x.tache({ maintenant: MINUIT, prendre: faux });
    eq(r.essais, 3, 'trois essais a minuit');
    r = await x.tache({ maintenant: MINUIT, prendre: faux });
    eq(r.etat, 'abandon', 'au quatrieme, on abandonne le creneau en le disant');
    refuseTweet = false;
    const imagesAvant = appels.filter((a) => /openai/.test(a.u)).length;
    eq(x.reprend(), 1, 'reprendre remet a zero le creneau rate');
    r = await x.tache({ maintenant: MINUIT + 60000, prendre: faux });
    eq(r.etat, 'poste', 'et le post part sans attendre le creneau suivant');
    eq(appels.filter((a) => /openai/.test(a.u)).length, imagesAvant, 'avec l image deja payee');
    eq(x.reprend(), 0, 'plus rien a reprendre');

    /* Un post special : sujet impose, image a lui, hors creneau. */
    const avantSpecial = appels.length;
    r = await x.tache({ maintenant: MINUIT + 120000, prendre: faux,
                        special: { nom: 'agent', sujet: 'An AI agent now writes, illustrates and posts here on its own', prompt: 'at a desk with a robot painter' } });
    eq(r.etat, 'poste', 'un post special part meme quand le creneau est deja servi');
    eq(r.cle, '2026-09-19#agent', 'sous sa propre cle');
    ok(/Today's announcement.*AI agent now writes/.test(appels.slice(avantSpecial).find((a) => /anthropic/.test(a.u)).corps.messages[0].content), 'le modele recoit le sujet impose');
    ok(/at a desk with a robot painter/.test(appels.slice(avantSpecial).find((a) => /openai/.test(a.u)).corps.prompt), 'et l image, sa scene a elle');
    r = await x.tache({ maintenant: MINUIT + 180000, prendre: faux, special: { nom: 'agent', sujet: 'encore' } });
    eq(r.etat, 'deja', 'le meme post special ne part pas deux fois le meme jour');
    r = await x.tache({ maintenant: MINUIT + 180000, prendre: faux, special: { nom: 'sans-sujet' } });
    eq(r.etat, 'refuse', 'et sans sujet, refuse');
  }

  console.log(`\nx_post.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('  RATE ' + (e.message || e)); console.log(`x_post.test.js : RATES : 1/${n + 1}`); process.exit(1); });
