'use strict';
/*
 * LA VEILLE DES COMPTES SUIVIS — ce qu on verifie sans toucher a X.
 *
 *  1. Sans chat prive, rien ne part et le module dit ce qui manque : un lien
 *     qui poste au nom du compte ne va jamais dans le canal public.
 *  2. Le filtre de mots : ce qui parle de chiens, de Doge, de sport, d Optimus
 *     ou d IA passe ; le reste n est meme pas montre au modele.
 *  3. Un tour complet contre de faux serveurs : identifiant du compte garde,
 *     lecture avec since_id, posts trop vieux sautes, plafond du jour, quatre
 *     heures entre deux propositions du meme compte, « non pertinent » qui ne
 *     coute ni image ni Telegram, et la proposition envoyee avec ses boutons.
 *  4. Le bouton : poster envoie une REPONSE (in_reply_to_tweet_id) avec
 *     l image deja generee, une seule fois ; ignorer n envoie rien ; un lien
 *     inconnu ou expire ne fait rien.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'xveille-'));
process.env.DATA_DIR = VOL;
for (const k of ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'X_VEILLE_CHAT', 'TG_BACKUP_CHAT_ID', 'X_VEILLE', 'X_VEILLE_MAX_JOUR', 'RAILWAY_PUBLIC_DOMAIN']) delete process.env[k];
process.env.TG_BOT_TOKEN = 'bot-factice';
process.env.RAILWAY_PUBLIC_DOMAIN = 'serveur.test';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; console.log('  ok   ' + m); };

const x = require('./x_reponse');

(async () => {
  console.log('-- 1. sans chat prive, rien --');
  {
    Object.assign(process.env, { X_CONSUMER_KEY: 'ck', X_CONSUMER_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as', OPENAI_API_KEY: 'ok', ANTHROPIC_API_KEY: 'ak' });
    const r = await x.veille({ prendre: async () => { throw new Error('ne doit pas etre appele'); } });
    eq(r.etat, 'inactif', 'la veille se dit inactive');
    ok(r.manque.some((m) => /X_VEILLE_CHAT/.test(m)), 'et reclame un chat PRIVE : ' + r.manque.join(', '));
    eq(x.planifie(), null, 'le serveur n arme rien');
    /* Vecu le 18 septembre 2026 : le nom du canal public dans la variable. */
    process.env.X_VEILLE_CHAT = '@swogecanal';
    let r2 = await x.veille({ prendre: async () => { throw new Error('ne doit pas etre appele'); } });
    ok(r2.etat === 'inactif' && r2.manque.some((m) => /NUMERIQUE/.test(m)), 'un canal « @… » est refuse en le disant : les boutons n iront jamais devant tout le monde');
    process.env.X_VEILLE_CHAT = '-1001234567890';
    r2 = await x.veille({ prendre: async () => { throw new Error('ne doit pas etre appele'); } });
    eq(r2.etat, 'inactif', 'un groupe « -100… » aussi');
    delete process.env.X_VEILLE_CHAT;
  }

  console.log('\n-- 2. le filtre de mots --');
  {
    ok(x.sujet('Just adopted a new dog, meet Floki').includes('dog'), 'un chien passe');
    ok(x.sujet('Doge to the moon').length >= 2, 'Doge et la lune passent');
    ok(x.sujet('Optimus will change everything').includes('optimus'), 'Optimus passe');
    ok(x.sujet('AI is the future').includes('ai'), 'l IA passe, en mot entier');
    eq(x.sujet('Available in stores now').length, 0, '« available » ne contient pas « ai » : mot entier seulement');
    eq(x.sujet('Meeting the team in Berlin tomorrow').length, 0, 'un post qui ne parle de rien de tout ca ne passe pas');
    ok(x.sujet('Tesla stock', ['tesla']).includes('tesla'), 'X_VEILLE_MOTS ajoute des mots');
    eq(x.nettoieReponse('"Woof. https://spam.example #ad Nice dog"'), 'Woof. Nice dog', 'une reponse est nettoyee : ni lien ni dieze');
    ok(x.nettoieReponse('a '.repeat(150)).length <= 200, 'et coupee a deux cents caracteres');
  }

  console.log('\n-- 3. un tour complet --');
  {
    process.env.X_VEILLE_CHAT = '12345'; process.env.X_VEILLE = 'elonmusk,mayemusk';
    eq(x.env().minutes, 10, 'la veille passe toutes les dix minutes par defaut');
    eq(x.env().maxJour, 3, 'et trois propositions par jour par defaut');
    process.env.X_VEILLE_MAX_JOUR = '2';   // l essai ci-dessous compte avec deux
    const T = Date.parse('2026-09-19T12:00:00Z');
    const recent = (min) => new Date(T - min * 60000).toISOString();
    const appels = [];
    let postsElon = [
      { id: '1003', text: 'Optimus can now walk the dog', created_at: recent(10) },
      { id: '1002', text: 'Meeting in Berlin tomorrow', created_at: recent(20) },
      { id: '1001', text: 'Doge is the people\'s crypto', created_at: recent(8 * 60) },
    ];
    let postsMaye = [{ id: '2001', text: 'My shiba puppy says hi', created_at: recent(5) }];
    let pertinent = true;
    const faux = async (url, o) => {
      const u = String(url); const corps = o && o.body ? JSON.parse(o.body) : null;
      appels.push({ u, corps, auth: (o && o.headers && o.headers.authorization) || '' });
      const rep = (statut, j) => ({ ok: statut < 300, status: statut, json: async () => j, text: async () => JSON.stringify(j) });
      if (/users\/by\/username\/elonmusk/.test(u)) return rep(200, { data: { id: '44196397', username: 'elonmusk' } });
      if (/users\/by\/username\/mayemusk/.test(u)) return rep(200, { data: { id: '9000', username: 'mayemusk' } });
      if (/users\/44196397\/tweets/.test(u)) return rep(200, { data: postsElon });
      if (/users\/9000\/tweets/.test(u)) return rep(200, { data: postsMaye });
      if (/anthropic/.test(u)) return rep(200, { content: [{ type: 'text', text: JSON.stringify({ pertinent, raison: pertinent ? 'a dog!' : 'not our place', reponse: 'Walk the dog? He walks YOU. 🐕 https://x.example', scene: 'the buff Shiba walking a small humanoid robot on a leash', confiance: 9 }) }] });
      if (/openai/.test(u)) return rep(200, { data: [{ b64_json: Buffer.from('PNG-factice').toString('base64') }] });
      if (/telegram/.test(u)) return rep(200, { ok: true });
      if (/media\/upload/.test(u)) return rep(200, { data: { id: '777' } });
      if (/2\/tweets/.test(u)) return rep(201, { data: { id: '5555' } });
      throw new Error('url inattendue ' + u);
    };
    let r = await x.veille({ maintenant: T, prendre: faux });
    eq(r.etat, 'veille', 'un tour de veille');
    eq(r.proposees, 2, 'deux propositions : une par compte, le plafond du jour');
    const elon = r.comptes.elonmusk;
    eq(elon.lus, 3, 'trois posts lus chez Elon');
    ok(elon.sautes.some((s) => /1002 : hors sujet/.test(s)), 'Berlin est hors sujet : pas montre au modele');
    ok(elon.sautes.some((s) => /1001 : trop vieux/.test(s)), 'le post de huit heures est trop vieux');
    const lecture = appels.find((a) => /44196397\/tweets/.test(a.u));
    ok(/exclude=retweets%2Creplies/.test(lecture.u) && /max_results=10/.test(lecture.u) && !/since_id/.test(lecture.u), 'premiere lecture : dix posts, sans reposts ni reponses, sans since_id');
    ok(/^OAuth oauth_consumer_key="ck"/.test(lecture.auth), 'signee en OAuth 1.0a');
    eq(appels.filter((a) => /users\/by\/username/.test(a.u)).length, 2, 'les identifiants des deux comptes sont demandes une fois');
    eq(appels.filter((a) => /openai/.test(a.u)).length, 2, 'deux images payees');
    const tg = appels.filter((a) => /telegram/.test(a.u));
    eq(tg.length, 2, 'deux messages Telegram');
    eq(String(tg[0].corps.chat_id), '12345', 'dans le chat PRIVE');
    ok(/poster$/.test(tg[0].corps.reply_markup.inline_keyboard[0][0].url) && /ignorer$/.test(tg[0].corps.reply_markup.inline_keyboard[0][1].url), 'avec les deux boutons Poster et Ignorer');
    ok(/https:\/\/serveur\.test\/x\/image\/rep_1003\.png/.test(tg[0].corps.photo), 'et l image generee pour ce post');
    ok(/Walk the dog\? He walks YOU\. 🐕/.test(tg[0].corps.caption) && !/x\.example/.test(tg[0].corps.caption), 'la reponse proposee, sans le lien que le modele avait glisse');
    ok(/🟢 Confiance de Claude : <b>9\/10<\/b>/.test(tg[0].corps.caption), 'et la note de confiance du modele en tete, en vert a 9');
    const j = x.litJournal();
    eq(j.comptes.elonmusk.id, '44196397', 'l identifiant est garde');
    eq(j.comptes.elonmusk.depuis, '1003', 'et le dernier post lu aussi');

    /* Second tour : since_id, plafond du jour atteint. */
    const avant = appels.length;
    postsElon = [{ id: '1004', text: 'Another dog post', created_at: recent(1) }];
    r = await x.veille({ maintenant: T + 600000, prendre: faux });
    const lecture2 = appels.slice(avant).find((a) => /44196397\/tweets/.test(a.u));
    ok(/since_id=1003/.test(lecture2.u), 'second tour : lecture depuis le dernier post vu');
    eq(appels.slice(avant).filter((a) => /users\/by\/username/.test(a.u)).length, 0, 'sans redemander les identifiants');
    ok(r.comptes.elonmusk.sautes.some((s) => /plafond du jour/.test(s)), 'le plafond du jour bloque la troisieme proposition');
    eq(appels.slice(avant).filter((a) => /anthropic|openai|telegram/.test(a.u)).length, 0, 'et rien n est paye pour elle');

    /* Le lendemain : quatre heures entre deux propositions du meme compte, et « non pertinent » ne coute rien. */
    process.env.X_VEILLE_MAX_JOUR = '5';
    const J2 = T + 86400000;
    const avant2 = appels.length;
    postsElon = [{ id: '1005', text: 'Shiba season', created_at: new Date(J2 - 60000).toISOString() }];
    postsMaye = [{ id: '2002', text: 'Rocket launch tonight', created_at: new Date(J2 - 60000).toISOString() }];
    pertinent = false;
    r = await x.veille({ maintenant: J2, prendre: faux });
    eq(r.proposees, 0, 'le modele dit « non pertinent » pour les deux : aucune proposition');
    eq(appels.slice(avant2).filter((a) => /openai|telegram/.test(a.u)).length, 0, 'ni image ni Telegram payes pour un non pertinent');
    eq(appels.slice(avant2).filter((a) => /anthropic/.test(a.u)).length, 2, 'le modele a ete consulte deux fois');
    pertinent = true;
    postsElon = [{ id: '1006', text: 'Doge again', created_at: new Date(J2 + 600000).toISOString() }];
    r = await x.veille({ maintenant: J2 + 3600000, prendre: faux });
    eq(r.proposees, 1, 'un post pertinent une heure plus tard : proposition (la derniere pour ce compte date de la veille)');
    postsElon = [{ id: '1007', text: 'Doge once more', created_at: new Date(J2 + 7200000).toISOString() }];
    r = await x.veille({ maintenant: J2 + 7200000, prendre: faux });
    ok(r.comptes.elonmusk.sautes.some((s) => /quatre heures/.test(s)), 'deux heures apres : pas de seconde proposition pour le meme compte');

    console.log('\n-- 4. le bouton --');
    const jour = x.litJournal();
    const p = jour.propositions['rep-1003'];
    ok(p && p.jeton && p.etat === 'proposee', 'la proposition attend, avec son jeton');
    const avant3 = appels.length;
    let g = await x.geste('jeton-inconnu-xxxxxxxxxxxx', 'poster', { prendre: faux });
    eq(g.etat, 'inconnu', 'un lien inconnu ne fait rien');
    g = await x.geste(p.jeton, 'poster', { prendre: faux, maintenant: T + 3600000 });
    eq(g.etat, 'postee', 'Poster : la reponse part');
    eq(g.url, 'https://x.com/SwoleDogeSwoge/status/5555', 'avec son lien');
    const tweet = appels.slice(avant3).find((a) => /2\/tweets/.test(a.u));
    eq(tweet.corps.reply.in_reply_to_tweet_id, '1003', 'EN REPONSE au post d origine');
    eq(tweet.corps.media.media_ids.join(','), '777', 'avec l image');
    eq(appels.slice(avant3).filter((a) => /openai/.test(a.u)).length, 0, 'l image n est pas repayee');
    g = await x.geste(p.jeton, 'poster', { prendre: faux, maintenant: T + 3700000 });
    eq(g.etat, 'inconnu', 'le meme lien ne poste pas deux fois : le jeton est consomme');
    const q = x.litJournal().propositions['rep-2001'];
    g = await x.geste(q.jeton, 'ignorer', { prendre: faux, maintenant: T + 3600000 });
    eq(g.etat, 'ignoree', 'Ignorer : rien ne part');
    eq(appels.filter((a) => /2\/tweets/.test(a.u)).length, 1, 'un seul post en tout');
    const e = x.litJournal().propositions['rep-1006'];
    g = await x.geste(e.jeton, 'poster', { prendre: faux, maintenant: J2 + 3600000 + 13 * 3600000 });
    eq(g.etat, 'expiree', 'apres douze heures, le lien est expire : rien ne part');
    const et = x.etat();
    ok(et.actif && et.propositions.length === 3 && !JSON.stringify(et).includes('jeton') && !JSON.stringify(et).includes('"ck"'), '/x/veille montre les propositions, sans jeton ni cle');
  }

  console.log(`\nx_reponse.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('  RATE ' + (e.message || e)); console.log(`x_reponse.test.js : RATES : 1/${n + 1}`); process.exit(1); });
