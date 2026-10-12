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
 * 10. (11/10/2026) Chaque post parle d un produit : le catalogue et ses
 *     preuves, ce qui est faux ou pas vendu, aucun nombre invente, les
 *     reserves, les images par produit, la rotation, les nouveautes (priorite,
 *     deux sorties, fraicheur), les chiffres vivants, le ton, une semaine de
 *     posts contre de faux serveurs, un journal d avant relu. Chaque garde-fou
 *     a ete retire un par un dans le code (34 mutations) : chacune fait tomber
 *     au moins une verification.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VOL = fs.mkdtempSync(path.join(os.tmpdir(), 'xpost-'));
/* Le volume d essai porte une video de 9 Mo (bloc 8) : il etait laisse derriere chaque execution, et le
   11/10/2026 quatre cent trente-sept dossiers xpost-* avaient rempli le disque (ENOSPC au bloc 8). */
const nettoieVol = () => { try { fs.rmSync(VOL, { recursive: true, force: true }); } catch (e) { /* deja parti */ } };
process.env.DATA_DIR = VOL;
for (const k of ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'X_LIEN', 'X_HEURE', 'X_HEURES', 'X_FUSEAU', 'XAI_API_KEY', 'GROK_API_KEY', 'X_ANNONCE', 'XAI_BASE_URL']) delete process.env[k];

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; console.log('  ok   ' + m); };

