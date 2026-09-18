'use strict';
/*
 * LE POST QUOTIDIEN SUR X — ce qu on verifie sans toucher a X ni a OpenAI.
 *
 *  1. La signature OAuth 1.0a, contre l exemple CHIFFRE de la documentation
 *     de X (docs.x.com, « creating a signature », lu le 18 septembre 2026) :
 *     memes cles, meme nonce, meme horodatage, meme signature attendue au
 *     caractere pres. Une signature fausse donne un 401 sans autre detail.
 *  2. Sans les cles, rien ne part et le module DIT ce qui manque.
 *  3. Les scenes tournent : jamais la meme deux jours de suite.
 *  4. Le texte respecte les regles quoi qu ait ecrit le modele.
 *  5. Un tour complet contre de faux serveurs : l ordre des appels, le corps
 *     du post, UN post par jour, et un refus de X qui ne fait pas repayer
 *     l image.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'xpost-'));
process.env.DATA_DIR = VOL;
for (const k of ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'X_LIEN', 'X_HEURE']) delete process.env[k];

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

  console.log('\n-- 3. les scenes tournent --');
  {
    ok(x.SCENES.length >= 20, x.SCENES.length + ' scenes dans la banque');
    eq(new Set(x.SCENES.map((s) => s.nom)).size, x.SCENES.length, 'toutes de nom different');
    const t0 = Date.parse('2026-09-18T12:00:00Z');
    const journal = { jours: {} }; const vues = new Set(); let repetes = 0; let prec = null;
    for (let i = 0; i < 90; i++) {
      const t = t0 + i * 86400000;
      const s = x.sceneDuJour(t, journal);
      if (prec === s.nom) repetes++;
      journal.jours[x.jourDe(t)] = { scene: s.nom }; vues.add(s.nom); prec = s.nom;
    }
    eq(repetes, 0, 'jamais la meme deux jours de suite sur quatre-vingt-dix jours');
    ok(vues.size >= 20, vues.size + ' scenes differentes en quatre-vingt-dix jours');
    ok(/no text, no letters/i.test(x.promptImage(x.SCENES[0])) && /buff Doge/.test(x.promptImage(x.SCENES[0])),
       'le prompt porte le personnage et refuse le texte dans l image');
  }

  console.log('\n-- 4. le texte, quoi qu ait ecrit le modele --');
  {
    eq(x.nettoie('"  Big day for the dog!  "', false), 'Big day for the dog! $SWOGE', 'guillemets retires, $SWOGE ajoute s il manque');
    eq(x.nettoie('Go go go https://evil.example/x $SWOGE', false), 'Go go go $SWOGE', 'un lien que le modele a glisse est retire : il couterait treize fois le prix');
    const long = x.nettoie('word '.repeat(80) + '$SWOGE', false);
    ok(long.length <= 280 && /\$SWOGE/.test(long), 'coupe a 280 caracteres, $SWOGE toujours la (' + long.length + ')');
    const avec = x.nettoie('To the moon $SWOGE 🚀', true);
    ok(/\nhttps:\/\/swoleeswoge\.dog$/.test(avec) && avec.length <= 280, 'avec X_LIEN, le lien du site est ajoute en derniere ligne');
    ok(x.RESERVE.every((t) => x.nettoie(t, false).length <= 280 && /\$SWOGE/.test(x.nettoie(t, false))), 'les phrases de reserve passent les memes regles');
    const faits = x.faitsDuJour(Date.now());
    ok(faits.length >= 4 && faits.some((f) => /SWOGE Bet/.test(f)), 'les faits du jour parlent du site : ' + faits[0].slice(0, 60));
    ok(x.heureAtteinte(Date.parse('2026-09-18T16:00:00Z'), '16:00') && !x.heureAtteinte(Date.parse('2026-09-18T15:59:00Z'), '16:00'),
       'l heure est comparee en UTC, a la minute');
  }

  console.log('\n-- 5. un tour complet, contre de faux serveurs --');
  {
    Object.assign(process.env, { X_CONSUMER_KEY: 'ck', X_CONSUMER_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as',
                                 OPENAI_API_KEY: 'ok', ANTHROPIC_API_KEY: 'ak', X_HEURE: '16:00' });
    const appels = [];
    let refuseTweet = false;
    const faux = async (url, o) => {
      const u = String(url); const corps = o && o.body ? JSON.parse(o.body) : null;
      appels.push({ u, corps, auth: (o && o.headers && (o.headers.authorization || o.headers['x-api-key'])) || '' });
      const rep = (statut, j) => ({ ok: statut < 300, status: statut, json: async () => j, text: async () => JSON.stringify(j) });
      if (/openai/.test(u)) return rep(200, { data: [{ b64_json: Buffer.from('PNG-factice').toString('base64') }], usage: { output_tokens: 6893 } });
      if (/anthropic/.test(u)) return rep(200, { content: [{ type: 'text', text: '"Seven sports, one very buff dog. $SWOGE Bet is LIVE 🏟️🐕 https://spam.example"' }] });
      if (/media\/upload/.test(u)) return rep(200, { data: { id: '777', media_key: '3_777' } });
      if (/2\/tweets/.test(u)) return refuseTweet ? rep(403, { detail: 'Forbidden' }) : rep(201, { data: { id: '999', text: corps.text } });
      throw new Error('url inattendue ' + u);
    };
    const T = Date.parse('2026-09-18T15:00:00Z');
    let r = await x.tache({ maintenant: T, prendre: faux });
    eq(r.etat, 'attend', 'avant l heure, on attend (' + r.heure + ' UTC)');
    eq(appels.length, 0, 'et rien n est appele');

    /* Un refus de X d abord : l image doit etre gardee. */
    refuseTweet = true;
    r = await x.tache({ maintenant: T + 3600000, prendre: faux });
    eq(r.etat, 'rate', 'X refuse : le tour se dit rate');
    eq(r.essais, 1, 'premier essai compte');
    ok(/HTTP 403/.test(r.erreur) && /Forbidden/.test(r.erreur), 'et l erreur dit le code et le detail de X : ' + r.erreur);
    ok(fs.existsSync(path.join(x.DOSSIER_IMAGES(), '2026-09-18.png')), 'l image est sur le volume');
    eq(appels.filter((a) => /openai/.test(a.u)).length, 1, 'une image payee');

    refuseTweet = false;
    let signale = null;
    r = await x.tache({ maintenant: T + 7200000, prendre: faux, signale: (s) => { signale = s; } });
    eq(r.etat, 'poste', 'au second tour, poste');
    eq(r.id, '999', 'avec l identifiant rendu par X');
    eq(appels.filter((a) => /openai/.test(a.u)).length, 1, 'SANS repayer l image : celle du disque a servi');
    eq(appels.filter((a) => /anthropic/.test(a.u)).length, 1, 'ni reecrire le texte');
    const ordre = appels.map((a) => /openai/.test(a.u) ? 'image' : /anthropic/.test(a.u) ? 'texte' : /media/.test(a.u) ? 'media' : 'tweet');
    eq(ordre.join(','), 'image,texte,media,tweet,media,tweet', 'l ordre : image, texte, media, post — puis media, post au second tour');
    const media = appels.find((a) => /media\/upload/.test(a.u));
    eq(media.corps.media_category, 'tweet_image', 'le media est declare image de post');
    eq(media.corps.media, Buffer.from('PNG-factice').toString('base64'), 'et porte le PNG en base64');
    ok(/^OAuth oauth_consumer_key="ck", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="at", oauth_version="1.0"$/.test(media.auth),
       'signe en OAuth 1.0a, jeton du compte, nonce neuf');
    const tweet = appels.filter((a) => /2\/tweets/.test(a.u)).pop();
    eq(tweet.corps.media.media_ids.join(','), '777', 'le post attache l identifiant du media');
    eq(tweet.corps.text, 'Seven sports, one very buff dog. $SWOGE Bet is LIVE 🏟️🐕', 'le texte est celui du modele, nettoye : guillemets et lien retires');
    ok(signale && signale.id === '999' && signale.url === 'https://x.com/SwoleDogeSwoge/status/999', 'et le Telegram est prevenu avec le lien du post');

    r = await x.tache({ maintenant: T + 10800000, prendre: faux });
    eq(r.etat, 'deja', 'un troisieme tour le meme jour ne reposte pas');
    eq(appels.filter((a) => /2\/tweets/.test(a.u)).length, 2, 'aucun appel de plus');
    const d = x.derniere();
    ok(d.actif && d.derniere && d.derniere.id === '999' && d.derniere.image === '/x/image/2026-09-18.png' && !JSON.stringify(d).includes('"ck"'),
       '/x/derniere dit le post du jour, son image, et aucune cle');

    /* Le lendemain : nouveau post, autre scene. */
    r = await x.tache({ maintenant: T + 86400000 + 7200000, prendre: faux });
    eq(r.etat, 'poste', 'le lendemain, un nouveau post');
    const j = x.litJournal();
    ok(j.jours['2026-09-19'].scene !== j.jours['2026-09-18'].scene, 'avec une autre scene : ' + j.jours['2026-09-18'].scene + ' puis ' + j.jours['2026-09-19'].scene);

    /* Trois refus, et on s arrete. */
    refuseTweet = true;
    const T2 = T + 2 * 86400000 + 7200000;
    for (let i = 0; i < 3; i++) r = await x.tache({ maintenant: T2, prendre: faux });
    eq(r.essais, 3, 'trois essais');
    r = await x.tache({ maintenant: T2, prendre: faux });
    eq(r.etat, 'abandon', 'au quatrieme, on abandonne la journee en le disant');
  }

  console.log(`\nx_post.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('  RATE ' + (e.message || e)); console.log(`x_post.test.js : RATES : 1/${n + 1}`); process.exit(1); });