const x = require('./x_post');
const cfg = require('./config');

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
    /* Le 26 septembre 2026 : quatre creneaux, a l heure du public vise
       (americain), au lieu de douze a l heure de Paris dont la moitie tombait
       la nuit pour lui. */
    eq(x.env().heures.join(','), '09:00,12:30,17:00,20:30', 'par defaut : quatre creneaux aux heures actives');
    eq(x.env().fuseau, 'America/New_York', 'a l heure de New York');
    const NY = x.env().heures;
    eq(x.creneauDu(Date.parse('2026-09-28T13:00:00Z'), NY, 'America/New_York').cle, '2026-09-28#09:00', '9 h a New York en ete = 13 h UTC : le creneau du matin');
    eq(x.creneauDu(Date.parse('2026-12-01T14:00:00Z'), NY, 'America/New_York').cle, '2026-12-01#09:00', 'en hiver, 9 h a New York = 14 h UTC : pas de recalcul a la main');
    eq(x.creneauDu(Date.parse('2026-09-29T00:30:00Z'), NY, 'America/New_York').cle, '2026-09-28#20:30', '20 h 30 a New York tombe le lendemain en UTC : le creneau reste celui du soir, du bon jour');
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
    eq(x.nettoie('"  Big day for the dog!  "', false), 'Big day for the dog!', 'guillemets retires, et $SWOGE n est PLUS force (ca spammait)');
    eq(x.nettoie('Go go go https://evil.example/x $SWOGE', false), 'Go go go $SWOGE', 'un lien que le modele a glisse est retire : il couterait treize fois le prix');
    const long = x.nettoie('word '.repeat(80) + '$SWOGE', false);
    ok(long.length <= 280, 'coupe a 280 caracteres (' + long.length + ')');
    const avec = x.nettoie('To the moon $SWOGE 🚀', true);
    ok(/\nhttps:\/\/swoleeswoge\.dog$/.test(avec) && avec.length <= 280, 'avec X_LIEN, le lien du site est ajoute en derniere ligne');
    ok(x.RESERVE.every((t) => x.nettoie(t, false).length <= 280), 'les phrases de reserve passent les memes regles (le ticker n est plus force)');
    /* La rotation exacte : le cashtag un creneau sur deux, le hashtag un sur trois. */
    const NY = x.env().heures, tags = [];
    for (const d of ['2026-09-27', '2026-09-28', '2026-09-29']) for (const h of NY) tags.push(x.etiquettes(d + '#' + h, NY));
    eq(tags.filter((t) => t.ticker).length, 6, 'sur trois jours (douze posts), $SWOGE six fois — un sur deux');
    eq(tags.filter((t) => t.hashtag).length, 4, 'et #RobinhoodChain quatre fois — un sur trois');
    ok(tags.every((t, i) => i === 0 || t.ticker !== tags[i - 1].ticker), 'jamais deux posts d affilee avec (ou sans) le cashtag');
    eq(x.nettoie('The #dog is #huge $SWOGE on #RobinhoodChain 🚀', false, { ticker: false, hashtag: false }), 'The dog is huge SWOGE on Robinhood Chain 🚀',
       'hors rotation : le signe part, le mot reste, la phrase reste entiere ; aucun autre hashtag');
    eq(x.nettoie('Big dog energy 🐕', false, { ticker: true, hashtag: true }), 'Big dog energy 🐕 $SWOGE #RobinhoodChain', 'dans la rotation : ajoutes si le modele les a oublies');
    eq(x.nettoie('Stack $SWOGE on #RobinhoodChain 🐕', false, { ticker: true, hashtag: true }), 'Stack $SWOGE on #RobinhoodChain 🐕', 'et jamais en double quand il les a mis');
    const faits = x.faitsDuJour(Date.now());
    ok(faits.length >= 5 && faits.some((f) => /SWOGE Bet/.test(f)) && faits.some((f) => /AI agent/.test(f)) && faits.some((f) => /Robinhood Chain/.test(f)), 'les faits du jour parlent du site, de l agent lui-meme, et de Robinhood Chain');
    /* 11/10/2026 : l inventaire a releve quatre phrases FAUSSES dans les faits du jour (paris « paid in $SWOGE »,
       cotes « on-chain », « no signup », un cinema dans le monde, « keys stay on your device », « 13 AI agents »). */
    ok(!faits.some((f) => /paid in \$SWOGE|odds on-chain|no signup|(Nexus|SWOGE World)[^.]*cinema|keys stay on your device|\b13\b|285/i.test(f)),
       'et plus aucune des phrases fausses relevees le 11/10 (paris en $SWOGE, cotes sur la chaine, cinema, cles « sur l appareil », 13 agents)');
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
  /* 03/10 (soir) : l annonce en image n attend plus de cle xAI ; ces tours portent sur les posts
     ORDINAIRES, l annonce est donc coupee ici (elle a ses blocs, 8 et 9). */
  process.env.X_ANNONCE = '0';
  {
    Object.assign(process.env, { X_CONSUMER_KEY: 'ck', X_CONSUMER_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as',
                                 OPENAI_API_KEY: 'ok', ANTHROPIC_API_KEY: 'ak',
                                 /* Ce bloc essaie le TOUR (rattrapage, refus de X, image gardee), pas la
                                    cadence : il garde son horaire a lui, douze creneaux a Paris, pour que
                                    ses heures restent lisibles. La cadence par defaut est essayee en 3. */
                                 X_HEURES: '00:00,02:00,04:00,06:00,08:00,10:00,12:00,14:00,16:00,18:00,20:00,22:00',
                                 X_FUSEAU: 'Europe/Paris' });
    const appels = [];
    let refuseTweet = false; let nTexte = 0;
    /* Le faux modele nomme le produit que la demande lui donne (11/10/2026 : chaque post en nomme un),
       sans chiffre (un chiffre absent des faits ferait poster la reserve) ; un mot par appel pour
       distinguer les textes. Depuis la relecture du 11/10 les nombres en lettres comptent aussi
       (« two » vaut 2) : les mots sont ceux de l alphabet radio. */
    const MOTS = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo'];
    const faux = async (url, o) => {
      const u = String(url); const corps = o && o.body ? JSON.parse(o.body) : null;
      appels.push({ u, corps, auth: (o && o.headers && (o.headers.authorization || o.headers['x-api-key'])) || '' });
      const rep = (statut, j) => ({ ok: statut < 300, status: statut, json: async () => j, text: async () => JSON.stringify(j) });
      /* Le controle des pattes (vision) : avant la branche image, car les deux sont chez openai. */
      if (/chat\/completions/.test(u)) return rep(200, { choices: [{ message: { content: '{"hands": false, "why": "furry dog paws"}' } }] });
      if (/openai/.test(u)) return rep(200, { data: [{ b64_json: Buffer.from('PNG-factice').toString('base64') }], usage: { output_tokens: 6893 } });
      /* Le second regard (seconde relecture du 11/10) : un oui franc, et il ne compte pas comme un texte. */
      if (/anthropic/.test(u) && corps.system === x.SYSTEME_JUGE) return rep(200, { content: [{ type: 'text', text: '{"ok": true, "claim": ""}' }] });
      if (/anthropic/.test(u)) {
        nTexte++;
        const nom = (/PRODUCT: (.+?) \(name it/.exec(corps.messages[0].content) || [])[1] || 'SWOGE';
        return rep(200, { content: [{ type: 'text', text: `"${nom} hits different, call ${MOTS[nTexte]}. $SWOGE energy 🏟️🐕 https://spam.example"` }] });
      }
      if (/media\/upload/.test(u)) return rep(200, { data: { id: '777', media_key: '3_777' } });
      if (/2\/tweets/.test(u)) return refuseTweet ? rep(403, { detail: 'Forbidden' }) : rep(201, { data: { id: String(900 + appels.length), text: corps.text } });
      throw new Error('url inattendue ' + u);
    };
    const MIDI = Date.parse('2026-09-19T10:00:00Z');       // midi a Paris
    /* A 11 h, le creneau en cours est celui de 10 h, jamais parti : le
       serveur le rattrape, c est voulu (un redeploiement a 10 h 30 ne doit pas
       perdre le post de 10 h). Avec les douze creneaux de ce bloc (toutes les
       2 h), 10 h est le dernier horaire passe avant 11 h. */
    let r = await x.tache({ maintenant: MIDI - 3600000, prendre: faux });
    eq(r.etat, 'poste', 'a 11 h, le creneau de 10 h n est pas parti : il part — un creneau manque se rattrape');
    eq(r.cle, '2026-09-19#10:00', 'sous la cle de 10 h');
    const journal10h = x.litJournal();
    ok(journal10h.jours['2026-09-19#10:00'].angle, 'un angle d ecriture est note : ' + journal10h.jours['2026-09-19#10:00'].angle.slice(0, 30));
    ok(journal10h.jours['2026-09-19#10:00'].produit === 'bet' && journal10h.jours['2026-09-19#10:00'].rang === 0 && journal10h.jours['2026-09-19#10:00'].fait === 'carnet',
       'sans journal ni nouveaute du moment, la rotation s ouvre sur SWOGE Bet, rang 0, son premier fait — le tout garde au journal');

    /* Un refus de X a midi : l image doit etre gardee. */
    refuseTweet = true;
    const avantMidi = appels.length;
    r = await x.tache({ maintenant: MIDI + 60000, prendre: faux });
    eq(r.etat, 'rate', 'X refuse a midi : le tour se dit rate');
    eq(r.cle, '2026-09-19#12:00', 'sous la cle de midi');
    ok(/HTTP 403/.test(r.erreur) && /Forbidden/.test(r.erreur), 'et l erreur dit le code et le detail de X : ' + r.erreur);
    ok(fs.existsSync(path.join(x.DOSSIER_IMAGES(), '2026-09-19_12_00.png')), 'l image est sur le volume');
    const demandeTexte = appels.slice(avantMidi).find((a) => /anthropic/.test(a.u)).corps.messages[0].content;
    ok(/Previous posts/.test(demandeTexte) && /call bravo/.test(demandeTexte), 'le modele recoit les posts precedents pour ne pas les repeter');
    ok(/^TONE: /m.test(demandeTexte), 'et le ton du creneau');
    /* ---- CHAQUE POST PARLE D UN PRODUIT (11/10/2026) ----
     * La demande du 18/09 (« pas forcement parler du site, juste faire un tweet bullish ») est
     * remplacee par celle du 11/10 : « qu on parle de ca dans les tweets, a chaque fois ». Aucun
     * angle n interdit plus de nommer : l angle ne choisit que le ton, le sujet est choisi avant. */
    ok(x.ANGLES.every((a) => a.a && a.ton && !/NO PRODUCT|nothing else|no feature/i.test(a.a)),
       'aucun des ' + x.ANGLES.length + ' angles n interdit plus de nommer le produit : ils ne choisissent que le ton');
    ok(/^PRODUCT: SWOGE World \(name it/m.test(demandeTexte) && /^LEAD FACT \(the post is built on this one\): SWOGE World /m.test(demandeTexte)
       && !/NO PRODUCT|Background, do not quote/.test(demandeTexte),
       'le creneau de midi nomme son produit (SWOGE World, apres SWOGE Bet) et son fait vedette ; plus aucun post « pur meme »');
    let d3 = null;
    await x.ecritTexte(['fait A'], { scene: { prompt: 's' }, cle: 'k', angle: x.ANGLES[0].a, sujet: 'une annonce' },
                       async (u, o) => { d3 = JSON.parse(o.body).messages[0].content; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'news $SWOGE 🐕' }] }) }; });
    ok(!/NO PRODUCT|^PRODUCT:/m.test(d3) && /Today.s announcement/.test(d3) && /^Facts:\n- fait A/m.test(d3),
       'un post special parle TOUJOURS de son sujet, avec les faits du jour en garde-fou : c est sa raison d etre');

    refuseTweet = false;
    let signale = null;
    r = await x.tache({ maintenant: MIDI + 600000, prendre: faux, signale: (s) => { signale = s; } });
    eq(r.etat, 'poste', 'au tour suivant, poste');
    eq(appels.filter((a) => /images\/generations/.test(a.u)).length, 2, 'deux images payees en tout : 10 h, midi — pas une de plus pour la reprise');
    eq(appels.filter((a) => /anthropic/.test(a.u) && a.corps.system !== x.SYSTEME_JUGE).length, 2, 'deux textes');
    eq(appels.filter((a) => /anthropic/.test(a.u) && a.corps.system === x.SYSTEME_JUGE).length, 2, 'et deux seconds regards, un par texte ecrit (la reprise de midi reprend le texte deja relu)');
    const j = x.litJournal();
    ok(j.jours['2026-09-19#10:00'].scene !== j.jours['2026-09-19#12:00'].scene, 'deux scenes differentes le meme jour : ' + j.jours['2026-09-19#10:00'].scene + ' puis ' + j.jours['2026-09-19#12:00'].scene);
    ok(j.jours['2026-09-19#10:00'].texte !== j.jours['2026-09-19#12:00'].texte, 'et deux textes differents');
    const media = appels.find((a) => /media\/upload/.test(a.u));
    eq(media.corps.media_category, 'tweet_image', 'le media est declare image de post');
    eq(media.corps.media, Buffer.from('PNG-factice').toString('base64'), 'et porte le PNG en base64');
    ok(/^OAuth oauth_consumer_key="ck", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="at", oauth_version="1.0"$/.test(media.auth),
       'signe en OAuth 1.0a, jeton du compte, nonce neuf');
    const tweet = appels.filter((a) => /2\/tweets/.test(a.u)).pop();
    eq(tweet.corps.media.media_ids.join(','), '777', 'le post attache l identifiant du media');
    /* Le texte du modele, nettoye : guillemets et lien retires. Le ticker suit
       la rotation du creneau de midi (garde ou ramene a « SWOGE ») : on
       compare a ce que la rotation de CE creneau commande. */
    const tg = x.etiquettes('2026-09-19#12:00', x.env().heures);
    const attendu = 'SWOGE World hits different, call charlie. ' + (tg.ticker ? '$SWOGE' : 'SWOGE') + ' energy 🏟️🐕' + (tg.hashtag ? ' #RobinhoodChain' : '');
    eq(tweet.corps.text, attendu, 'le texte est celui du modele, nettoye : guillemets et lien retires, etiquettes selon la rotation');
    ok(signale && signale.id === r.id && signale.url === 'https://x.com/SwoleDogeSwoge/status/' + r.id, 'et le Telegram est prevenu avec le lien du post');

    r = await x.tache({ maintenant: MIDI + 1800000, prendre: faux });
    eq(r.etat, 'deja', 'a 12 h 30, toujours dans le creneau de midi (toutes les 2 h), deja parti : rien');
    const d = x.derniere();
    ok(d.actif && d.derniere && d.derniere.cle === '2026-09-19#12:00' && d.derniere.image === '/x/image/2026-09-19_12_00.png' && d.recents.length === 2 && !JSON.stringify(d).includes('"ck"'),
       '/x/derniere dit le dernier post, son image, les recents, et aucune cle');
    ok(d.derniere.produit === 'world' && d.derniere.nouveaute === null && d.recents.map((r) => r.produit).join(',') === 'world,bet',
       'et, depuis le 11/10, le produit de chaque post (le dernier et les recents)');

    /* Trois refus, et on s arrete ; puis la reprise. */
    refuseTweet = true;
    const MINUIT = Date.parse('2026-09-19T22:00:00Z');
    for (let i = 0; i < 3; i++) r = await x.tache({ maintenant: MINUIT, prendre: faux });
    eq(r.essais, 3, 'trois essais a minuit');
    r = await x.tache({ maintenant: MINUIT, prendre: faux });
    eq(r.etat, 'abandon', 'au quatrieme, on abandonne le creneau en le disant');
    refuseTweet = false;
    const imagesAvant = appels.filter((a) => /images\/generations/.test(a.u)).length;
    eq(x.reprend(), 1, 'reprendre remet a zero le creneau rate');
    r = await x.tache({ maintenant: MINUIT + 60000, prendre: faux });
    eq(r.etat, 'poste', 'et le post part sans attendre le creneau suivant');
    eq(appels.filter((a) => /images\/generations/.test(a.u)).length, imagesAvant, 'avec l image deja payee');
    eq(x.reprend(), 0, 'plus rien a reprendre');

    /* Un post special : sujet impose, image a lui, hors creneau. */
    const avantSpecial = appels.length;
    r = await x.tache({ maintenant: MINUIT + 120000, prendre: faux,
                        special: { nom: 'agent', sujet: 'An AI agent now writes, illustrates and posts here on its own', prompt: 'at a desk with a robot painter' } });
    eq(r.etat, 'poste', 'un post special part meme quand le creneau est deja servi');
    eq(r.cle, '2026-09-19#agent', 'sous sa propre cle');
    ok(/Today's announcement.*AI agent now writes/.test(appels.slice(avantSpecial).find((a) => /anthropic/.test(a.u)).corps.messages[0].content), 'le modele recoit le sujet impose');
    ok(/at a desk with a robot painter/.test(appels.slice(avantSpecial).find((a) => /images\/generations/.test(a.u)).corps.prompt), 'et l image, sa scene a elle');
    r = await x.tache({ maintenant: MINUIT + 180000, prendre: faux, special: { nom: 'agent', sujet: 'encore' } });
    eq(r.etat, 'deja', 'le meme post special ne part pas deux fois le meme jour');
    r = await x.tache({ maintenant: MINUIT + 180000, prendre: faux, special: { nom: 'sans-sujet' } });
    eq(r.etat, 'refuse', 'et sans sujet, refuse');

    /* ---- Les posts PROGRAMMES (27 septembre 2026) : texte impose, heure fixe, une fois ---- */
    const P = { nom: 'essai-prog', a: Date.parse('2026-09-19T22:55:00Z'), lien: 'https://swoleeswoge.dog/swogeagentic.html', sujet: 'x402 on PayAI',
      texte: 'Line one 🤖\n\nLine two.\n\nLine three $SWOGE', prompt: 'at an API shop counter with robots' };
    const avantProg = appels.length;
    let rp = await x.programmes({ maintenant: P.a - 60000, prendre: faux, liste: [P] });
    eq(rp.length, 0, 'avant son heure : rien');
    rp = await x.programmes({ maintenant: P.a + 60000, prendre: faux, liste: [P] });
    const tweetProg = appels.slice(avantProg).find((a) => /2\/tweets/.test(a.u));
    eq(rp[0] && rp[0].etat, 'poste', 'a son heure : poste');
    eq(tweetProg.corps.text, 'Line one 🤖\n\nLine two.\n\nLine three $SWOGE\n\nhttps://swoleeswoge.dog/swogeagentic.html', 'le texte IMPOSE part mot pour mot, paragraphes gardes, lien a la fin');
    ok(!appels.slice(avantProg).some((a) => /anthropic/.test(a.u)), 'aucun modele n ecrit (le texte est impose)');
    /* 12/10 : ce qui PART chez X ne porte qu un cashtag, meme si le texte impose en a deux (403 de X sinon). */
    const P2 = Object.assign({}, P, { nom: 'essai-cashtag', a: P.a + 600000, texte: 'Two tags $SWOGE and $SWOGE' });
    const avantC = appels.length;
    await x.programmes({ maintenant: P2.a + 60000, prendre: faux, liste: [P2] });
    const twC = appels.slice(avantC).find((a) => /2\/tweets/.test(a.u));
    eq(twC && twC.corps.text, 'Two tags $SWOGE and SWOGE\n\nhttps://swoleeswoge.dog/swogeagentic.html', 'le texte envoye a X porte un seul cashtag (publie le garde)');
    ok(/at an API shop counter with robots/.test(appels.slice(avantProg).find((a) => /images\/generations/.test(a.u)).corps.prompt), 'l image : sa scene a lui');
    const nTweets = appels.filter((a) => /2\/tweets/.test(a.u)).length;
    await x.programmes({ maintenant: P.a + 4 * 3600e3 * 0.4, prendre: faux, liste: [P] });
    await x.programmes({ maintenant: Date.parse('2026-09-20T00:10:00Z'), prendre: faux, liste: [P] });
    eq(appels.filter((a) => /2\/tweets/.test(a.u)).length, nTweets, 'plus tard, et apres minuit : jamais reposte (la cle suit SON heure)');
    const Q = Object.assign({}, P, { nom: 'essai-tard', a: Date.parse('2026-09-19T12:00:00Z') });
    const avantTard = appels.length;
    await x.programmes({ maintenant: Q.a + x.PROGRAMME_RETARD_MS + 60000, prendre: faux, liste: [Q] });
    ok(!appels.slice(avantTard).length && x.litJournal().jours['2026-09-19#essai-tard'].abandonne, 'plus de 2 h en retard (serveur arrete) : abandonne, rien poste, rien paye');
    const reel = x.PROGRAMMES.find((p) => p.nom === 'x402-payai');
    ok(reel && reel.texte.length + reel.lien.length + 2 <= 280 && /PayAI x402/.test(reel.texte) && /Base or Solana/.test(reel.texte) && /15 tools/.test(reel.texte),
       'le vrai post x402/PayAI : ' + (reel.texte.length + reel.lien.length + 2) + ' caracteres avec le lien (<= 280), les faits verifies (15 outils, Base ou Solana)');
    /* 08/10 : le casino en $SWOGEBET. Part tel quel (paragraphes + lien) seulement s il tient ; les libelles sont ceux
     * du selecteur (coffre.js) ; le Boulier, le Pusher, le jackpot et le classement restent $SWOGE : jamais cites. */
    const cs = x.PROGRAMMES.find((p) => p.nom === 'casino-swogebet');
    ok(cs && cs.texte.length + cs.lien.length + 2 <= 280 && /Stake from: Bet \$SWOGEBET/.test(cs.texte) && /same token/.test(cs.texte)
         && /SWOGE World/.test(cs.texte) && !/boulier|pusher|jackpot|leaderboard/i.test(cs.texte + cs.sujet) && /\/games\.html$/.test(cs.lien),
       'le post casino $SWOGEBET : ' + (cs && cs.texte.length + cs.lien.length + 2) + ' caracteres avec le lien (<= 280), libelles du selecteur, rien sur les cagnottes $SWOGE');
    const heureNY = cs && new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(cs.a);
    ok(heureNY > '12:30' && heureNY < '17:00', 'le post casino tombe seul entre les creneaux de 12:30 et 17:00 ET (' + heureNY + ')');
    /* 11/10 : le « hidden gem ». Il vante le jeton : aucun chiffre (cap, hausse, cible), aucune promesse de rendement,
     * aucun lien (0,015 $) ; les produits cites sont ceux de PRODUITS ; seul entre deux creneaux. */
    const hg = x.PROGRAMMES.find((p) => p.nom === 'hidden-gem');
    const heureHG = hg && new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(hg.a);
    ok(hg && !hg.lien && hg.texte.length <= 280 && !/https?:|\.(dog|com|io)\b/i.test(hg.texte) && !/\d/.test(hg.texte)
         && !/\b(x\d|moon|pump|guarantee|profit|returns?|price target|buy now|nfa|ape)\b/i.test(hg.texte + ' ' + hg.sujet)
         && /\$SWOGE/.test(hg.texte) && /sportsbook/.test(hg.texte) && /casino/.test(hg.texte) && /SWOGE World/.test(hg.texte)
         && ['bet', 'casino', 'world', 'wallet', 'ai'].every((c) => x.PRODUITS.some((p) => p.cle === c))
         && heureHG > '12:30' && heureHG < '17:00',
       'le post « hidden gem » : ' + (hg && hg.texte.length) + ' caracteres sans lien, aucun chiffre ni promesse de rendement, produits de PRODUITS, seul a ' + heureHG + ' ET');
    /* 12/10 : l annonce du CTO, piece jointe du ticket Etherscan. Elle part TELLE QUELLE (paragraphes et adresse
     * intacts) seulement si elle tient avec le lien ; l adresse est celle du jeton configure, au caractere pres ;
     * la date du renoncement est celle de la tx 0xdd81…2fe8 (07/07/2026) ; aucun cours, aucune promesse. */
    const cto = x.PROGRAMMES.find((p) => p.nom === 'cto-officiel-2');
    const adresses = cto ? (cto.texte.match(/0x[0-9a-fA-F]{40}/g) || []) : [];
    const heureCTO = cto && new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(cto.a);
    ok(cto && cto.texte.length + cto.lien.length + 2 <= 280 && cto.lien === 'https://swoleeswoge.dog'
         && adresses.length === 1 && adresses[0] === require('./config').SWOGE_TOKEN
         && /community takeover \(CTO\)/.test(cto.texte) && /renounced ownership on July 7, 2026/.test(cto.texte) && /For 90\+ days/.test(cto.texte)
         && !/\b(x\d|moon|pump|guarantee|profit|returns?|price target|buy now|nfa|ape)\b/i.test(cto.texte + ' ' + cto.sujet)
         && heureCTO > '12:30' && heureCTO < '17:00',
       'l annonce CTO : ' + (cto && cto.texte.length + cto.lien.length + 2) + ' caracteres avec le lien (<= 280), l adresse du jeton configure, renoncement du 07/07, seule a ' + heureCTO + ' ET');
    /* 12/10 : X refuse plus d un cashtag (HTTP 403 trois fois sur la premiere annonce CTO, $SWOGE
     * deux fois). Intention : aucun texte impose ne porte deux cashtags, et rien ne part avec deux. */
    const cashtags = (t) => (String(t).match(/\$[A-Za-z]{1,6}\b/g) || []).length;
    ok(x.PROGRAMMES.filter((p) => p.a > Date.parse('2026-10-12T17:00:00Z')).every((p) => cashtags(p.texte) <= 1) && cashtags(cto.texte) === 1,
       'les posts programmes a venir portent au plus UN cashtag (l annonce CTO : exactement $SWOGE)');
    eq(x.unSeulCashtag('$SWOGE is live. Buy $SWOGE, not $ETH.'), '$SWOGE is live. Buy SWOGE, not ETH.', 'au-dela du premier, un cashtag perd son « $ » et la phrase reste entiere');
    eq(x.unSeulCashtag('Your $SWOGEBET and $SWOGEBET again, $0.21 per image'), 'Your $SWOGEBET and $SWOGEBET again, $0.21 per image', 'un symbole de plus de 6 lettres ou un montant n est pas un cashtag : intact');
    const cles = x.PROGRAMMES.map((p) => new Date(p.a).toISOString().slice(0, 10) + '#' + p.nom.slice(0, 24));
    ok(new Set(cles).size === cles.length, 'chaque post programme a sa propre cle de journal (' + cles.length + ')');
  }

  delete process.env.X_ANNONCE;
  console.log('\n-- 7. jamais la meme image (27 septembre 2026) --');
  {
    /* « J ai deja vu plusieurs fois des images similaires » : le debardeur bleu
       etait sur chaque image, et une scene revenait en un jour et demi. */
    ok(!/royal blue tank top/.test(x.promptImage(x.SCENES[0], 'k')) && /never a plain blue tank top/.test(x.promptImage(x.SCENES[0], 'k')),
       'le personnage garde son corps, pas un debardeur bleu impose');
    const journal = { jours: {}, annonces: {} };
    const hist = []; let viol = { scene: 0, rendu: 0, cadrage: 0, trio: 0 }; const trios = new Set();
    for (let i = 0; i < 240; i++) {
      const cle = '2026-11-' + String(1 + Math.floor(i / 4)).padStart(2, '0') + '#' + ['09:00', '12:30', '17:00', '20:30'][i % 4];
      const sc = x.sceneSuivante(cle, journal);
      const ch = x.choixImage(cle, sc, journal);
      if (hist.slice(-x.FENETRE_SCENES).some((h) => h.scene === sc.nom)) viol.scene++;
      if (hist.slice(-x.FENETRE_RENDUS).some((h) => h.rendu === ch.rendu)) viol.rendu++;
      if (hist.slice(-x.FENETRE_CADRAGE).some((h) => h.cadrage === ch.cadrage)) viol.cadrage++;
      const tr = sc.nom + '|' + ch.rendu + '|' + ch.cadrage; if (trios.has(tr)) viol.trio++; trios.add(tr);
      hist.push({ scene: sc.nom, rendu: ch.rendu, cadrage: ch.cadrage });
      journal.jours[cle] = { scene: sc.nom, rendu: ch.rendu, cadrage: ch.cadrage, id: String(i), quand: new Date(Date.UTC(2026, 10, 1) + i * 21600000).toISOString() };
    }
    eq(viol.scene, 0, 'sur 240 posts (deux mois a quatre par jour), jamais une des ' + x.FENETRE_SCENES + ' dernieres scenes');
    eq(viol.rendu, 0, 'jamais un des ' + x.FENETRE_RENDUS + ' derniers rendus');
    eq(viol.cadrage, 0, 'jamais un des ' + x.FENETRE_CADRAGE + ' derniers cadrages');
    eq(viol.trio, 0, 'et jamais deux fois le meme trio scene + rendu + cadrage');
    const a = x.choixImage('meme#cle', x.SCENES[0], journal), b = x.choixImage('meme#cle', x.SCENES[0], journal);
    ok(a.rendu === b.rendu && a.cadrage === b.cadrage, 'une reprise du meme creneau refait la meme image (rien paye deux fois pour rien)');
  }

  console.log('\n-- 8. une annonce en video, une fois --');
  {
    fs.readdirSync(VOL).forEach((f) => { if (f === 'x_posts.json') fs.unlinkSync(path.join(VOL, f)); });
    process.env.XAI_API_KEY = 'xai-test';
    process.env.X_HEURES = '09:00,12:30,17:00,20:30'; process.env.X_FUSEAU = 'America/New_York';
    /* 03/10 (soir) : l annonce courante est une IMAGE (le design du portefeuille, bloc 9). Le chemin
       video reste, et se joue ici avec l annonce du launchpad, partie le 03/10 a 09:00. */
    const VIDEO = { nom: 'launchpad-essai', duree: 6, lien: 'https://swoleeswoge.dog/launchpad.html', scene: 'in a short video announcing that anyone can launch their own token with SWOGE',
      sujet: 'Anyone can now launch their own token on Robinhood Chain with SWOGE, on the SWOGE FUN launchpad or by asking SwoleMind.',
      reserve: 'Launch your own token on Robinhood Chain 🚀 Use the SWOGE FUN launchpad, or just tell SwoleMind. $SWOGE',
      prompt: 'Cinematic 6-second shot. The famous buff Doge meme character: a Shiba Inu head on an extremely muscular bodybuilder body, furry dog paws with paw pads, never human hands or fingers. No text, no letters, no numbers, no logos, no watermark.' };
    const MP4 = Buffer.alloc(9 * 1024 * 1024, 7);          // 9 Mo : trois morceaux de 4 Mo
    const appels = []; let statuts = 0; let videoRate = false;
    const faux = async (url, o) => {
      const u = String(url); let corps = null; try { corps = o && o.body ? JSON.parse(o.body) : null; } catch (e) {}
      appels.push({ u, corps, methode: (o && o.method) || 'GET', auth: (o && o.headers && (o.headers.authorization || o.headers['x-api-key'])) || '' });
      const rep = (statut, j) => ({ ok: statut < 300, status: statut, json: async () => j, text: async () => JSON.stringify(j), arrayBuffer: async () => MP4 });
      if (/api\.x\.ai\/v1\/videos\/generations/.test(u)) return videoRate ? rep(500, { error: { message: 'down' } }) : rep(200, { request_id: 'vid-1' });
      if (/api\.x\.ai\/v1\/videos\/vid-1/.test(u)) return rep(200, { status: 'done', video: { url: 'https://vidgen.x.ai/vid-1.mp4', duration: 6 }, usage: { cost_in_usd_ticks: 4.8e9 } });
      if (/vidgen\.x\.ai/.test(u)) return rep(200, {});
      if (/openai/.test(u)) return rep(200, { data: [{ b64_json: Buffer.from('PNG').toString('base64') }] });
      if (/anthropic/.test(u)) return rep(200, { content: [{ type: 'text', text: 'SwoleMind just dropped 🧠💪 Claude, ChatGPT and Grok in one app, plus videos with the same characters every scene. $SWOGE' }] });
      if (/media\/upload\/initialize/.test(u)) return rep(200, { data: { id: 'v99', media_key: '7_v99' } });
      if (/media\/upload\/v99\/append/.test(u)) return rep(200, { data: { expires_at: 1 } });
      if (/media\/upload\/v99\/finalize/.test(u)) return rep(200, { data: { id: 'v99', processing_info: { state: 'pending', check_after_secs: 1 } } });
      if (/media\/upload\?command=STATUS/.test(u)) { statuts++; return rep(200, { data: { id: 'v99', processing_info: { state: statuts < 2 ? 'in_progress' : 'succeeded' } } }); }
      if (/media\/upload$/.test(u)) return rep(200, { data: { id: 'img1' } });
      if (/2\/tweets/.test(u)) return rep(201, { data: { id: String(5000 + appels.length) } });
      throw new Error('url inattendue ' + u);
    };
    const pause = async () => {};
    const T1 = Date.parse('2026-10-01T13:05:00Z');          // 09:05 a New York
    let r = await x.tache({ maintenant: T1, prendre: faux, pause, annonce: VIDEO });
    eq(r.etat, 'poste', 'le prochain creneau part');
    eq(r.annonce, VIDEO.nom, 'et c est l annonce en attente (' + VIDEO.nom + ')');
    const gen = appels.find((a) => /videos\/generations/.test(a.u));
    ok(gen && gen.corps.duration === 6 && gen.corps.model === 'grok-imagine-video-1.5' && /buff Doge/.test(gen.corps.prompt) && /No text/.test(gen.corps.prompt),
       'une video Grok Imagine de 6 s, le SWOGE musclé, sans texte a l image');
    const init = appels.find((a) => /initialize/.test(a.u));
    ok(init && init.corps.media_type === 'video/mp4' && init.corps.total_bytes === MP4.length && init.corps.media_category === 'tweet_video', 'X initialize : video/mp4, taille exacte, tweet_video');
    const ap = appels.filter((a) => /append/.test(a.u));
    ok(ap.length === 3 && ap.map((a) => a.corps.segment_index).join() === '0,1,2' && Buffer.from(ap[0].corps.media, 'base64').length === 4 * 1024 * 1024,
       'trois morceaux de 4 Mo, numerotes 0, 1, 2');
    const st = appels.filter((a) => /command=STATUS/.test(a.u));
    ok(st.length === 2 && st.every((a) => a.methode === 'GET' && /oauth_signature=/.test(a.auth) && /media_id=v99/.test(a.u)), 'le traitement est suivi (STATUS, GET signe) jusqu a « succeeded »');
    const tw = appels.filter((a) => /2\/tweets/.test(a.u)).pop();
    ok(tw.corps.media.media_ids[0] === 'v99' && tw.corps.text.includes(VIDEO.lien) && tw.corps.text.length <= 280, 'le tweet porte la video et le lien de l annonce');
    /* 03/10 : « pour les prochaines images et videos, faut que SWOGE ait des pattes de chien ».
       Chaque description de SWOGE, dans chaque module qui en fabrique, le dit. */
    {
      const fs2 = require('fs'), path2 = require('path');
      const sans = ['annonces.js', 'kling_telegram.js', 'studio_comprend.js', 'studio_production.js', 'x_post.js'].filter((f) => {
        const t = fs2.readFileSync(path2.join(__dirname, f), 'utf8');
        const descr = t.match(/bodybuilder[^'"\n]{0,400}/g) || [];
        return !descr.length || !descr.every((d) => /paw pads/.test(d));
      });
      ok(sans.length === 0, 'SWOGE a des pattes de chien (coussinets, jamais de mains ni de doigts) dans chaque description' + (sans.length ? ' — manque : ' + sans.join(', ') : ''));
    }
    const consigneAnnonce = appels.find((a) => /anthropic/.test(a.u)).corps.messages[0].content;
    ok(/Today's announcement/.test(consigneAnnonce) && consigneAnnonce.includes(VIDEO.sujet.slice(0, 40)), 'le texte est ecrit sur le sujet de l annonce');

    const j1 = x.litJournal();
    ok(j1.annonces[VIDEO.nom] && j1.annonces[VIDEO.nom].id, 'le journal retient l annonce partie');
    ok(!appels.some((a) => /images\/generations/.test(a.u)), 'aucune image payee pour ce creneau');
    const nVid = appels.filter((a) => /videos\/generations/.test(a.u)).length;
    r = await x.tache({ maintenant: Date.parse('2026-10-01T16:35:00Z'), prendre: faux, pause, annonce: VIDEO });   // 12:35
    ok(r.etat === 'poste' && !r.annonce, 'le creneau suivant redevient un post normal');
    ok(appels.filter((a) => /videos\/generations/.test(a.u)).length === nVid && appels.some((a) => /images\/generations/.test(a.u)), 'avec une image, et plus aucune video');
    /* Une annonce qui rate trois fois : abandonnee, le creneau d apres est normal. */
    fs.unlinkSync(path.join(VOL, 'x_posts.json'));
    videoRate = true;
    const T2 = Date.parse('2026-10-02T13:05:00Z');
    for (let i = 0; i < 3; i++) r = await x.tache({ maintenant: T2, prendre: faux, pause, annonce: VIDEO });
    ok(r.etat === 'rate' && x.litJournal().annonces[VIDEO.nom].abandon === true, 'trois echecs de la video : l annonce est abandonnee (jamais une boucle de videos payees)');
    videoRate = false;
    r = await x.tache({ maintenant: Date.parse('2026-10-02T16:35:00Z'), prendre: faux, pause, annonce: VIDEO });
    ok(r.etat === 'poste' && !r.annonce, 'et le creneau suivant part normalement');
    process.env.X_ANNONCE = '0'; fs.unlinkSync(path.join(VOL, 'x_posts.json'));
    ok(!x.annonceEnAttente(x.litJournal(), VIDEO) && !x.annonceEnAttente(x.litJournal()), 'X_ANNONCE=0 l eteint');
    delete process.env.X_ANNONCE; delete process.env.XAI_API_KEY;
    ok(!x.annonceEnAttente(x.litJournal(), VIDEO), 'et sans cle xAI, pas d annonce video (le post reste une image)');
  }

  console.log('\n-- 9. l annonce du nouveau design du portefeuille, en IMAGE (03/10) --');
  {
    /* « Sur l un des prochains tweets, poste le nouveau design de SWOGE wallet. » Une video inventee
       ne montrerait pas le vrai design : l image est une capture de la page, dans le depot. */
    fs.readdirSync(VOL).forEach((f) => { if (f === 'x_posts.json') fs.unlinkSync(path.join(VOL, f)); });
    const A = x.ANNONCE, PNG = fs.readFileSync(path.join(__dirname, A.image));
    ok(A.nom === 'wallet-design' && A.lien === 'https://swoleeswoge.dog/swoge_wallet.html' && !A.prompt, 'l annonce courante : le design du portefeuille, son lien, aucune video a generer');
    ok(PNG.slice(1, 4).toString() === 'PNG' && PNG.readUInt32BE(16) === 2400 && PNG.readUInt32BE(20) === 1350 && PNG.length < 5 * 1024 * 1024,
       'l image est un vrai PNG 2400 x 1350 (16:9), sous la limite de 5 Mo de X (' + Math.round(PNG.length / 1024) + ' Ko)');
    ok(A.reserve.length + A.lien.length + 2 <= 280 && /Wallet/.test(A.reserve) && !/\$[0-9]/.test(A.reserve), 'le texte de secours tient avec son lien, et ne cite aucun prix (il changera)');
    ok(x.annonceEnAttente(x.litJournal()), 'sans cle xAI, l annonce en image reste en attente : elle n en a pas besoin');
    const appels = [];
    const faux = async (url, o) => {
      const u = String(url); let corps = null; try { corps = o && o.body ? JSON.parse(o.body) : null; } catch (e) {}
      appels.push({ u, corps });
      const rep = (statut, j) => ({ ok: statut < 300, status: statut, json: async () => j, text: async () => JSON.stringify(j) });
      if (/anthropic/.test(u)) return rep(200, { content: [{ type: 'text', text: 'The new SWOGE Wallet is here 🐾 Swap, bridge and play from one place. $SWOGE' }] });
      if (/media\/upload$/.test(u)) return rep(200, { data: { id: 'img7' } });
      if (/2\/tweets/.test(u)) return rep(201, { data: { id: '7777' } });
      throw new Error('url inattendue ' + u);
    };
    let r = await x.tache({ maintenant: Date.parse('2026-10-04T13:05:00Z'), prendre: faux, pause: async () => {} });
    ok(r.etat === 'poste' && r.annonce === 'wallet-design', 'le prochain creneau poste l annonce du portefeuille');
    const up = appels.find((a) => /media\/upload$/.test(a.u));
    ok(up && up.corps.media_category === 'tweet_image' && Buffer.from(up.corps.media, 'base64').equals(PNG), 'l image televersee est EXACTEMENT la capture du depot');
    ok(!appels.some((a) => /videos\/generations|openai|x\.ai/.test(a.u)), 'rien de genere, rien de paye (ni video, ni image)');
    const tw = appels.find((a) => /2\/tweets/.test(a.u));
    ok(tw.corps.media.media_ids[0] === 'img7' && tw.corps.text.includes(A.lien) && tw.corps.text.length <= 280, 'le tweet porte la capture et le lien du portefeuille');
    r = await x.tache({ maintenant: Date.parse('2026-10-04T16:35:00Z'), prendre: faux, pause: async () => {} });
    ok(!r.annonce, 'une seule fois : le creneau suivant n est plus l annonce');
  }

  console.log('\n-- 9. le controle des pattes : pas de mains humaines sur SWOGE --');
  {
    process.env.OPENAI_API_KEY = 'sk-test';
    const vision = (verdict) => async (u) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(verdict) } }] }) });
    let r = await x.verifiePattes(Buffer.from('PNG'), vision({ hands: false, why: 'furry paws' }));
    ok(r.ok === true && !r.raison, 'des pattes : l image passe');
    r = await x.verifiePattes(Buffer.from('PNG'), vision({ hands: true, why: 'five fingers' }));
    ok(r.ok === false && /finger/.test(r.raison), 'des mains humaines : l image est refusee, avec la raison');

    process.env.X_PATTES = '0';
    r = await x.verifiePattes(Buffer.from('PNG'), vision({ hands: true }));
    ok(r.ok === true && r.saute === 'desactive', 'X_PATTES=0 : le controle est eteint, l image passe');
    delete process.env.X_PATTES;

    /* Une panne du controleur ne doit pas eteindre toute la file : on laisse passer, on le dit. */
    r = await x.verifiePattes(Buffer.from('PNG'), async () => { throw new Error('reseau'); });
    ok(r.ok === true && /injoignable/.test(r.saute), 'controleur injoignable : on laisse passer (pas de blocage), et on le note');

    /* genereImageVerifiee : regenere apres un refus, et renforce le prompt. */
    let nGen = 0; const prompts = [];
    const fauxGV = async (u, o) => {
      const c = o && o.body ? JSON.parse(o.body) : null;
      if (/chat\/completions/.test(String(u))) {
        /* le premier rendu a des mains, le second non */
        const mains = nGen <= 1;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ hands: mains, why: mains ? 'hands' : 'paws' }) } }] }) };
      }
      nGen++; prompts.push(c.prompt);
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('PNG' + nGen).toString('base64') }], usage: { output_tokens: 10 } }) };
    };
    const g = await x.genereImageVerifiee('a buff shiba', fauxGV, 2);
    ok(nGen === 2 && g.controle === 'pattes ok', 'une image a mains est regeneree une fois, la seconde passe');
    ok(/MUST have furry dog paws/.test(prompts[1]), 'le second essai renforce le prompt sur les pattes');

    /* Deux echecs de suite : on LEVE, le creneau abandonnera plutot que de poster des mains. */
    const toujoursMains = async (u) => /chat\/completions/.test(String(u))
      ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"hands":true,"why":"hands"}' } }] }) }
      : { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('PNG').toString('base64') }] }) };
    let leve = false;
    try { await x.genereImageVerifiee('x', toujoursMains, 2); } catch (e) { leve = /mains humaines/.test(e.message); }
    ok(leve, 'deux refus de suite : on leve, aucune image a mains n est postee');
    delete process.env.OPENAI_API_KEY;
  }

  /* ======================================================================
   * 10. CHAQUE POST PARLE D UN PRODUIT (demande du 11/10/2026)
   * « Que ca soit concentre sur les nouvelles mises a jour qu on fait et sur
   * les produits qu on a exactement [...] le betting, le SWOGE World, le
   * casino, etc. [...] qu on parle de ca dans les tweets, a chaque fois. »
   * Un tweet est public : ce bloc tient chaque garde-fou par une verification
   * qui tombe si on le retire.
   * ==================================================================== */
  console.log('\n-- 10. chaque post parle d un produit (11/10/2026) --');
  const H4 = ['09:00', '12:30', '17:00', '20:30'];
  const instantDe = (jour, h) => Date.parse(jour + 'T' + h + ':00-04:00') + 60000;      /* octobre a New York : UTC-4 */
  const jourPlus = (debut, d) => new Date(Date.parse(debut + 'T12:00:00Z') + d * 864e5).toISOString().slice(0, 10);
  /* Une suite de creneaux choisis par choixSujet, chacun « poste » dans un journal en memoire. */
  const simule = (debut, jours, opt) => {
    const j = { jours: {}, annonces: {} }; const l = [];
    for (let d = 0; d < jours; d++) for (const h of H4) {
      const jour = jourPlus(debut, d), cle = jour + '#' + h, t = instantDe(jour, h);
      const c = x.choixSujet(cle, j, t, Object.assign({ vivant: x.instantane(null, t) }, opt || {}));
      j.jours[cle] = Object.assign({ id: String(l.length + 1), quand: new Date(t).toISOString() }, c);
      l.push(Object.assign({ cle, t }, c));
    }
    return l;
  };
  const P = (cle) => x.produitDe(cle);
  {
    console.log('   10a. le catalogue');
    eq(x.PRODUITS.map((p) => p.cle).join(','), 'bet,world,casino,wallet,ai,cinema', 'six produits, les trois que le proprietaire nomme en tete : paris, SWOGE World, casino');
    eq(x.PRODUITS.slice(0, 3).map((p) => p.nom).join(' | '), 'SWOGE Bet | SWOGE World | the SWOGE casino', 'sous leur nom public (« SWOGE Bet », jamais « $SWOGE Bet »)');
    const PREUVE = /[\w./-]+\.(js|html|json|md|sol|txt|mp4):\d+|\b[0-9a-f]{7}\b/;
    const faits = [].concat(...x.PRODUITS.map((p) => p.faits.map((f) => ({ p, f }))));
    const sansPreuve = faits.filter(({ f }) => !PREUVE.test(f.preuve || '') || f.verifie !== '2026-10-11');
    ok(faits.length >= 100 && sansPreuve.length === 0,
       faits.length + ' faits, chacun avec sa preuve (fichier:ligne ou commit) et la date de sa relecture, le 11/10' + (sansPreuve.length ? ' — sans : ' + sansPreuve.map(({ p, f }) => p.cle + '/' + f.id).join(', ') : ''));
    ok(x.PRODUITS.every((p) => new Set(p.faits.map((f) => f.id)).size === p.faits.length && p.faits.length >= 10), 'au moins dix faits par produit, chacun a son identifiant (la rotation des faits le garde)');
    const muets = faits.filter(({ p, f }) => !p.motsCles.test(f.texte));
    ok(muets.length === 0, 'chaque fait nomme son produit : le fait vedette donne au modele porte deja le nom' + (muets.length ? ' — ' + muets.map(({ f }) => f.id).join(', ') : ''));
    const N = x.NOUVEAUTES;
    const malFaites = N.filter((v) => !P(v.produit) || !PREUVE.test(v.preuve || '') || v.verifie !== '2026-10-11' || !/^2026-\d\d-\d\d$/.test(v.date)
      || v.date > '2026-10-11' || v.texte.length > 208 || !P(v.produit).motsCles.test(v.texte));
    ok(N.length >= 10 && malFaites.length === 0 && new Set(N.map((v) => v.id)).size === N.length,
       N.length + ' nouveautes datees, chacune avec sa preuve, 208 signes au plus, qui nomme son produit' + (malFaites.length ? ' — ' + malFaites.map((v) => v.id).join(', ') : ''));
    eq(N.filter((v) => /Stake from: Bet \$SWOGEBET/.test(v.texte)).length, 1, 'le casino en $SWOGEBET (trois fois dans l inventaire) n y est qu une fois');
    ok(N.find((v) => v.id === 'casino-swogebet').deja.join() === '2026-10-08T19:00:00Z', 'et sa premiere sortie est le post programme du 08/10 : il ne revient qu en rappel');
    /* Relecture du 11/10 : les autres sorties faites hors rotation, par les PROGRAMMES. */
    const programme = (nom) => new Date(x.PROGRAMMES.find((p) => p.nom === nom).a).toISOString().replace('.000Z', 'Z');
    ok(['lp-agent', 'lp-tableau'].every((id) => N.find((v) => v.id === id).deja.join() === [programme('agents-48h'), programme('agent-explique')].join())
       && N.find((v) => v.id === 'ai-x402').deja.join() === programme('x402-payai'),
       'l agent par jeton (agents-48h, agent-explique, 05/10) et x402 (x402-payai, 27/09) comptent leurs sorties programmees : pas de « NEW UPDATE » une seconde fois');

    /* Les chiffres ecrits en dur, relies au code qui les porte (relecture du 11/10 : changer monde.js
       ou personnages.js rendait le tweet faux sans qu aucun essai tombe). */
    {
      const monde = require('./monde'), persos = require('./personnages'), skins = require('./skins');
      const F = (c, id) => P(c).faits.find((f) => f.id === id).texte;
      const errants = new Set([].concat(...Object.values(monde.PEUPLEMENT).map((z) => z.especes || []))).size;
      const nb = (s) => x.nombres(s);
      const liens = [
        ['monstres', nb(F('world', 'monstres')).join() === [Object.keys(monde.MONSTRES).length, errants].join()],
        ['portail', F('world', 'portail').includes('open ' + monde.PORTAIL.duree + ' seconds')],
        ['niveau', F('world', 'niveau').includes('up to ' + persos.NIVEAU_MAX + '.')],
        ['persos', nb(F('world', 'persos')).sort().join() === [String(persos.STATS.length), String(skins.SKINS.length)].sort().join()
          && persos.STATS.every((k) => F('world', 'persos').includes(k.toUpperCase()))],
        ['oeufs', F('world', 'oeufs').includes('1 in every ' + Math.round(1 / monde.OEUF.chance).toLocaleString('en-US')) && nb(F('world', 'oeufs')).includes(String(monde.OEUFS.length))],
        ['familiers-niveau', F('world', 'familiers-niveau').includes('up to ' + monde.FAMILIERS.niveauMax + '.') && monde.FAMILIERS.parMinute.debut === 1
          && F('world', 'familiers-niveau').includes('once a minute') && F('world', 'familiers-niveau').includes(monde.FAMILIERS.parMinute.fin + ' times a minute')],
        ['donjons', nb(F('world', 'donjons'))[0] === String(Object.keys(monde.DONJONS).length) && Object.values(monde.DONJONS).every((d) => F('world', 'donjons').includes(d.nom))],
      ];
      /* Le cinema vit dans le SITE (swoge_cinema.html, CATALOGUE) : relu s il est la, comme verifie.sh le lit. */
      const SITE = process.env.SWOGE_SITE || '/home/user/SWOGE.github.io';
      const page = path.join(SITE, 'swoge_cinema.html');
      if (fs.existsSync(page)) {
        const cat = (/var CATALOGUE = \[([\s\S]*?)\n  \];/.exec(fs.readFileSync(page, 'utf8')) || [])[1] || '';
        const series = cat.split(/\{ cle:"/).slice(1).map((b) => ({ nom: (/nom:"([^"]+)"/.exec(b) || [])[1], eps: (b.match(/\{slug:"/g) || []).length, ab: (b.match(/\ba:"[^"]*", b:"/g) || []).length }));
        const total = series.reduce((k, z) => k + z.eps, 0), ab = series.reduce((k, z) => k + z.ab, 0);
        const ep = F('cinema', 'episodes');
        liens.push(['cinema-episodes', series.length === 3 && ep.includes(total + ' episodes across ' + series.length + ' series')
          && series.every((z) => ep.includes(z.nom.replace(' · ', ' ') + ' (' + z.eps + ')'))]);
        liens.push(['cinema-choix', nb(F('cinema', 'choix'))[0] === String(ab)]);
      } else console.log('   (site absent : le compte des episodes du cinema n est pas relu)');
      const faux2 = liens.filter((l) => !l[1]).map((l) => l[0]);
      ok(faux2.length === 0, 'les chiffres de SWOGE World ecrits en dur sont ceux du code (34 monstres dont 19 errants, portail 40 s, niveau 20, six personnages, oeuf 1/1 200 en six sortes, familiers 100 et 1 a 20, quatre donjons)'
         + (faux2.length ? ' — faux : ' + faux2.join(', ') : ''));
    }

    /* Un fait vrai, recopie tel quel par le modele, doit passer la verification : sinon la reserve part a
       sa place et le fait ne sort jamais. Les conditions sont toutes vraies ici. */
    {
      const vTout = { bet: { sixGrands: true, dixSept: true, auto: true } };
      const avantGold = cfg.PRIX_MONDE_GOLD; cfg.PRIX_MONDE_GOLD = 20000;
      const refuses = [];
      for (const p of x.PRODUITS) for (const f of p.faits) {
        const r = x.verifieTexte(f.texte, x.sujetDe({ produit: p.cle, fait: f.id }, vTout));
        if (!r.ok) refuses.push(p.cle + '/' + f.id + ' (' + r.raison + ')');
      }
      for (const v of N) {
        const r = x.verifieTexte(v.texte, x.sujetDe({ produit: v.produit, nouveaute: v.id }, vTout));
        if (!r.ok) refuses.push(v.id + ' (' + r.raison + ')');
      }
      cfg.PRIX_MONDE_GOLD = avantGold;
      ok(refuses.length === 0, 'chaque fait et chaque nouveaute, recopie mot pour mot, passe la verification (aucun ne se refuse lui-meme)' + (refuses.length ? ' — ' + refuses.join(' ; ') : ''));
    }

    console.log('   10b. ce que l inventaire a releve faux, et ce qui n est pas vendu');
    const textes = [].concat(...x.PRODUITS.map((p) => p.faits.map((f) => f.texte).concat(p.reserves)), N.map((v) => v.texte), x.faitsDuJour(Date.now()));
    const FAUX = [/\$SWOGE Bet\b/, /odds (are )?on[- ]?chain/i, /no sign[- ]?up/i, /\b13 (AI )?agents\b/i, /keys stay on your device/i, /\b285\b/, /Uniswap v4/i,
      /* « paid in $SWOGE » etait faux pour les PARIS (ils se jouent en $SWOGEBET) ; les videos de SWOGE
         Agents, elles, se paient bien en $SWOGE (swoge_agents.html:1579). */
      /\b70%|\b30%/, /instantly on DexScreener/i, /(SWOGE Bet|\bbet(s|ting)?\b|sportsbook)[^.]*\bpaid (in|with) \$SWOGE\b/i, /ownership renounced/i, /SWOGE Nexus:/,
      /* Seconde relecture du 11/10 : l observatoire lit un echantillon (pas « every new token ») ; le tableau
         LIVE NOW retire (l appat du pari en direct) ; la graine client n est pas au joueur ; un miroir LIVE
         existe (pas « Paper only ») ; le tennis ne passe pas par ESPN (reglement, fermeture). */
      /every new token/i, /LIVE NOW/, /your client seed/i, /\bPaper only\b|\bSWOGE AI is paper trading\b/i, /final score is in from ESPN/, /Betting on a match on SWOGE Bet closes/];
    const faux = textes.filter((s) => FAUX.some((r) => r.test(s)));
    ok(faux.length === 0, 'aucune phrase relevee fausse le 11/10 (nom, cotes sur la chaine, 13 agents, cles « sur l appareil », v4, 70/30, 285 chaines)' + (faux.length ? ' — ' + faux[0].slice(0, 80) : ''));
    ok(!P('world').faits.some((f) => /cinema|movie|TV\b|channels/i.test(f.texte)), 'SWOGE World : ni cinema (vide depuis le 27/09) ni chaines de TV (non garanties)');
    /* La liste du TEST, independante de celle du module : ce qui n est pas vendu (en observation),
       toute promesse de gain, ce qui est ferme. Chaque terme est absent du catalogue ET refuse si le
       modele l ecrit. */
    const TERMES = ['live betting', 'bet live', 'in-play', 'market totals', 'cup betting', 'Europa League', 'FA Cup', 'Coupe de France', 'guaranteed', 'price target',
      'beat the bookies', 'beat the house', '+EV', 'risk-free', 'easy money', 'staking', 'APR', 'yield', 'play-to-earn', 'NFT', 'instant payout', 'best odds', 'zero margin',
      'Uniswap v4', 'SWOGE +18', 'SWOGE FLIX', 'passive income', 'final whistle'];
    const echappe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const presents = TERMES.filter((m) => textes.some((s) => new RegExp('(^|\\W)' + echappe(m) + '(\\W|$)', 'i').test(s)));
    ok(presents.length === 0, TERMES.length + ' termes interdits absents des faits, nouveautes, reserves et faits du jour' + (presents.length ? ' — ' + presents.join(', ') : ''));
    const sujetBet = x.sujetDe({ produit: 'bet', fait: 'carnet' }, x.instantane(null, Date.now()));
    const passes = TERMES.filter((m) => x.verifieTexte('SWOGE Bet: ' + m + ' tonight 🐕', sujetBet).ok);
    ok(passes.length === 0, 'et chacun, ecrit par le modele, est refuse (la reserve part a sa place)' + (passes.length ? ' — passe : ' + passes.join(', ') : ''));
    const parProduit = [['bet', 'SWOGE Bet has the best football slate 🏈'], ['bet', 'SWOGE Bet is provably fair 🐕'], ['world', 'SWOGE World now has a cinema 🎬'],
      ['world', 'Play SWOGE World and earn 🐕'], ['casino', 'The SWOGE casino RTP is huge 🎰'], ['casino', 'Choose your own seed in the SWOGE casino 🎲'],
      ['wallet', 'SWOGE Wallet: Face ID protects your funds 🔒'], ['wallet', 'The SWOGE launchpad is audited 🚀'], ['ai', 'SWOGE AI makes money every day 🤖'],
      ['ai', 'SWOGE Agents is uncensored 🧠'], ['cinema', 'Vote now on SWOGE AI Cinema 🎬'], ['cinema', 'SWOGE AI Cinema: 100% original characters 🍿']];
    const fuites = parProduit.filter(([c, t]) => x.verifieTexte(t, x.sujetDe({ produit: c }, {})).ok);
    ok(fuites.length === 0, 'les interdits propres a chaque produit (football = NFL, provably fair hors casino, cinema dans le monde, earn, RTP, graine choisie, Face ID, audit, gain de l IA, vote)'
       + (fuites.length ? ' — passe : ' + fuites.map((f) => f[1]).join(' | ') : ''));
    const r1 = x.verifieTexte('$SWOGE Bet is live 🐕', sujetBet);
    ok(!r1.ok && x.corrigeNoms('$SWOGE Bet is live 🐕') === 'SWOGE Bet is live 🐕' && x.verifieTexte(x.corrigeNoms('$SWOGE Bet is live 🐕'), sujetBet).ok,
       '« $SWOGE Bet » est un faux nom : refuse tel quel, corrige en « SWOGE Bet » avant la verification');

    /* ---- CHAQUE GARDE A SON TEMOIN (relecture du 11/10) ----
     * Les mutations du 11/10 retiraient « live odds », « in-game bet », Pokal, Copa del Rey… et 31 des
     * 43 interdits par produit sans qu un essai tombe : les exemples ne couvraient qu une partie des
     * listes, et l essai ne lisait que `.ok` (un terme a chiffre etait refuse par le controle des
     * nombres a la place du filtre). Ici, chaque alternative de chaque expression a un temoin qui
     * n est refuse QUE par elle : la raison doit nommer cette expression, et le temoin ne doit toucher
     * aucune autre alternative de la meme. Ajouter une alternative sans temoin fait tomber l essai. */
    const alternatives = (src) => {
      const out = []; let prof = 0, classe = false, cur = '';
      for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { cur += c + src[i + 1]; i++; continue; }
        if (classe) { if (c === ']') classe = false; cur += c; continue; }
        if (c === '[') { classe = true; cur += c; continue; }
        if (c === '(') prof++;
        if (c === ')') prof--;
        if (c === '|' && prof === 0) { out.push(cur); cur = ''; continue; }
        cur += c;
      }
      out.push(cur);
      return out;
    };
    /* `applicables(t)` : toutes les expressions qui jugent le texte t (MOTS_INTERDITS, celles de son
       produit, celles des produits qu il nomme). Un temoin n en touche qu UNE : retirer l alternative
       qu il porte le fait passer (ou tomber sur le controle des nombres), jamais sur une voisine
       — sinon la mutation passerait inapercue (« cash out your winnings » tombait sur le cash-out de
       SWOGE Bet, « P2E » et « SWOGE +18 » sur le controle des nombres). */
    const couverture = (liste, temoins, verifie, applicables) => {
      const raisons = temoins.map((t) => { const r = verifie(t); return r.ok ? 'PASSE' : r.raison; });
      const manques = [];
      liste.forEach((r) => {
        const alts = alternatives(r.source).map((a) => new RegExp(a, r.flags));
        alts.forEach((A, j) => {
          if (!temoins.some((t, k) => raisons[k] === 'mot interdit ' + String(r) && A.test(t) && alts.every((B, m) => m === j || !B.test(t)))) manques.push(String(r) + ' #' + j + ' (' + alternatives(r.source)[j] + ')');
        });
      });
      const ambigus = temoins.filter((t, k) => { const m = applicables(t).filter((r) => r.test(t)); return m.length !== 1 || !liste.includes(m[0]) || raisons[k] !== 'mot interdit ' + String(m[0]); });
      return { manques, passent: temoins.filter((t, k) => raisons[k] === 'PASSE'), ambigus };
    };
    const applicablesDe = (cle) => (t) => x.MOTS_INTERDITS.concat(P(cle).interdits, ...x.PRODUITS.filter((q) => q.cle !== cle && q.motsCles.test(t)).map((q) => q.interdits));
    const GLOBAUX = ['live betting', 'bet live', 'in-play markets', 'in-game bets', 'live odds', 'totals', 'the cup', 'Europa League', 'Conference League', 'DFB-Pokal',
      'Copa del Rey', 'Coppa Italia', 'Coupe de France', 'guaranteed', 'price target', 'beat the bookies', '+EV', 'positive EV', 'easy money', 'free money', 'risk-free',
      'a sure thing', 'you can\'t lose', 'passive income', 'get rich', 'APR', 'APY', 'yield', 'staking', 'instant payout', 'final whistle', 'best odds', 'sharp odds',
      'zero margin', 'no margin', 'same odds', 'play-to-earn', 'P2E', 'NFT', 'Uniswap v4', 'SWOGE +18', 'SWOGE FLIX', 'manga', 'bet on live matches', 'live sports wagers',
      'wager during the game', 'odds move live', 'win big', 'earn real', 'profits', 'cash out your winnings', 'best payouts', 'better odds', 'swoleeswoge.dog',
      /* Seconde relecture du 11/10 : les coupes hors liste, la vitesse, les gains dits autrement, le domaine
         a deux lettres (mutation D03 : « x.ai » passait avec [a-z]{3,}) ou colle derriere « _ », le nom du
         site sous toute forme, l audit et la licence, l invulnerable, l appli et les bonus, un concurrent,
         un superlatif, « any chain », les centimes. */
      'Carabao', 'Libertadores', 'Sudamericana', 'Community Shield', 'knockout rounds', 'in seconds', 'right away', 'immediately',
      'gains', 'payday', 'make bank', 'stack bags', 'cash in', 'double your stack', 'x.ai', 'link: _pump.fun', 'swoleeswoge . dog',
      'audited', 'licensed', 'regulated', 'no KYC', 'anonymous', 'house edge', 'low edge', 'can\'t be rugged', 'impossible', 'immune', 'unstoppable', 'unruggable',
      'rug-proof', 'never get rugged again', 'mobile app', 'cashback', 'rakeback', 'welcome bonus', 'free bets', 'deposit bonus', 'airdrop', 'giveaway', 'DraftKings',
      'the first sportsbook', '#1', 'number one', 'any chain', 'pennies', 'cents', 'never misses', 'soon', 'coming', 'upcoming', 'tomorrow', 'next week',
      'stay tuned', 'roadmap', 'we\'ll', 'we will', 'insured', 'insurance fund', 'backed by', 'IPFS', 'Arweave', 'decentralized']
      .map((m) => 'SWOGE AI Cinema: ' + m + ' 🐕');                 /* le cinema : ses interdits ne croisent aucun de ces termes */
    const sujetCine = x.sujetDe({ produit: 'cinema', fait: 'ouvert' }, {});
    const cg = couverture(x.MOTS_INTERDITS, GLOBAUX, (t) => x.verifieTexte(t, sujetCine), applicablesDe('cinema'));
    ok(cg.manques.length === 0 && cg.passent.length === 0 && cg.ambigus.length === 0, x.MOTS_INTERDITS.length + ' expressions de MOTS_INTERDITS : chaque alternative a un temoin refuse par elle seule (pas vendu, gain, domaine nu)'
       + (cg.manques.length ? ' — sans temoin : ' + cg.manques.join(' ; ') : '') + (cg.passent.length ? ' — passe : ' + cg.passent.join(' | ') : '') + (cg.ambigus.length ? ' — ambigus : ' + cg.ambigus.join(' | ') : ''));
    const TEMOINS = {
      bet: ['SWOGE Bet has the best football slate', '$SWOGE Bet is here', 'SWOGE Bet is provably fair', 'SWOGE Bet has on-chain odds', 'SWOGE Bet odds are on-chain',
        'SWOGE Bet, no sign-up', 'SWOGE Bet max stake', 'SWOGE Bet: up to 500 $SWOGEBET a slip', 'SWOGE Bet odds copied', 'SWOGE Bet odds straight from the book', 'SWOGE Bet fair odds', 'SWOGE Bet: Betfair minus',
        'every bet is posted on SWOGE Bet', 'SWOGE Bet in-running', 'SWOGE Bet lets you cash out', 'SWOGE Bet scores refreshed', 'SWOGE Bet scores updates every minute',
        'SWOGE Bet scores every few seconds',
        /* seconde relecture du 11/10 : le direct paraphrase, le prix du marche etendu, le paiement */
        'SWOGE Bet: scores live', 'SWOGE Bet is live wagering', 'SWOGE Bet real-time scores', 'SWOGE Bet halftime picks', 'SWOGE Bet next goal', 'SWOGE Bet after kickoff',
        'SWOGE Bet: matches under way', 'SWOGE Bet: matches in progress', 'SWOGE Bet second half', 'SWOGE Bet while you watch', 'SWOGE Bet as the action unfolds',
        'SWOGE Bet streams matches', 'SWOGE Bet: over/under priced off Betfair', 'SWOGE Bet: Pinnacle prices for tennis', 'SWOGE Bet pays when the whistle blows',
        'SWOGE Bet pays to your wallet', 'SWOGE Bet odds identical', 'SWOGE Bet props', 'SWOGE Bet same-game', 'SWOGE Bet esports', 'SWOGE Bet F1', 'SWOGE Bet UFC',
        'SWOGE Bet MMA', 'SWOGE Bet boxing', 'SWOGE Bet horse racing', 'SWOGE Bet markets on tennis', 'SWOGE Bet: tennis on ESPN', 'SWOGE Bet: ESPN tennis',
        'SWOGE Bet pays the moment it ends', 'SWOGE Bet pays within a day', 'SWOGE Bet after the first goal', 'SWOGE Bet paid out in ETH', 'SWOGE Bet doubles it',
        'SWOGE Bet triples it', 'SWOGE Bet worldwide', 'SWOGE Bet globally', 'SWOGE Bet is legal', 'SWOGE Bet in every state', 'SWOGE Bet in every country'],
      world: ['SWOGE World has a cinema', 'SWOGE World movies', 'SWOGE World films', 'SWOGE World series', 'SWOGE World +18 zone',
        'SWOGE World AI agents', 'SWOGE World with Pepe', 'SWOGE World with Andy', 'SWOGE World with Brett', 'SWOGE World with Landwolf', 'SWOGE World with Optimus',
        'SWOGE World meets Street Fighter', 'SWOGE World has thousands of players', 'SWOGE World for millions', 'SWOGE World player base', 'SWOGE World keeps growing',
        'SWOGE World is provably fair', 'SWOGE World exclusive', 'SWOGE World premium',
        'SWOGE World: withdraw your gold', 'SWOGE World: cash out your gold', 'SWOGE World: trade your loot', 'SWOGE World: sell your loot', 'SWOGE World prize pool',
        'SWOGE World real prizes', 'SWOGE World: tradable loot', 'SWOGE World: get paid', 'SWOGE World pays', 'SWOGE World on-chain', 'SWOGE World permanent death',
        'SWOGE World permadeath', 'SWOGE World: lose everything'],
      casino: ['the SWOGE casino RTP', 'the SWOGE casino return to player', 'the SWOGE casino is fair on-chain', 'the SWOGE casino: on-chain fair',
        'the SWOGE casino is verified on the blockchain', 'the SWOGE casino client seed', 'pick your seed in the SWOGE casino', 'the SWOGE casino: your own seed',
        'free SWOGE at the SWOGE casino', 'the SWOGE casino weekly', 'the SWOGE casino every week', 'the SWOGE casino max bet', 'the SWOGE casino min bet', 'verify every spin in the SWOGE casino', 'every spin is verifiable in the SWOGE casino', 'SWOGE Poker rakeless', 'the SWOGE casino cheats', 'the SWOGE casino rigged', 'the SWOGE casino manipulates',
        'SWOGE Poker tournaments', 'the SWOGE casino jackpot hits',
        'the SWOGE casino is provably fair', 'SWOGE Blackjack is provably fair, like Crash', 'Blackjack and every game in the SWOGE casino are provably fair'],
      wallet: ['SWOGE Wallet v4 pools', 'the SWOGE launchpad buybacks', 'the SWOGE launchpad agent is buying back', 'the SWOGE launchpad funds itself',
        'SWOGE Wallet: Face ID protects it', 'SWOGE Wallet: sign with Face ID', 'SWOGE Wallet protects your funds', 'SWOGE Wallet: keys never leave your device',
        'SWOGE Wallet keys stay on your device', 'SWOGE Wallet is self-custodial', 'SWOGE Wallet is non-custodial', 'SWOGE Wallet blocks scams',
        'SWOGE Wallet stops honeypots', 'SWOGE Wallet sends any Solana token', 'SWOGE Wallet trades for you', 'SWOGE Wallet executes trades', 'the SWOGE launchpad agent pumps it',
        'the SWOGE launchpad: renounced', 'the SWOGE launchpad volume bench', 'SWOGE Wallet simulates every send', 'SWOGE Wallet: bridge ETH from BNB Chain',
        'SWOGE Wallet: from Polygon, bring ETH', 'every token on the SWOGE launchpad', 'the SWOGE launchpad on Solana: liquidity locked',
        'SWOGE Wallet swaps automatically', 'SWOGE Wallet works while you sleep', 'SWOGE Wallet MEV', 'SWOGE Wallet front-running', 'SWOGE Wallet sandwich',
        'SWOGE Wallet recovery', 'SWOGE Wallet restore', 'SWOGE Wallet backup', 'SWOGE Wallet: lose your phone', 'the SWOGE launchpad launches on Base',
        'the SWOGE launchpad on Raydium', 'the SWOGE launchpad graduates', 'the SWOGE launchpad agent shills', 'the SWOGE launchpad promotes',
        'the SWOGE launchpad agent markets your token'],
      ai: ['SWOGE AI P&L', 'SWOGE AI PnL', 'SWOGE AI makes money', 'SWOGE AI beats the control', 'SWOGE AI outperforms', 'SWOGE AI is crushing it',
        'SWOGE AI mirror', 'SWOGE AI with real money', 'SWOGE AI paper trades for real', 'SWOGE AI paper vs real trades', 'SWOGE AI paper and live trading', 'copy SWOGE AI',
        'SWOGE Agents uncensored', 'SWOGE Agents on Venice', 'SWOGE Agents via OpenRouter', 'SWOGE Agents with DeepSeek',
        'SWOGE Agents with Mistral', 'SWOGE Agents over Tor', 'SWOGE Agents reads the .onion web', 'SWOGE Agents bug bounty', 'SWOGE AI martingale', 'SWOGE AI paroli',
        'SWOGE Agents blackjack mode', 'SWOGE Agents restyle', 'agents already paying SWOGE Agents', 'agents are paying us at SWOGE Agents', 'SWOGE Agents revenue',
        'SWOGE Agents eSIM', 'SWOGE Agents can launch a token', 'SWOGE AI paper trades for you', 'SWOGE Agents can buy it', 'SWOGE Agents paper buys tokens for you',
        'SWOGE AI: paper, then on-chain trading', 'SWOGE AI tokens scanned', 'SWOGE AI scanned the tokens', 'SWOGE AI: 500 tokens', 'No $SWOGE needed on SWOGE Agents',
        'No $SWOGE needed for chat or videos on SWOGE Agents', 'SWOGE Agents: USDC for videos', 'SWOGE Agents videos in USDC', 'SWOGE Agents: everything paid',
        'Agent Passport is verified on-chain', 'SWOGE Agents: an on-chain ID', 'SWOGE Agents Autopilot runs for hours', 'SWOGE AI buys tokens', 'SWOGE AI calls', 'SWOGE Security on Solana',
        'SWOGE Agents logs in', 'SWOGE Agents passwords', 'SWOGE Agents uses your accounts', 'SWOGE Agents shops', 'SWOGE Agents purchases'],
      cinema: ['SWOGE AI Cinema: 100% original', 'SWOGE AI Cinema original characters',
        'SWOGE AI Cinema with Pepe', 'SWOGE AI Cinema with Brett', 'SWOGE AI Cinema with Wojak', 'SWOGE AI Cinema with Andy', 'SWOGE AI Cinema with Landwolf',
        'SWOGE AI Cinema with Bonk', 'SWOGE AI Cinema: vote now', 'SWOGE AI Cinema season 3', 'SWOGE AI Cinema new episodes',
        'SWOGE AI Cinema: more episodes', 'SWOGE AI Cinema views', 'SWOGE AI Cinema every week', 'SWOGE AI Cinema weekly', 'SWOGE AI Cinema daily',
        'SWOGE AI Cinema in 4K', 'SWOGE AI Cinema in HD', 'SWOGE AI Cinema award',
        'SWOGE AI Cinema viewers watched', 'SWOGE AI Cinema made with SwoleMind', 'SWOGE AI Cinema same tools', 'SWOGE AI Cinema: you decide',
        'SWOGE AI Cinema: the community chooses', 'SWOGE AI Cinema: fans chose this', 'SWOGE AI Cinema: the story follows your lead', 'SWOGE AI Cinema: your choice',
        'SWOGE AI Cinema: what happens next', 'SWOGE AI Cinema: shape the story', 'SWOGE AI Cinema on-chain'],
    };
    const trousP = [];
    for (const p of x.PRODUITS) {
      const c = couverture(p.interdits, (TEMOINS[p.cle] || []).map((t) => t + ' 🐕'), (t) => x.verifieTexte(t, x.sujetDe({ produit: p.cle }, {})), applicablesDe(p.cle));
      if (c.manques.length || c.passent.length || c.ambigus.length) trousP.push(p.cle + ' : ' + c.manques.concat(c.passent.map((t) => 'passe « ' + t + ' »'), c.ambigus.map((t) => 'ambigu « ' + t + ' »')).join(' ; '));
    }
    ok(trousP.length === 0, x.PRODUITS.reduce((k, p) => k + p.interdits.length, 0) + ' interdits propres aux produits : chaque alternative a un temoin refuse par elle seule, aucune n est un doublon de MOTS_INTERDITS'
       + (trousP.length ? ' — ' + trousP.join(' | ') : ''));
    /* Ce que la relecture du 11/10 a fait passer : des paraphrases du pari en direct (pas vendu), des
       promesses de gain, des nombres en lettres, un autre produit cite avec ce qu il ne doit pas dire. */
    const PARAPHRASES = [['bet', 'SWOGE Bet: bet on live matches while they play.'], ['bet', 'SWOGE Bet lets you wager during the game.'], ['bet', 'SWOGE Bet: place bets mid-match.'],
      ['bet', 'SWOGE Bet now covers eight sports.'], ['bet', 'SWOGE Bet: hundreds of players already betting.'], ['world', 'SWOGE World: win real $SWOGE by farming monsters.'],
      ['casino', 'The SWOGE casino: win big every night, jackpots drop daily.'], ['casino', 'The SWOGE casino: cash out profits.'], ['casino', 'The SWOGE casino: best payouts on Robinhood Chain.'],
      ['bet', 'SWOGE Bet also lets you play the SWOGE World cinema.'], ['bet', 'SWOGE Bet is the sportsbook on swoleeswoge.dog.'], ['wallet', 'The SWOGE launchpad launches on Solana through Pump.fun.']];
    const encore = PARAPHRASES.filter(([c, t]) => x.verifieTexte(t, x.sujetDe({ produit: c, fait: c === 'bet' ? 'carnet' : undefined }, {})).ok);
    ok(encore.length === 0, 'les ' + PARAPHRASES.length + ' textes que la relecture du 11/10 faisait passer sont refuses (pari pendant le match, gains, nombres en lettres, cinema de SWOGE World cite depuis SWOGE Bet, domaines nus)'
       + (encore.length ? ' — passe : ' + encore.map((e) => e[1]).join(' | ') : ''));
    const rx = x.verifieTexte('SWOGE Bet also lets you play the SWOGE World cinema.', sujetBet);
    ok(!rx.ok && rx.raison === 'mot interdit ' + String(P('world').interdits[0]), 'un autre produit nomme dans le texte apporte ses interdits : ici ceux de SWOGE World (' + rx.raison + ')');
    ok(!P('ai').motsCles.test('SWOGE AI Cinema is live') && P('ai').motsCles.test('SWOGE AI reads tokens'), '« SWOGE AI Cinema » ne compte pas comme « SWOGE AI » : un tweet du cinema ne nomme pas la colonie');
    /* Mutation H05 (seconde relecture du 11/10) : DEUX autres produits nommes, et seul l interdit du
       second (le portefeuille) touche le texte — chaque produit nomme apporte les siens, pas le premier seul. */
    const tH = 'Your SWOGE Bet balance plays in the SWOGE casino, and SWOGE Wallet tokens are renounced 🐕';
    const rH = x.verifieTexte(tH, sujetBet);
    ok(!rH.ok && rH.raison === 'mot interdit ' + String(P('wallet').interdits.find((r) => /renounced/.test(r.source))) && !P('casino').interdits.some((r) => r.test(tH)),
       'deux autres produits nommes (casino, puis portefeuille) : les interdits du SECOND s appliquent aussi (' + rH.raison + ')');
    /* Mutation V08 : chacun des quinze noms colles au ticker est rendu juste, pas seulement « Bet ». */
    const NOMS15 = ['Bet', 'World', 'Wallet', 'AI', 'Agents', 'Blackjack', 'Spin', 'Smash', 'Bonanza', 'Kennel', 'Poker', 'Games', 'Security', 'casino', 'launchpad'];
    const malNommes = NOMS15.filter((nm) => x.corrigeNoms('$SWOGE ' + nm + ' x') !== 'SWOGE ' + nm + ' x');
    ok(malNommes.length === 0 && x.corrigeNoms('$SWOGE is live, $SWOGE holders') === '$SWOGE is live, $SWOGE holders',
       'corrigeNoms rend les quinze faux noms (« $SWOGE World », « $SWOGE launchpad »…) et laisse le cashtag seul' + (malNommes.length ? ' — restent : ' + malNommes.join(', ') : ''));
    /* Un domaine nu (« name.dog », « name.fun ») : X en fait un lien, facture comme tel. La liste de
       l ESSAI, independante du module : les TLD de twitter-text les plus courants. */
    const DOMAINE = /\b[a-z0-9-]+\.(dog|fun|com|io|xyz|ai|net|org|app|gg|tv|me|co|so|fi|bet|games?|world|sh|dev|to|cc|us|uk|fr|de|link|site|online|club|vip|pro|info|biz|lol|wtf|html)\b/i;
    const avecDomaine = textes.concat(x.RESERVE).filter((s) => DOMAINE.test(s));
    ok(avecDomaine.length === 0, 'aucun domaine nu dans les faits, nouveautes, reserves et faits du jour : sans X_LIEN, aucun post ne paie le prix d un lien' + (avecDomaine.length ? ' — ' + avecDomaine[0].slice(0, 90) : ''));

    console.log('   10c. aucun nombre invente');
    const sujet8 = x.sujetDe({ produit: 'bet', fait: 'combines' }, {});
    ok(x.verifieTexte('Stack up to 8 picks on SWOGE Bet 🧾', sujet8).ok, 'un nombre du fait vedette passe (8 selections)');
    const r2 = x.verifieTexte('Stack up to 12 picks on SWOGE Bet 🧾', sujet8);
    ok(!r2.ok && /12/.test(r2.raison), 'un nombre absent des faits est refuse : ' + r2.raison);
    ok(!x.verifieTexte('10,000 bettors already on SWOGE Bet 🔥', sujet8).ok, 'un compte de joueurs invente aussi');
    eq(x.nombres('about 1 in every 1,200 kills, 9:16, 0.0001 ETH, 250x, 6x5').join(' '), '1 1200 9 16 0.0001 250x 6 5',
       'les nombres se lisent sans separateur de milliers ; « 250x » est un nombre a part (seconde relecture du 11/10), « 6x5 » deux nombres');
    const sujetOeufs = x.sujetDe({ produit: 'world', fait: 'oeufs' }, {});
    ok(x.verifieTexte('One egg every 1200 kills in SWOGE World 🥚', sujetOeufs).ok && x.verifieTexte('One egg every 1,200 kills in SWOGE World 🥚', sujetOeufs).ok,
       '« 1,200 » et « 1200 » sont le meme nombre');
    /* Relecture du 11/10 : les nombres en lettres comptent, dans les deux sens. */
    const sujetSports = x.sujetDe({ produit: 'bet', fait: 'sports' }, {});
    ok(x.verifieTexte('7 sports, one book: SWOGE Bet 🏟️', sujetSports).ok && x.verifieTexte('Seven sports on SWOGE Bet 🏟️', sujetSports).ok,
       '« Seven sports » dans le fait permet « 7 sports » comme « seven » ; « one » ne compte pas');
    const r8 = x.verifieTexte('SWOGE Bet now covers eight sports 🏟️', sujetBet);
    ok(!r8.ok && r8.raison === 'nombre absent des faits : 8', 'un nombre en lettres absent des faits est refuse : ' + r8.raison);
    const rC = x.verifieTexte('Hundreds of players on SWOGE Bet 🏟️', sujetSports);
    ok(!rC.ok && /hundred/.test(rC.raison), 'un ordre de grandeur invente aussi (« hundreds ») : ' + rC.raison);
    /* Un nombre d un fait VOISIN (donne au modele) passe aussi : la demande les lui a donnes. */
    const sujetMise = x.sujetDe({ produit: 'bet', fait: 'combines' }, {});
    const duVoisin = x.nombres(sujetMise.autres.join(' ')).find((k) => !x.nombres(sujetMise.lead).includes(k));
    ok(duVoisin && x.verifieTexte('SWOGE Bet: ' + duVoisin + ' and counting 🧾', sujetMise).ok, 'un nombre d un fait voisin passe (' + duVoisin + ', donne dans « Other true facts »)');
    /* Mutations W02-*, W07 (seconde relecture du 11/10) : chaque mot-nombre a SON temoin, refuse avec son
       chiffre quand il manque aux faits, et permis quand le fait l ecrit en chiffres. La liste est celle de
       l ESSAI : un mot ajoute au module sans temoin ici fait tomber l essai (sixty a ninety manquaient). */
    const MOTS_N = { zero: '0', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
      thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40',
      fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: 'hundred', thousand: 'thousand', million: 'million', billion: 'billion', dozen: 'dozen' };
    const sujetNu = (lead) => ({ nom: 'SWOGE Bet', motsCles: P('bet').motsCles, interdits: [], lead, autres: [], vivants: [] });
    const motsKo = Object.keys(MOTS_N).filter((m) => {
      const r = x.verifieTexte('SWOGE Bet reasons: ' + m + ' 🏟️', sujetNu('SWOGE Bet is our sportsbook.'));
      const permis = x.verifieTexte('SWOGE Bet reasons: ' + m + ' 🏟️', sujetNu('SWOGE Bet has ' + (/^\d/.test(MOTS_N[m]) ? MOTS_N[m] : m) + ' of them.'));
      return !(!r.ok && r.raison === 'nombre absent des faits : ' + MOTS_N[m] && permis.ok);
    });
    const sansTemoinN = Object.keys(x.MOTS_NOMBRES).filter((m) => !(m in MOTS_N));
    ok(motsKo.length === 0 && sansTemoinN.length === 0, Object.keys(MOTS_N).length + ' mots-nombres : chacun refuse avec SON chiffre s il manque aux faits, permis s il y est ; aucun mot du module sans temoin'
       + (motsKo.length ? ' — faux : ' + motsKo.join(', ') : '') + (sansTemoinN.length ? ' — sans temoin : ' + sansTemoinN.join(', ') : ''));
    /* Un nombre et ce qu il compte vont ensemble : « 8 sports » ne s appuie pas sur « 8 selections », ni
       « 40 players » sur « 40 characters ». */
    const sComb = x.sujetDe({ produit: 'bet', fait: 'combines' }, {});
    const r8s = x.verifieTexte('SWOGE Bet: 8 sports, one slip 🏟️', sComb);
    ok(!r8s.ok && r8s.raison === 'compte absent des faits : 8 sport' && x.verifieTexte('SWOGE Bet: up to 8 selections on one slip 🧾', sComb).ok,
       '« 8 sports » est refuse quand le fait dit « 8 selections », qui passe : ' + r8s.raison);
    const s40 = x.sujetDe({ produit: 'world', fait: 'monde' }, x.instantane({ game: { classementMonde: () => ({ vivants: 40 }), boulierPotStr: () => '0' } }, Date.now()));
    const r40 = x.verifieTexte('40 players online in SWOGE World right now 🎮', s40);
    ok(!r40.ok && r40.raison === 'compte absent des faits : 40 player' && x.verifieTexte('40 characters alive in SWOGE World right now 🎮', s40).ok,
       '« 40 players » est refuse quand le chiffre vivant compte 40 personnages, « 40 characters » passe');
    /* Un suffixe K, M, B ou x fait un nombre a part : « 1M » ne s appuie pas sur « 1% », ni « 250K » sur « 250x ». */
    const suff = [['wallet', 'lp-partage', 'Over 1M tokens launched on the SWOGE launchpad 🚀', '1m'], ['wallet', 'lp-partage', 'SWOGE launchpad: 1B volume and counting 🚀', '1b'],
      ['casino', 'smash', 'SWOGE Smash: 250K players smashed the gem 💎', '250k'], ['bet', 'combines', 'SWOGE Bet: 8-leg parlays for a 100x 🧾', '100x']];
    const suffKo = suff.filter(([c, f, t, n]) => { const r = x.verifieTexte(t, x.sujetDe({ produit: c, fait: f }, {})); return r.ok || r.raison !== 'nombre absent des faits : ' + n; });
    ok(suffKo.length === 0 && x.verifieTexte('SWOGE Smash: the top prize is 250x the bet 💎', x.sujetDe({ produit: 'casino', fait: 'smash' }, {})).ok,
       '« 1M », « 1B », « 250K », « 100x » sont des nombres a part, refuses s ils manquent aux faits ; « 250x » du fait passe' + (suffKo.length ? ' — passent : ' + suffKo.map((c) => c[2]).join(' | ') : ''));
    /* Les mots qui affirment : permis seulement si les faits donnes les ecrivent. */
    const rEv = x.verifieTexte('SWOGE Bet: every market, one book 🏟️', sujetBet);
    const rNo = x.verifieTexte('SWOGE Bet: no limits 🏟️', sujetBet);
    ok(!rEv.ok && rEv.raison === 'affirmation absente des faits : every' && !rNo.ok && rNo.raison === 'affirmation absente des faits : no limits'
       && x.verifieTexte('One egg in every 1,200 kills in SWOGE World 🥚', sujetOeufs).ok && x.verifieTexte('Y\'all, SWOGE Bet has real fixtures 🏟️', sujetBet).ok,
       '« every » et « no limits » absents des faits sont refuses ; « every » d un fait passe, « y\'all » n affirme rien');
    /* Chaque mot qui affirme a SON temoin (mutations A06, A07, A11, A12) : refuse s il manque aux faits,
       permis s il y est. La liste est celle de l ESSAI : un mot retire du module fait tomber l essai. */
    const AFFIRME = ['every', 'everyone', 'everybody', 'everything', 'everywhere', 'all', 'any', 'anyone', 'anybody', 'anything', 'anywhere', 'anytime', 'always',
      'forever', 'unlimited', 'endless', 'only', 'first', 'free', 'best', 'biggest', 'fastest', 'cheapest', 'lowest', 'highest', 'largest', 'safest', 'safer', 'safe',
      'secure', 'secured', 'securely', 'sharpest', 'greatest', 'smartest', 'top', 'leading', 'than', 'beat', 'beats', 'beating', 'outperform', 'outperforms',
      'outperformed', 'outperforming', 'fully', 'completely', 'totally', 'entirely'];
    const affKo = AFFIRME.filter((m) => {
      const r = x.verifieTexte('SWOGE Bet: ' + m + ' 🏟️', sujetNu('SWOGE Bet is our sportsbook.'));
      return !(!r.ok && r.raison === 'affirmation absente des faits : ' + m && x.verifieTexte('SWOGE Bet: ' + m + ' 🏟️', sujetNu('SWOGE Bet is ' + m + '.')).ok);
    });
    ok(affKo.length === 0, AFFIRME.length + ' mots qui affirment : chacun refuse s il manque aux faits, permis s il y est' + (affKo.length ? ' — faux : ' + affKo.join(', ') : ''));
    /* Chaque chose comptee a SON temoin (mutations U-*) : « 7 X » refuse quand les faits ont 7 sans X,
       permis quand ils disent « 7 X ». Liste de l ESSAI ; une unite du module sans temoin fait tomber l essai. */
    const COMPTES = [['sport', 'sports'], ['league', 'leagues'], ['competition', 'competitions'], ['market', 'markets'], ['match', 'matches'], ['game', 'games'],
      ['player', 'players'], ['user', 'users'], ['holder', 'holders'], ['bettor', 'bettors'], ['member', 'members'], ['follower', 'followers'], ['token', 'tokens'],
      ['agent', 'agents'], ['chain', 'chains'], ['country', 'countries'], ['model', 'models'], ['episode', 'episodes'], ['series', 'series'], ['character', 'characters'],
      ['creator', 'creators'], ['trader', 'traders'], ['wallet', 'wallets'], ['kill', 'kills'], ['level', 'levels'], ['second', 'seconds'], ['minute', 'minutes'],
      ['hour', 'hours'], ['day', 'days'], ['week', 'weeks'], ['month', 'months']];
    const sujetCine7 = (lead) => ({ nom: 'SWOGE AI Cinema', motsCles: P('cinema').motsCles, interdits: P('cinema').interdits, lead, autres: [], vivants: [] });
    const cptKo = COMPTES.filter(([u, pl]) => {
      const r = x.verifieTexte('SWOGE AI Cinema: 7 ' + pl + ' 🎬', sujetCine7('SWOGE AI Cinema has 7 of them.'));
      return !(!r.ok && r.raison === 'compte absent des faits : 7 ' + u && x.verifieTexte('SWOGE AI Cinema: 7 ' + pl + ' 🎬', sujetCine7('SWOGE AI Cinema has 7 ' + pl + '.')).ok);
    });
    const unitesSansTemoin = x.UNITES.filter((u) => !COMPTES.some(([v]) => v === u));
    ok(cptKo.length === 0 && unitesSansTemoin.length === 0, COMPTES.length + ' choses comptees : « 7 X » refuse sans « 7 X » dans les faits, permis avec ; aucune unite du module sans temoin'
       + (cptKo.length ? ' — faux : ' + cptKo.map((c) => c[0]).join(', ') : '') + (unitesSansTemoin.length ? ' — sans temoin : ' + unitesSansTemoin.join(', ') : ''));
    /* La consigne (mutation FA8) : la Ligue des champions est offerte, pas les coupes nationales ni l Europa. */
    ok(/no domestic cups and no Europa or Conference League \(the Champions League is offered\)/.test(x.SYSTEME) && !/no cup competitions/.test(x.SYSTEME),
       'la consigne dit que la Ligue des champions est offerte (le fait prix-marche la nomme) et refuse les coupes nationales, l Europa et la Conference League');

    console.log('   10d. les reserves');
    const tags = { ticker: true, hashtag: true };
    for (const p of x.PRODUITS) {
      const s0 = { nom: p.nom, motsCles: p.motsCles, interdits: p.interdits, lead: p.faits.map((f) => f.texte).join(' '), autres: [], vivants: [] };
      const ko = p.reserves.filter((r) => r.length > 215 || x.nettoie(r, false, tags).length > 240 || !x.verifieTexte(x.nettoie(r, false, tags), s0).ok);
      ok(p.reserves.length >= 2 && ko.length === 0, p.nom + ' : ' + p.reserves.length + ' reserves vraies, qui le nomment, sans mot interdit ni nombre hors des faits, 240 signes au plus avec $SWOGE et #RobinhoodChain');
    }
    const novKo = x.NOUVEAUTES.filter((v) => { const s = x.sujetDe({ produit: v.produit, nouveaute: v.id, retour: true }, { bet: { sixGrands: true, dixSept: true } });
      return !s.nouveaute || s.reserves[0].length > 215 || !x.verifieTexte(x.nettoie(s.reserves[0], false, tags), s).ok; });
    ok(novKo.length === 0, 'chaque nouveaute a sa reserve (son texte, precede de « ICYMI: » en rappel), qui passe les memes regles' + (novKo.length ? ' — ' + novKo.map((v) => v.id).join(', ') : ''));
    eq(x.RESERVE.length, x.PRODUITS.reduce((k, p) => k + p.reserves.length, 0), 'RESERVE rassemble les reserves des produits (plus aucune phrase generique)');
    const sRet = x.sujetDe({ produit: 'casino', nouveaute: 'casino-swogebet', retour: true }, {});
    ok(sRet.retour && /^ICYMI: Your \$SWOGEBET/.test(sRet.reserves[0]) && !/^ICYMI/.test(x.sujetDe({ produit: 'casino', nouveaute: 'casino-swogebet' }, {}).reserves[0]),
       'en rappel, la reserve d une nouveaute dit « ICYMI » : jamais presentee comme neuve une deuxieme fois');
    {
      /* Sans cle Anthropic : la reserve du PRODUIT, pas une phrase generique. X_LIEN : le lien de SA page. */
      const avant = { a: process.env.ANTHROPIC_API_KEY, l: process.env.X_LIEN };
      delete process.env.ANTHROPIC_API_KEY;
      const sC = x.sujetDe({ produit: 'cinema', fait: 'ouvert' }, {});
      const r0 = await x.ecritTexte([], { scene: { prompt: 's' }, cle: 'k', sujetProduit: sC }, async () => { throw new Error('aucun appel'); });
      ok(r0.via === 'reserve' && x.produitDe('cinema').reserves.some((t) => x.nettoie(t, false, x.etiquettes('k', x.env().heures)) === r0.texte),
         'sans cle pour le texte, un creneau produit poste une reserve de CE produit');
      process.env.X_LIEN = '1';
      const r1 = await x.ecritTexte([], { scene: { prompt: 's' }, cle: 'k', sujetProduit: sC }, async () => { throw new Error('aucun appel'); });
      ok(/\nhttps:\/\/swoleeswoge\.dog\/swoge_cinema\.html$/.test(r1.texte) && r1.texte.length <= 280, 'avec X_LIEN, le lien mene a la page du produit (ici le cinema)');
      if (avant.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = avant.a;
      if (avant.l === undefined) delete process.env.X_LIEN; else process.env.X_LIEN = avant.l;
    }
    /* Relecture du 11/10 : le lien d un VOLET (le launchpad menait au portefeuille, la colonie a la page des agents). */
    const lienDe = (c, f) => x.sujetDe({ produit: c, fait: f }, {}).lien.replace('https://swoleeswoge.dog/', '');
    ok(lienDe('wallet', 'lp-verrou') === 'launchpad.html' && lienDe('wallet', 'swap') === 'swoge_wallet.html' && lienDe('ai', 'colonie') === 'swoge_ai.html'
       && lienDe('ai', 'sol-eth') === 'swoge_sol_ai.html' && lienDe('ai', 'cansell') === 'swoge_security.html' && lienDe('ai', 'chat') === 'swoge_agents.html'
       && lienDe('ai', 'passport') === 'agent_passport.html' && lienDe('ai', 'store') === 'agent_store.html'
       && x.sujetDe({ produit: 'wallet', nouveaute: 'lp-gaz' }, {}).lien.endsWith('/launchpad.html'),
       'avec X_LIEN, chaque volet mene a SA page : launchpad, colonie, Solana AI, Security, Agents, Passport, Store');
    /* Le launchpad sur Solana n a pas les regles des pools de Robinhood Chain : jamais voisins. */
    const solana = x.sujetDe({ produit: 'wallet', fait: 'lp-solana' }, {}), solNouv = x.sujetDe({ produit: 'wallet', nouveaute: 'lp-solana' }, {});
    const regles = ['lp-offre', 'lp-verrou', 'lp-erc20', 'lp-partage'].map((id) => P('wallet').faits.find((f) => f.id === id).texte);
    const lpSol = P('wallet').faits.find((f) => f.id === 'lp-solana').texte;
    ok(!solana.autres.some((t) => regles.includes(t)) && !solNouv.autres.some((t) => regles.includes(t))
       && P('wallet').faits.filter((f) => f.nom === 'the SWOGE launchpad').every((f) => !x.sujetDe({ produit: 'wallet', fait: f.id }, {}).autres.includes(lpSol) || f.id === 'lp-solana'),
       'le lancement sur Solana et les regles des pools de Robinhood Chain (offre, verrou, ERC-20, partage) ne sont jamais donnes ensemble');
    ok(regles.every((t) => /on Robinhood Chain/.test(t)), 'et ces quatre regles disent « on Robinhood Chain »');
    /* Jamais deux fois le meme texte : X refuse un doublon, et le creneau tomberait apres avoir paye son image. */
    const sB = x.sujetDe({ produit: 'bet', fait: 'elo' }, {});
    eq(x.reserveDe(sB.reserves, [], 'k'), sB.reserves[0], 'rien de poste : la premiere reserve');
    eq(x.reserveDe(sB.reserves, ['old', x.nettoie(sB.reserves[0], false, { ticker: true, hashtag: true })], 'k'), sB.reserves[1],
       'la premiere deja postee (avec $SWOGE et #RobinhoodChain en plus) : la suivante, jamais un doublon');
    ok(sB.reserves.includes(sB.lead) && sB.autres.every((t) => t.length > 215 || sB.reserves.includes(t)) && sB.reserves.indexOf(sB.lead) === P('bet').reserves.length
       && P('bet').faits.filter((f) => !f.condition && f.texte.length <= 215).every((f) => sB.reserves.includes(f.texte)),
       'apres les reserves du produit viennent son fait vedette, ses voisins, puis ses autres faits vrais du moment (ils le nomment deja)');
    const toutes = sB.reserves.map((r) => x.nettoie(r, false, { ticker: false, hashtag: false }));
    eq(x.reserveDe(sB.reserves, toutes, 'k'), sB.reserves[sB.reserves.length - 1], 'toutes deja postees : celle postee il y a le plus longtemps');
    {
      /* Le pire cas de la relecture : chaque texte du modele refuse (ou pas de cle Anthropic, qui n est
         pas dans les cles obligatoires) pendant 60 jours. Avant : 64 doublons exacts en 30 jours, le
         premier 3 jours apres l original (14/10). Mesure du 11/10 avec le code corrige : 4 retours en 30
         jours, 93 en 60, jamais moins de 21,3 jours apres la sortie precedente du meme texte (le cinema,
         12 textes, s epuise le premier). La fenetre de doublon de X n est pas documentee : on tient
         deux semaines au moins. */
      const j = { jours: {} }; const vus = new Map(); let ecart = Infinity;
      for (let d = 0; d < 60; d++) for (const h of H4) {
        const jour = jourPlus('2026-10-11', d), cle = jour + '#' + h, t = instantDe(jour, h), v = x.instantane(null, t);
        const c = x.choixSujet(cle, j, t, { vivant: v }); const s = x.sujetDe(c, v);
        const texte = x.nettoie(x.reserveDe(s.reserves, x.dernieres(j, 100000).map((e) => e.texte), cle), false, x.etiquettes(cle, H4));
        const e = x.empreinte(texte); if (vus.has(e)) ecart = Math.min(ecart, (t - vus.get(e)) / 864e5); vus.set(e, t);
        j.jours[cle] = Object.assign({ id: cle, quand: new Date(t).toISOString(), texte }, c);
      }
      ok(ecart >= 14, 'soixante jours ou chaque texte serait une reserve : un meme texte ne revient jamais avant deux semaines (au plus tot ' + Math.round(ecart * 10) / 10 + ' jours)');
    }

    console.log('   10e. une image propre a chaque produit');
    const noms = x.SCENES.map((s) => s.nom).concat(x.SCENES_PRODUITS.map((s) => s.nom));
    eq(new Set(noms).size, noms.length, 'les scenes des produits ont des noms a elles (' + x.SCENES_PRODUITS.length + ' nouvelles)');
    ok(x.PRODUITS.every((p) => p.scenes.length >= 3 && p.scenes.every((nm) => x.sceneDeNom(nm))), 'au moins trois scenes par produit, toutes trouvees');
    ok(x.SCENES_PRODUITS.every((s) => s.monde && !/\b(text|letters|logos?|charts?|candlesticks?|coins?|trading|hands?|fingers?|numbers?)\b/i.test(s.prompt + ' ' + s.monde)),
       'aucune ne demande texte, logo, courbe, ecran de trading, pieces ni mains');
    ok(x.PRODUITS.every((p) => p.scenes.every((nm) => { const pr = x.promptImage(x.sceneDeNom(nm), 'k'); return pr.includes(x.NEGATIF) && /paw pads/.test(pr); })),
       'et le prompt complet porte le refus (NEGATIF) et les coussinets de SWOGE');
    {
      const j = { jours: {} }; const vues = [];
      for (let i = 0; i < 4; i++) { const sc = x.sceneProduit(P('bet'), 'k' + i, j); vues.push(sc.nom); j.jours['k' + i] = { scene: sc.nom, id: String(i), quand: new Date(Date.UTC(2026, 9, 12 + i)).toISOString() }; }
      eq(new Set(vues).size, 4, 'quatre posts de SWOGE Bet : quatre scenes differentes (la moins recemment postee d abord)');
    }

    console.log('   10f. la rotation');
    const R = x.ROTATION, L = R.length;
    eq([...new Set(R)].sort().join(), x.PRODUITS.map((p) => p.cle).sort().join(), 'la rotation porte les six produits, et eux seuls');
    ok(R.every((c, i) => c !== R[(i + 1) % L]), 'jamais deux fois le meme d affilee, y compris d un tour au suivant');
    let trous = 0; for (let i = 0; i < L; i++) { const f = new Set(); for (let k = 0; k < 8; k++) f.add(R[(i + k) % L]); if (f.size !== 6) trous++; }
    eq(trous, 0, 'toute fenetre de huit creneaux (deux jours) couvre les six produits');
    const cpt = (l) => l.reduce((o, c) => { o[c] = (o[c] || 0) + 1; return o; }, {});
    const c24 = cpt(R);
    ok(['bet', 'world', 'casino'].every((c) => c24[c] === 5) && ['wallet', 'ai', 'cinema'].every((c) => c24[c] === 3),
       'sur 24 creneaux : 5 fois paris, World et casino, 3 fois les autres — ce que le proprietaire nomme revient plus souvent');
    /* Decembre : plus aucune nouveaute fraiche, la rotation seule. */
    const dec = simule('2026-12-01', 7);
    ok(dec.every((c) => !c.nouveaute && Number.isInteger(c.rang)), 'sans nouveaute fraiche (decembre), chaque creneau prend la rotation');
    eq(new Set(dec.slice(0, 8).map((c) => c.produit)).size, 6, 'les huit premiers creneaux (deux jours) couvrent les six produits');
    ok(dec.every((c, i) => i === 0 || c.produit !== dec[i - 1].produit), 'jamais deux fois le meme produit de suite');
    const sem = cpt(dec.map((c) => c.produit));
    ok(Math.min(sem.bet, sem.world, sem.casino) > Math.max(sem.wallet, sem.ai, sem.cinema),
       'sur une semaine : paris ' + sem.bet + ', World ' + sem.world + ', casino ' + sem.casino + ' contre ' + sem.wallet + ' / ' + sem.ai + ' / ' + sem.cinema + ' pour les autres');
    const faitsBet = dec.filter((c) => c.produit === 'bet').map((c) => c.fait);
    eq(new Set(faitsBet).size, faitsBet.length, 'le fait vedette d un produit tourne : ' + faitsBet.length + ' posts de SWOGE Bet, ' + faitsBet.length + ' faits differents');

    console.log('   10g. les nouveautes : priorite, unicite, fraicheur');
    const oct = simule('2026-10-12', 20);
    eq(oct[0].nouveaute, 'lp-gaz', 'le 12/10 a 09:00, la nouveaute la plus recente part la premiere (le launchpad du 09/10 ; les 17 championnats attendent leur lecture)');
    ok(oct.every((c, i) => i === 0 || !(c.nouveaute && oct[i - 1].nouveaute)), 'jamais deux creneaux de nouveaute d affilee : la rotation garde un creneau sur deux');
    ok(oct.every((c, i) => i === 0 || c.produit !== oct[i - 1].produit), 'jamais le meme produit deux creneaux de suite, nouveautes comprises');
    /* Relecture du 11/10 (mutation R04) : si la rotation repartait du dernier rang au lieu du suivant,
       elle restait collee sur SWOGE Bet des qu une nouveaute s intercalait (13 posts sur 14), et rien
       ne tombait. D un creneau de rotation au suivant, le rang avance d un pas — de deux seulement
       quand le pas tombait sur le produit qui vient de passer. */
    const rot = oct.map((c, i) => Object.assign({ i }, c)).filter((c) => Number.isInteger(c.rang));
    const L24 = x.ROTATION.length;
    const sauts = rot.filter((c, k) => k > 0 && !(c.rang === (rot[k - 1].rang + 1) % L24
      || (c.rang === (rot[k - 1].rang + 2) % L24 && x.ROTATION[(rot[k - 1].rang + 1) % L24] === oct[c.i - 1].produit)));
    ok(rot.length >= 30 && sauts.length === 0, rot.length + ' creneaux de rotation en vingt jours : le rang avance d un pas a chaque fois (deux quand le pas retombait sur le produit precedent)'
       + (sauts.length ? ' — ' + sauts.map((c) => c.cle + ' rang ' + c.rang).join(', ') : ''));
    const rot7 = rot.filter((c) => c.t < Date.parse('2026-10-19T00:00:00Z')); const c7 = {}; rot7.forEach((c) => { c7[c.produit] = (c7[c.produit] || 0) + 1; });
    ok(Object.keys(c7).length >= 5 && Math.max(...Object.values(c7)) <= 5,
       'la premiere semaine, les ' + rot7.length + ' creneaux de rotation couvrent ' + Object.keys(c7).length + ' produits, aucun plus de cinq fois (' + JSON.stringify(c7) + ')');
    const parId = {}; for (const c of oct) if (c.nouveaute) (parId[c.nouveaute] = parId[c.nouveaute] || []).push(c);
    const NV = (id) => x.NOUVEAUTES.find((v) => v.id === id);
    const maux = Object.entries(parId).filter(([id, l]) => {
      const v = NV(id), d = Date.parse(v.date + 'T00:00:00Z'), sorties = (v.deja || []).map(Date.parse).concat(l.map((c) => c.t));
      return sorties.length > 2 || l.some((c) => c.t < d || c.t - d >= 14 * 864e5) || (sorties.length === 2 && sorties[1] - sorties[0] < 7 * 864e5)
        || l.some((c, k) => !!c.retour !== (k + (v.deja || []).length > 0)) || l.some((c) => c.produit !== v.produit);
    });
    ok(Object.keys(parId).length >= 10 && maux.length === 0,
       Object.keys(parId).length + ' nouveautes parties en vingt jours : deux sorties au plus, la seconde 7 jours apres au moins et marquee rappel, jamais avant sa date ni a 14 jours' + (maux.length ? ' — ' + maux.map((m) => m[0]).join(', ') : ''));
    ok(!parId['bet-marche-17'], 'les 17 championnats ne partent pas tant que prix_ligues ne les lit pas (ici : la liste par defaut, six)');
    ok(parId['casino-swogebet'] && parId['casino-swogebet'].every((c) => c.retour && c.t >= Date.parse('2026-10-15T00:00:00Z')),
       'le casino en $SWOGEBET (deja annonce le 08/10) ne revient qu en rappel, pas avant le 15/10');
    ok(oct.filter((c) => c.nouveaute).length >= 14 && oct.filter((c) => c.nouveaute).length <= oct.length / 2, 'un creneau sur deux au plus va aux nouveautes');
    /* Une liste a la main : chaque regle, seule. */
    const L2 = [{ id: 'vieille', date: '2026-11-01', produit: 'world', texte: 'SWOGE World v' }, { id: 'neuve', date: '2026-11-10', produit: 'casino', texte: 'the SWOGE casino n' },
      { id: 'future', date: '2026-11-20', produit: 'bet', texte: 'SWOGE Bet f' }, { id: 'usee', date: '2026-11-10', produit: 'ai', deja: ['2026-10-20T12:00:00Z', '2026-10-28T12:00:00Z'], texte: 'SWOGE AI u' }];
    const vide = { jours: {} };
    const choix = (jour, j, liste) => x.choixSujet(jour + '#09:00', j, instantDe(jour, '09:00'), { nouveautes: liste || L2, vivant: {} });
    eq(choix('2026-11-12', vide).nouveaute, 'neuve', 'la plus recente jamais tweetee passe d abord');
    const j1 = { jours: { a: { id: '1', quand: '2026-11-12T13:01:00Z', produit: 'casino', nouveaute: 'neuve', fait: 'neuve' } } };
    eq(choix('2026-11-12', j1).nouveaute, undefined, 'juste apres une nouveaute : la rotation');
    j1.jours.b = { id: '2', quand: '2026-11-12T16:31:00Z', produit: 'bet', rang: 0, fait: 'carnet' };
    eq(choix('2026-11-12', j1).nouveaute, 'vieille', 'puis la suivante, jamais tweetee');
    eq(choix('2026-11-15', vide).nouveaute, 'neuve', 'a 14 jours, une nouveaute n en est plus une (la « vieille » du 01/11 ne part plus le 15/11)');
    ok(choix('2026-11-15', vide, [L2[0]]).nouveaute === undefined, 'meme seule en lice');
    ok(choix('2026-11-19', vide, [L2[2]]).nouveaute === undefined && choix('2026-11-20', vide, [L2[2]]).nouveaute === 'future', 'jamais avant sa date');
    ok(choix('2026-11-12', vide, [L2[3]]).nouveaute === undefined, 'deux sorties deja faites (la derniere il y a plus de 7 jours) : plus jamais');
    ok(choix('2026-11-18', j1, [L2[1]]).nouveaute === undefined, 'six jours apres sa sortie : pas encore de retour');
    const ret = choix('2026-11-19', j1, [L2[1]]);
    ok(ret.nouveaute === 'neuve' && ret.retour === true, 'sept jours apres : un retour, marque comme tel');
    const autre = { id: 'autre', date: '2026-11-08', produit: 'wallet', texte: 'SWOGE Wallet a' };
    eq(choix('2026-11-19', j1, [L2[1], autre]).nouveaute, 'autre', 'une nouveaute jamais tweetee passe avant un retour, meme plus ancienne');
    const j2 = { jours: Object.assign({}, j1.jours, { c: { id: '3', quand: '2026-11-19T13:01:00Z', produit: 'casino', nouveaute: 'neuve', retour: true, fait: 'neuve' },
      d: { id: '4', quand: '2026-11-19T16:31:00Z', produit: 'bet', rang: 1, fait: 'carnet' } }) };
    ok(choix('2026-11-21', j2, [L2[1]]).nouveaute === undefined, 'apres son retour, plus jamais');
    const j3 = { jours: { a: { id: '1', quand: '2026-11-12T13:01:00Z', produit: 'casino', rang: 2, fait: 'salle' } } };
    ok(choix('2026-11-12', j3, [L2[1]]).nouveaute === undefined && choix('2026-11-12', j3, [L2[1]]).produit !== 'casino',
       'une nouveaute du produit qui vient de passer attend : jamais deux fois le meme produit de suite');

    console.log('   10h. les chiffres vivants, lus au moment du post');
    const deps = (vivants, pot, vue) => ({ game: { classementMonde: () => ({ vivants }), boulierPotStr: () => pot }, colonie: { vue: () => vue } });
    let v = x.instantane(deps(40, '1234567.891', { tours: 5, depuis: '2026-09-18T00:00:00Z', compteurs: { scoutVu: 12345 }, roster: [{ role: 'source' }, { role: 'specialiste' }, { role: 'garde' }] }), Date.now());
    ok(v.world.faits.join() === '40 characters are alive on the SWOGE World leaderboard right now.', 'SWOGE World : les personnages vivants, lus dans le jeu');
    ok(v.casino.faits.join() === 'The Boulier progressive jackpot in the SWOGE casino stands at 1,234,567 $SWOGE right now.', 'le casino : la cagnotte du Boulier, lue a l instant');
    /* Des LECTURES, pas des jetons (relecture du 11/10) : scoutVu compte chaque examen du Scout, et un
       jeton est reexamine ; la page dit « token readings since ». */
    ok(v.ai.faits.join(' | ') === '3 agents are active in the SWOGE AI colony right now, 1 of them born from it. | The SWOGE AI colony has made 12,345 token readings since September 18, 2026.',
       'SWOGE AI : les agents actifs et les lectures de jetons (pas « read N tokens » : un jeton est relu), depuis la vue de la colonie');
    v = x.instantane(deps(40, '0', { tours: 5, compteurs: { scoutVu: 7 }, roster: [{ role: 'source' }, { role: 'garde' }] }), Date.now());
    ok(v.ai.faits[0] === '2 agents are active in the SWOGE AI colony right now.', 'aucune naissance : pas de « 0 of them born from it »');
    v = x.instantane(deps(40, '0', { tours: 5, compteurs: { scoutVu: 7 }, roster: [] }), Date.now());
    const zeros = [].concat(...Object.values(x.instantane(deps(40, '0.4', { tours: 5, compteurs: { scoutVu: 7 }, roster: [] }), Date.parse('2026-12-01T12:00:00Z'))).map((p) => p.faits || []))
      .filter((f) => /(^|\s)0 (of|agents|matches|soccer|characters)|\bat 0 \$SWOGE/.test(f));
    ok(!v.ai.faits.some((f) => /agents are active/.test(f)) && zeros.length === 0, 'roster vide, cagnotte sous 1, aucun match : aucune phrase « 0 … »' + (zeros.length ? ' — ' + zeros.join(' | ') : ''));
    v = x.instantane(deps(x.MONDE_VIVANTS_MIN - 1, '0', { tours: 0, compteurs: { scoutVu: 0 } }), Date.now());
    ok(!v.world.faits.length && !v.casino.faits.length && !v.ai.faits.length,
       'sous ' + x.MONDE_VIVANTS_MIN + ' vivants, une cagnotte vide ou une colonie pas encore chargee : rien n est dit');
    const sw = x.sujetDe({ produit: 'world', fait: 'monde' }, x.instantane(deps(40, '0', {}), Date.now()));
    ok(x.verifieTexte('40 heroes alive in SWOGE World right now 🐕', sw).ok && !x.verifieTexte('40 heroes alive in SWOGE World right now 🐕', x.sujetDe({ produit: 'world', fait: 'monde' }, {})).ok,
       'un chiffre vivant peut etre cite quand il a ete lu, et seulement alors');
    const ancien = process.env.PARIS_PRIX_LIGUES;
    const pl = require('./prix_ligues'); const prixLigues = pl;
    process.env.PARIS_PRIX_LIGUES = pl.LIGUES_DEFAUT.concat(x.SECONDAIRES).join(',');
    v = x.instantane(null, Date.now());
    ok(v.bet.dixSept && v.bet.faits.includes('17 soccer leagues on SWOGE Bet are priced off the betting market right now.'), 'les 17 championnats au prix du marche : lus dans prix_ligues, pas ecrits en dur');
    eq(simule('2026-10-12', 1)[0].nouveaute, 'bet-marche-17', 'et seulement alors leur nouveaute part (la plus recente, le 09/10)');
    process.env.PARIS_PRIX_LIGUES = pl.LIGUES_DEFAUT.concat(x.SECONDAIRES, ['soccer_brazil_campeonato']).join(',');
    ok(!x.instantane(null, Date.now()).bet.dixSept && simule('2026-10-12', 1)[0].nouveaute !== 'bet-marche-17',
       'une dix-huitieme ligue ajoutee : « 17 » deviendrait faux, la nouveaute ne part plus');
    process.env.PARIS_PRIX_LIGUES = '';
    v = x.instantane(null, Date.now());
    const sansMarche = simule('2026-12-01', 14);
    ok(!v.bet.sixGrands && !sansMarche.some((c) => c.fait === 'prix-marche') && !simule('2026-10-12', 5).some((c) => /^bet-marche/.test(c.nouveaute || '')),
       'variable vide (retour a l Elo partout) : aucun fait ni aucune nouveaute de prix au marche');
    /* Mutation L21 (seconde relecture du 11/10) : liste vide, aucun « 0 soccer leagues … ». */
    ok(!v.bet.faits.some((f) => /^0\b/.test(f)), 'variable vide : aucun chiffre vivant « 0 … » sur les championnats' + (v.bet.faits.length ? ' — ' + v.bet.faits.join(' | ') : ''));
    /* Le singulier (seconde relecture du 11/10 : « 1 matches … across 1 sports »), et rien sous deux matchs. */
    {
      const paris = require('./paris'); const ouv = paris.ouverts;
      process.env.PARIS_PRIX_LIGUES = 'soccer_epl';
      paris.ouverts = () => [{ sport: 'foot', competition: 'EPL', prixMarche: true }];
      const v1 = x.instantane(null, Date.now());
      paris.ouverts = () => [{ sport: 'foot', competition: 'EPL', prixMarche: true }, { sport: 'foot', competition: 'EPL' }];
      const v2 = x.instantane(null, Date.now());
      paris.ouverts = ouv; process.env.PARIS_PRIX_LIGUES = '';
      ok(!v1.bet.faits.some((f) => /matches are open/.test(f)) && v1.bet.faits.includes('1 of the matches open on SWOGE Bet right now is priced off the betting market.')
         && v1.bet.faits.includes('1 soccer league on SWOGE Bet is priced off the betting market right now.')
         && v2.bet.faits.includes('2 matches are open right now on SWOGE Bet across 1 sport (soccer) and 1 competition.'),
         'au singulier : « 1 soccer league … is », « 1 sport », « 1 competition » ; un seul match ouvert n est pas annonce');
    }
    if (ancien === undefined) delete process.env.PARIS_PRIX_LIGUES; else process.env.PARIS_PRIX_LIGUES = ancien;
    process.env.PARIS_AUTO = '0';
    ok(!simule('2026-12-01', 21).some((c) => c.fait === 'reglement') && simule('2026-12-01', 21).some((c) => c.produit === 'bet'), 'PARIS_AUTO=0 : le reglement automatique n est plus annonce');
    delete process.env.PARIS_AUTO;
    ok(simule('2026-12-01', 21).some((c) => c.fait === 'reglement'), 'et il revient quand il est allume');
    /* Relecture du 11/10 (mutations L06, L08) : une liste PARTIELLE ne dit ni « six grands » ni « 17 ». */
    {
      const avant = process.env.PARIS_PRIX_LIGUES;
      process.env.PARIS_PRIX_LIGUES = 'soccer_epl,soccer_spain_la_liga';
      const vp = x.instantane(null, Date.now());
      const deux = simule('2026-12-01', 21).concat(simule('2026-10-12', 5));
      ok(!vp.bet.sixGrands && !deux.some((c) => c.fait === 'prix-marche' || c.nouveaute === 'bet-marche-6'),
         'deux des six grands seulement : ni le fait des six grands au prix du marche, ni sa nouveaute');
      const autres11 = ['soccer_brazil_campeonato', 'soccer_japan_j_league', 'soccer_korea_kleague1', 'soccer_australia_aleague', 'soccer_norway_eliteserien', 'soccer_sweden_allsvenskan',
        'soccer_denmark_superliga', 'soccer_austria_bundesliga', 'soccer_switzerland_superleague', 'soccer_greece_super_league', 'soccer_poland_ekstraklasa'];
      process.env.PARIS_PRIX_LIGUES = prixLigues.LIGUES_DEFAUT.concat(autres11).join(',');
      const v17 = x.instantane(null, Date.now());
      ok(v17.bet.sixGrands && !v17.bet.dixSept && simule('2026-10-12', 1)[0].nouveaute !== 'bet-marche-17',
         '17 cles dont ONZE autres que celles que la nouveaute nomme (Championship, Serie B, MLS, Liga MX…) : « 17 » n est pas dit');
      /* Mutation L06 (seconde relecture du 11/10) : 17 cles dont DIX des onze secondaires — sans Liga MX,
         que la nouveaute nomme. « some » au lieu de « every » la ferait partir. */
      process.env.PARIS_PRIX_LIGUES = prixLigues.LIGUES_DEFAUT.concat(x.SECONDAIRES.filter((k) => k !== 'soccer_mexico_ligamx'), ['soccer_brazil_campeonato']).join(',');
      const v17b = x.instantane(null, Date.now());
      ok(v17b.bet.sixGrands && !v17b.bet.dixSept && simule('2026-10-12', 1)[0].nouveaute !== 'bet-marche-17',
         '17 cles dont dix des onze secondaires (sans Liga MX, que la nouveaute nomme) : « 17 » n est pas dit');
      /* U03 : un fait dont la condition est fausse n arrive pas non plus comme VOISIN. */
      process.env.PARIS_PRIX_LIGUES = ''; process.env.PARIS_AUTO = '0';
      const vVide = x.instantane(null, Date.now());
      const cond = P('bet').faits.filter((f) => f.condition).map((f) => f.texte);
      /* Mutation U03c (seconde relecture du 11/10) : ni comme RESERVE non plus — elle part sans relecture. */
      const fuitesCond = P('bet').faits.filter((f) => { const s = x.sujetDe({ produit: 'bet', fait: f.id }, vVide); return cond.includes(s.lead) || s.autres.some((t) => cond.includes(t)) || s.reserves.some((t) => cond.includes(t)); });
      ok(cond.length >= 2 && fuitesCond.length === 0, 'variable vide et PARIS_AUTO=0 : ni le prix au marche ni le reglement automatique, en fait vedette, en voisin ou en reserve, quel que soit le fait demande'
         + (fuitesCond.length ? ' — ' + fuitesCond.map((f) => f.id).join(', ') : ''));
      /* N22 : un creneau repris dont la nouveaute n est plus vraie revient au produit. */
      const repris = x.sujetDe({ produit: 'bet', nouveaute: 'bet-marche-17', fait: 'bet-marche-17' }, vVide);
      ok(repris.nouveaute === null && !/17 leagues/.test(repris.lead) && repris.produit === 'bet', 'un creneau repris dont la nouveaute n est plus lue (17 championnats) parle du produit, pas de la nouveaute');
      delete process.env.PARIS_AUTO;
      if (avant === undefined) delete process.env.PARIS_PRIX_LIGUES; else process.env.PARIS_PRIX_LIGUES = avant;
    }
    /* Le prix mensuel de SWOGE World vient d une variable d env : dit seulement s il est > 0. */
    {
      const g = cfg.PRIX_MONDE_GOLD; cfg.PRIX_MONDE_GOLD = 0;
      const sans = simule('2026-12-01', 28).filter((c) => c.produit === 'world').map((c) => c.fait);
      cfg.PRIX_MONDE_GOLD = 20000;
      const avec = simule('2026-12-01', 28).filter((c) => c.produit === 'world').map((c) => c.fait);
      cfg.PRIX_MONDE_GOLD = g;
      ok(!sans.includes('classement') && avec.includes('classement'), 'PRIX_MONDE_GOLD a 0 : le prix mensuel du classement n est pas annonce ; pose, il l est');
      /* Mutation U03c : ni en voisin ni en reserve. */
      cfg.PRIX_MONDE_GOLD = 0;
      const tClass = P('world').faits.find((f) => f.id === 'classement').texte;
      const fuitesW = P('world').faits.filter((f) => { const s = x.sujetDe({ produit: 'world', fait: f.id }, {}); return s.lead === tClass || s.autres.includes(tClass) || s.reserves.includes(tClass); });
      cfg.PRIX_MONDE_GOLD = g;
      ok(fuitesW.length === 0, 'PRIX_MONDE_GOLD a 0 : le prix du classement n arrive ni en fait vedette, ni en voisin, ni en reserve' + (fuitesW.length ? ' — ' + fuitesW.map((f) => f.id).join(', ') : ''));
    }
    /* L11 : `planifie` garde le jeu et la colonie MEME quand les posts sont eteints (sans eux les
       chiffres vivants se taisent sans bruit). Cles retirees le temps de l appel : rien ne s arme. */
    {
      const cles = {}; for (const k of ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'OPENAI_API_KEY']) { cles[k] = process.env[k]; delete process.env[k]; }
      const arme = x.planifie(null, deps(40, '500', { tours: 2, compteurs: { scoutVu: 9 }, roster: [{ role: 'source' }] }));
      const lu = x.instantane(null, Date.now());
      ok(arme === null && /40 characters/.test(lu.world.faits.join()) && /500 \$SWOGE/.test(lu.casino.faits.join()) && lu.ai.faits.length === 2,
         'planifie garde { game, colonie } : instantane les lit ensuite sans qu on les repasse');
      x.planifie(null, {});
      for (const k of Object.keys(cles)) if (cles[k] !== undefined) process.env[k] = cles[k];
    }
    /* L13 : server.js les passe vraiment. */
    ok(/xPost\.planifie\([^\n]*\{ game, colonie: aiColonie \}\)/.test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')), 'server.js passe { game, colonie } a planifie');

    console.log('   10i. le ton');
    ok(x.angleDuCreneau('k', { nouveaute: 'x', retour: false, lead: '' }, { jours: {} }).startsWith('new:')
       && x.angleDuCreneau('k', { nouveaute: 'x', retour: true, lead: '' }, { jours: {} }).startsWith('reminder:'), 'une nouveaute : le ton « new », un retour : « reminder »');
    {
      const j = { jours: {} }; let pareils = 0, chiffreSansNombre = 0;
      for (let i = 0; i < 60; i++) {
        const s = { nouveaute: null, lead: i % 2 ? 'SWOGE Bet has 8 things' : 'SWOGE Bet has things' };
        const a = x.angleDuCreneau('c' + i, s, j);
        if (i && a === j.jours['c' + (i - 1)].angle) pareils++;
        if (/^the number/.test(a) && !/\d/.test(s.lead)) chiffreSansNombre++;
        j.jours['c' + i] = { angle: a, id: String(i), quand: new Date(Date.UTC(2026, 11, 1) + i * 6 * 3600e3).toISOString() };
      }
      ok(pareils === 0 && chiffreSansNombre === 0, 'jamais deux fois le meme ton de suite, et « the number » seulement si le fait vedette porte un nombre');
    }
  }

  console.log('   10j. une semaine de posts contre de faux serveurs');
  {
    fs.readdirSync(VOL).forEach((f) => { if (f === 'x_posts.json') fs.unlinkSync(path.join(VOL, f)); });
    Object.assign(process.env, { X_CONSUMER_KEY: 'ck', X_CONSUMER_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as', OPENAI_API_KEY: 'ok', ANTHROPIC_API_KEY: 'ak',
                                 X_HEURES: H4.join(','), X_FUSEAU: 'America/New_York', X_ANNONCE: '0' });
    const demandes = [], tweets = [], juges = []; let k = 0; let kDollar = -1;
    /* Trois creneaux recoivent un texte fautif : un mot interdit, un nombre invente, un texte qui ne nomme rien.
       Un quatrieme (relecture du 11/10, mutation V07), sur un creneau qui porte $SWOGE : le faux nom
       « $SWOGE Bet » / « $SWOGE World », qui doit partir corrige. Les autres textes portent deux mots
       de l alphabet radio : jamais deux fois le meme (un doublon part en reserve, voir reserveDe). */
    const FAUTIF = { 3: (nom) => `${nom} now has live betting 🔥`, 7: (nom) => `${nom} has 777 players already 🚀`, 11: () => 'The dog is built different 🐕💪' };
    const RADIO = ['alfa', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima'];
    const faux = async (url, o) => {
      const u = String(url); const corps = o && o.body ? JSON.parse(o.body) : null;
      const rep = (statut, j) => ({ ok: statut < 300, status: statut, json: async () => j, text: async () => JSON.stringify(j) });
      if (/chat\/completions/.test(u)) return rep(200, { choices: [{ message: { content: '{"hands": false, "why": "paws"}' } }] });
      if (/openai/.test(u)) return rep(200, { data: [{ b64_json: Buffer.from('PNG').toString('base64') }] });
      if (/anthropic/.test(u) && corps.system === x.SYSTEME_JUGE) { juges.push(corps.messages[0].content); return rep(200, { content: [{ type: 'text', text: '{"ok": true, "claim": ""}' }] }); }
      if (/anthropic/.test(u)) {
        const d = corps.messages[0].content; demandes.push(d);
        const nom = (/^PRODUCT: (.+?) \(name it/m.exec(d) || [])[1];
        let texte = FAUTIF[k] ? FAUTIF[k](nom) : `${nom} is built different, the pack knows ${RADIO[k % 12]} ${RADIO[Math.floor(k / 12)]} 🐕`;
        if (!FAUTIF[k] && kDollar < 0 && k > 11 && /^TICKER: include/m.test(d) && /^SWOGE (Bet|World)$/.test(nom)) { kDollar = k; texte = `$${nom}: odds, quests, the pack ${RADIO[k % 12]} 🐕`; }
        k++;
        return rep(200, { content: [{ type: 'text', text: texte }] });
      }
      if (/media\/upload/.test(u)) return rep(200, { data: { id: 'm1' } });
      if (/2\/tweets/.test(u)) { tweets.push(corps.text); return rep(201, { data: { id: String(8000 + tweets.length) } }); }
      throw new Error('url inattendue ' + u);
    };
    const resultats = [];
    for (let d = 0; d < 7; d++) for (const h of H4) {
      const jour = jourPlus('2026-10-12', d);
      resultats.push(await x.tache({ maintenant: instantDe(jour, h), prendre: faux, deps: { game: { classementMonde: () => ({ vivants: 3 }), boulierPotStr: () => '0' } } }));
    }
    eq(resultats.filter((r) => r.etat === 'poste').length, 28, 'vingt-huit creneaux, vingt-huit posts');
    const j = x.litJournal();
    const entrees = Object.keys(j.jours).sort().map((c) => Object.assign({ cle: c }, j.jours[c]));
    const tousTextes = new Set([].concat(...x.PRODUITS.map((p) => p.faits.map((f) => f.texte))).concat(x.NOUVEAUTES.map((v) => v.texte)));
    ok(entrees.length === 28 && entrees.every((e) => P(e.produit) && (e.nouveaute ? x.NOUVEAUTES.find((v) => v.id === e.nouveaute).produit === e.produit : Number.isInteger(e.rang))),
       'chaque creneau de la semaine parle d un produit, garde au journal (produit, et sa nouveaute ou son rang)');
    ok(demandes.length === 28 && demandes.every((d) => /^PRODUCT: .+ \(name it exactly like this, once\)$/m.test(d)
       && tousTextes.has((/^LEAD FACT \(the post is built on this one\): (.+)$/m.exec(d) || [])[1])),
       'chaque demande nomme le produit et donne un fait vedette pris mot pour mot dans le catalogue');
    ok(tweets.length === 28 && tweets.every((t, i) => P(entrees[i].produit).motsCles.test(t)), 'chaque tweet parti nomme son produit');
    ok(entrees.every((e, i) => i === 0 || e.produit !== entrees[i - 1].produit), 'jamais deux tweets de suite sur le meme produit');
    ok(entrees.every((e) => P(e.produit).scenes.includes(e.scene)), 'chaque image est une scene de son produit');
    const refuses = entrees.filter((e) => e.refus);
    ok(refuses.length === 3 && /interdit/.test(refuses[0].refus) && /777/.test(refuses[1].refus) && /ne nomme pas/.test(refuses[2].refus),
       'les trois textes fautifs (mot interdit, nombre invente, produit absent) sont refuses, et le journal dit pourquoi');
    ok(refuses.every((e) => e.via === 'reserve' && !/live betting|777|built different/.test(e.texte) && P(e.produit).motsCles.test(e.texte)),
       'a leur place part une reserve vraie du meme produit');
    ok(entrees.filter((e) => !e.refus).every((e) => e.via === 'modele'), 'les autres textes du modele partent tels quels (nettoyes)');
    /* Le second regard (seconde relecture du 11/10) : chaque texte qui a passe les listes est relu, avec
       les MEMES faits que l auteur, et tel qu il partira ; un texte refuse par les listes ne l est pas. */
    const relus = entrees.filter((e) => !e.refus);
    ok(juges.length === relus.length && relus.every((e, i) => juges[i].endsWith('\n\nPOST:\n' + e.texte)
       && juges[i].includes('\nFACTS:\n- ' + ((/^LEAD FACT \(the post is built on this one\): (.+)$/m.exec(demandes[entrees.indexOf(e)]) || [])[1] || '\u0000'))),
       'chaque texte du modele qui a passe les listes est relu une fois (' + juges.length + '), avec le fait vedette de sa demande et tel qu il part');
    ok(!demandes.some((d) => /characters are alive|Boulier progressive jackpot/.test(d)), 'trois personnages vivants, une cagnotte vide : rien de vivant dans les demandes');
    const DOMAINE = /\b[a-z0-9-]+\.(dog|fun|com|io|xyz|ai|net|org|app|gg|tv|me|co|so|fi)\b/i;
    ok(tweets.every((t) => !/https?:/.test(t) && !DOMAINE.test(t)), 'aucun lien sans X_LIEN, ni adresse ni domaine nu (X en ferait un lien)');
    const genres = entrees.map((e, i) => [e, (/^KIND: (.+)$/m.exec(demandes[i]) || [])[1] || '']);
    ok(genres.every(([e, g]) => (e.retour ? /^REMINDER .*never say "new today"/.test(g) : e.nouveaute ? /^NEW UPDATE, shipped in the last few days/.test(g) : g === 'one of our products'))
       && genres.some(([e]) => e.retour),
       'la demande dit le genre du creneau : produit, nouveaute, ou rappel (« never say new today ») — le casino en $SWOGEBET revient en rappel le 18/10');
    /* Relecture du 11/10 : aucune date en chiffres dans une demande produit (« New since Oct 8 » se
       faisait refuser) ; le jour de la semaine seulement. */
    ok(demandes.every((d) => /^Day: (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/m.test(d) && !/\b20\d\d-\d\d-\d\d\b/.test(d)),
       'aucune date en chiffres dans les demandes : « Day: Monday », jamais « 2026-10-08 »');
    ok(demandes.filter((d) => /^Other true facts about it \(use one at most, or none\):\n- /m.test(d)).length >= 24, 'les demandes donnent les faits voisins (« Other true facts »)');
    /* V07 : le faux nom colle au ticker part corrige, par le modele, sans refus. */
    const eDollar = entrees[kDollar] || {};
    ok(kDollar > 0 && eDollar.via === 'modele' && !eDollar.refus && /\$SWOGE\b/.test(tweets[kDollar]) && !/\$SWOGE (Bet|World|Wallet|AI|Agents|casino)\b/i.test(tweets[kDollar]),
       '« $SWOGE Bet » ecrit par le modele sur un creneau a cashtag part en « SWOGE Bet », le cashtag a part : ' + (tweets[kDollar] || '').slice(0, 60));
    /* J07 : ce que tache rend est ce que le journal garde. */
    ok(resultats.every((r, i) => r.produit === entrees[i].produit && r.nouveaute === (entrees[i].nouveaute || null) && r.via === entrees[i].via),
       'tache rend le produit, la nouveaute et la voie (modele ou reserve) que le journal garde');
    const dd = x.derniere();
    ok(dd.derniere.produit && dd.recents.every((r) => r.produit), '/x/derniere dit le produit de chaque post');

    /* Les chiffres vivants, de bout en bout (relecture du 11/10, mutations L12, L14) : tache passe ses
       `deps` a instantane, et la demande les donne. Deux creneaux dont le sujet est deja au journal
       (SWOGE World, le casino) ; le second recoit un nombre invente, refuse. */
    const jv = x.litJournal();
    jv.jours['2026-10-19#09:00'] = { produit: 'world', fait: 'monde', rang: 1, essais: 0 };
    jv.jours['2026-10-19#12:30'] = { produit: 'casino', fait: 'salle', rang: 2, essais: 0 };
    fs.writeFileSync(path.join(VOL, 'x_posts.json'), JSON.stringify(jv));
    FAUTIF[k + 1] = (nom) => `${nom}: 999 games tonight 🎰`;
    const riches = { game: { classementMonde: () => ({ vivants: 40 }), boulierPotStr: () => '500' } };
    const rW = await x.tache({ maintenant: instantDe('2026-10-19', '09:00'), prendre: faux, deps: riches });
    const dW = demandes[demandes.length - 1];
    const rC = await x.tache({ maintenant: instantDe('2026-10-19', '12:30'), prendre: faux, deps: riches });
    const dC = demandes[demandes.length - 1];
    ok(rW.etat === 'poste' && /^Live right now \(read seconds ago; quote exactly or not at all\):\n- 40 characters are alive on the SWOGE World leaderboard right now\.$/m.test(dW),
       'SWOGE World : la demande porte « Live right now » et les 40 personnages vivants lus par tache');
    ok(rC.etat === 'poste' && /^- The Boulier progressive jackpot in the SWOGE casino stands at 500 \$SWOGE right now\.$/m.test(dC), 'le casino : la cagnotte de 500 lue a l instant');
    const jC = x.litJournal().jours['2026-10-19#12:30'];
    const vueC = x.derniere().derniere;
    ok(jC.refus && /999/.test(jC.refus) && vueC.cle === '2026-10-19#12:30' && vueC.refus === jC.refus && vueC.via === 'reserve' && rC.via === 'reserve',
       '/x/derniere montre le refus et la voie du dernier creneau, comme le journal : ' + vueC.refus);
    /* Jamais deux fois le meme texte (relecture du 11/10) : le modele recopie le tweet de 12:30 sur un
       autre creneau du casino. Refuse (X refuserait le doublon), et la reserve qui part a sa place
       n est pas celle deja postee a 12:30. */
    const jd = x.litJournal();
    jd.jours['2026-10-19#17:00'] = { produit: 'casino', fait: 'joueurs', rang: 8, essais: 0 };
    fs.writeFileSync(path.join(VOL, 'x_posts.json'), JSON.stringify(jd));
    const avant1230 = tweets[tweets.length - 1];
    FAUTIF[k] = () => avant1230.replace(/\s*\$SWOGE\b|\s*#RobinhoodChain\b/g, '');
    const rD = await x.tache({ maintenant: instantDe('2026-10-19', '17:00'), prendre: faux, deps: riches });
    const eD = x.litJournal().jours['2026-10-19#17:00'];
    const empreintes = tweets.map((t) => x.empreinte(t));
    ok(rD.etat === 'poste' && eD.refus === 'texte deja poste' && eD.via === 'reserve' && new Set(empreintes).size === empreintes.length,
       'un texte du modele deja poste est refuse, et la reserve choisie n est pas un doublon : ' + tweets.length + ' tweets, tous differents');
  }

  console.log('   10k. un journal d avant le 11/10 se relit');
  {
    fs.writeFileSync(path.join(VOL, 'x_posts.json'), JSON.stringify({
      jours: { '2026-09-18': { scene: 'course', id: '1', quand: '2026-09-18T16:47:00.000Z', texte: 'old' },
               '2026-10-10#20:30': { scene: 'stade', angle: 'pure hype: two or three punchy lines about momentum and conviction, nothing else', texte: 'old vibes', id: '99',
                                     quand: '2026-10-11T00:31:00.000Z', rendu: 1, cadrage: 2, via: 'modele' },
               '2026-10-11#09:00': { scene: 'lune', angle: 'humor: a joke about the very buff dog, self-aware meme energy', image: '2026-10-11_09_00.png', essais: 1, erreur: 'X 403' } },
      annonces: { 'wallet-design': { cle: '2026-10-04#09:00', id: '7777' } } }));
    const j = x.litJournal();
    ok(j.jours['2026-09-18#12:00'] && j.jours['2026-10-10#20:30'], 'les anciennes cles se lisent (et celle du premier jour reste le creneau de midi)');
    const d = x.derniere();
    ok(d.derniere && d.derniere.produit === null && d.recents.length === 2 && d.recents.every((r) => r.produit === null), '/x/derniere les montre, sans produit');
    const c = x.choixSujet('2026-12-01#09:00', j, instantDe('2026-12-01', '09:00'), { vivant: {} });
    ok(c.produit === 'bet' && c.rang === 0, 'sans rang dans le journal, la rotation repart de SWOGE Bet');
    const appels = [];
    const faux = async (url, o) => {
      const u = String(url); appels.push(u); const corps = o && o.body ? JSON.parse(o.body) : null;
      const rep = (statut, jj) => ({ ok: statut < 300, status: statut, json: async () => jj });
      if (/chat\/completions/.test(u)) return rep(200, { choices: [{ message: { content: '{"hands": false}' } }] });
      if (/openai/.test(u)) return rep(200, { data: [{ b64_json: Buffer.from('PNG').toString('base64') }] });
      if (/anthropic/.test(u) && corps.system === x.SYSTEME_JUGE) return rep(200, { content: [{ type: 'text', text: '{"ok": true}' }] });
      if (/anthropic/.test(u)) { const nom = (/^PRODUCT: (.+?) \(name it/m.exec(corps.messages[0].content) || [])[1]; return rep(200, { content: [{ type: 'text', text: nom + ' says gm 🐕' }] }); }
      if (/media\/upload/.test(u)) return rep(200, { data: { id: 'm1' } });
      if (/2\/tweets/.test(u)) return rep(201, { data: { id: '9001' } });
      throw new Error('url inattendue ' + u);
    };
    const r = await x.tache({ maintenant: instantDe('2026-10-11', '09:00'), prendre: faux });
    const e = x.litJournal().jours['2026-10-11#09:00'];
    /* Relecture du 11/10 : l angle d avant (« humor: a joke about the very buff dog… ») n est plus un ton
       du catalogue ; donne comme TONE a un creneau produit, un ancien angle (« teaser: hint at what is
       coming next ») pousserait vers ce qui n est pas sorti. Le texte n etant pas ecrit, il est remplace ;
       la scene, elle, est gardee (son image est payee). */
    ok(r.etat === 'poste' && x.produitDe(e.produit) && e.scene === 'lune' && x.ANGLES.some((a) => a.a === e.angle) && !/^humor: a joke/.test(e.angle) && x.produitDe(e.produit).motsCles.test(e.texte),
       'un creneau d avant, rate et repris : il recoit un produit, garde sa scene (image payee), prend un ton d aujourd hui, et poste (' + e.produit + ')');
    /* Un creneau d apres, rate (refus de X) : sa reprise parle du MEME sujet, meme si le choix du moment serait un autre. */
    const jj = x.litJournal();
    jj.jours['2026-12-02#09:00'] = { produit: 'cinema', fait: 'episodes', rang: 7, scene: 'popcorn', angle: x.TONS_PRODUIT[0].a, essais: 1, erreur: 'X 403',
                                     texte: 'SWOGE AI Cinema has 14 episodes across 3 series 🍿' };
    fs.writeFileSync(path.join(VOL, 'x_posts.json'), JSON.stringify(jj));
    const r2 = await x.tache({ maintenant: Date.parse('2026-12-02T14:05:00Z'), prendre: faux });
    const e2 = x.litJournal().jours['2026-12-02#09:00'];
    ok(r2.etat === 'poste' && e2.produit === 'cinema' && e2.fait === 'episodes' && e2.rang === 7 && r2.texte === 'SWOGE AI Cinema has 14 episodes across 3 series 🍿'
       && e2.scene === 'popcorn' && e2.angle === x.TONS_PRODUIT[0].a,
       'un creneau rate puis repris garde son sujet (produit, fait, rang), sa scene meme sans image encore faite, son ton et son texte : le journal decide, pas le choix du moment');
  }

  console.log('   10l. le second regard, et les textes faux connus (seconde relecture du 11/10)');
  {
    const avant = { a: process.env.ANTHROPIC_API_KEY, j: process.env.X_JUGE, l: process.env.X_LIEN };
    process.env.ANTHROPIC_API_KEY = 'ak'; delete process.env.X_JUGE; delete process.env.X_LIEN;
    const sB = x.sujetDe({ produit: 'bet', fait: 'carnet' }, {});
    const tags = x.etiquettes('k', x.env().heures);
    const VRAI = 'SWOGE Bet: real fixtures, odds locked when you tap. Built different 🐕';
    /* Un faux modele : l auteur ecrit `texte`, le juge repond `verdict` (un texte, un statut HTTP ou une panne). */
    const essai = async (verdict, texte) => {
      const vus = [];
      const f = async (u, req) => {
        const c = JSON.parse(req.body); vus.push(c);
        if (c.system === x.SYSTEME_JUGE) {
          if (verdict instanceof Error) throw verdict;
          if (typeof verdict === 'number') return { ok: false, status: verdict, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: verdict }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: texte || VRAI }] }) };
      };
      return { r: await x.ecritTexte([], { scene: { prompt: 's' }, cle: 'k', sujetProduit: sB, postes: [] }, f), vus };
    };
    const estReserve = (r) => r.via === 'reserve' && sB.reserves.some((t) => x.nettoie(t, false, tags) === r.texte);
    let e = await essai('{"ok": true, "claim": ""}');
    const dj = (e.vus[1] || { messages: [{}] }).messages[0].content || '';
    ok(e.r.via === 'modele' && e.vus.length === 2 && e.vus[1].system === x.SYSTEME_JUGE && dj.includes('\nFACTS:\n- ' + sB.lead)
       && sB.autres.every((t) => dj.includes('\n- ' + t)) && dj.endsWith('\n\nPOST:\n' + e.r.texte),
       'un oui franc du second regard : le texte part, et le juge a vu les MEMES faits que l auteur et le texte tel qu il part');
    const fuites = [];
    for (const [nom, v] of [['un non', '{"ok": false, "claim": "the vault is insured"}'], ['un oui sans JSON', 'Yes, all good'], ['« true » en texte', '{"ok": "true"}'],
      ['un JSON casse', '{"ok": tru'], ['HTTP 529', 529], ['une panne reseau', new Error('ECONNRESET')]]) {
      e = await essai(v);
      if (!estReserve(e.r) || !/^juge/.test(e.r.refus || '')) fuites.push(nom + ' : ' + e.r.via + ' ' + (e.r.refus || ''));
    }
    ok(fuites.length === 0, 'tout ce qui n est pas un oui franc (un non, un oui sans JSON, « true » en texte, un JSON casse, HTTP 529, une panne reseau) poste une reserve du produit, la raison commence par « juge »'
       + (fuites.length ? ' — ' + fuites.join(' | ') : ''));
    e = await essai('{"ok": false, "claim": "the vault is insured"}');
    eq(e.r.refus, 'juge : the vault is insured', 'le journal garde ce que le juge a refuse');
    e = await essai('{"ok": true}', 'SWOGE Bet now has live betting 🔥');
    ok(estReserve(e.r) && e.vus.length === 1 && /mot interdit/.test(e.r.refus), 'un texte refuse par les listes ne va pas au juge (un appel de moins)');
    process.env.X_JUGE = '0';
    e = await essai('{"ok": false}');
    ok(e.r.via === 'modele' && e.vus.length === 1, 'X_JUGE=0 eteint le second regard (les listes restent)');
    delete process.env.X_JUGE;

    /* Les textes faux connus : les 248 de la seconde relecture du 11/10 et 103 ecrits ensuite, sans les
       5 qui n etaient pas faux ou que seul le juge attrape (une URL que nettoie retire ; « take the jackpot
       home » et « free to play », vrais ; « extra time counts », un sens inverse, et « hold BTC and SOL »,
       laisses au second regard). Chacun doit etre refuse par les listes SANS le juge ; et des textes
       vrais du ton attendu doivent passer (7 de 63 etaient refuses le 11/10 : « every slip », « only »,
       « top », « No surprises », « first » x2… — un refus de trop poste une reserve vraie, il ne ment pas). */
    const vT = { bet: { sixGrands: true, dixSept: true, auto: true } };
    const lit = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'essais', 'x_post', f), 'utf8'));
    const sujetCas = ([c, f]) => x.sujetDe(f.startsWith('N:') ? { produit: c, nouveaute: f.slice(2) } : { produit: c, fait: f }, vT);
    const passe = (cas) => x.verifieTexte(x.nettoie(x.corrigeNoms(cas[2]), false, { ticker: false, hashtag: false }), sujetCas(cas)).ok;
    const FAUX_CONNUS = lit('faux.json'), VRAIS_CONNUS = lit('vrais.json');
    const fuitent = FAUX_CONNUS.filter(passe), refusesV = VRAIS_CONNUS.filter((c) => !passe(c));
    ok(FAUX_CONNUS.length >= 346 && fuitent.length === 0, FAUX_CONNUS.length + ' textes faux connus, tous refuses par les listes, sans le second regard'
       + (fuitent.length ? ' — passent : ' + fuitent.map((c) => c[2]).join(' | ') : ''));
    ok(VRAIS_CONNUS.length >= 56 && refusesV.length === 0, VRAIS_CONNUS.length + ' textes vrais du ton attendu, tous acceptes : les listes ne refusent pas tout'
       + (refusesV.length ? ' — refuses : ' + refusesV.map((c) => c[2] + ' (' + x.verifieTexte(x.nettoie(x.corrigeNoms(c[2]), false, { ticker: false, hashtag: false }), sujetCas(c)).raison + ')').join(' | ') : ''));
    if (avant.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = avant.a;
    if (avant.j !== undefined) process.env.X_JUGE = avant.j;
    if (avant.l !== undefined) process.env.X_LIEN = avant.l;
  }
  delete process.env.X_ANNONCE;

  nettoieVol();
  console.log(`\nx_post.test.js : ${n} verifications OK`);
})().catch((e) => { nettoieVol(); console.error('  RATE ' + (e.message || e)); console.log(`x_post.test.js : RATES : 1/${n + 1}`); process.exit(1); });
