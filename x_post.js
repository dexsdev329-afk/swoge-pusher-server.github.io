'use strict';
/*
 * ==================== LE POST QUOTIDIEN SUR X ====================
 *
 * ---- pourquoi ce fichier existe ----
 *
 * « Une image par jour avec SWOGE, differente, et un post bullish, que
 * j automatise. » Chaque jour a l heure dite : une scene tiree d une banque
 * (jamais la meme deux jours de suite), une image generee par l API d images
 * d OpenAI, un texte court ecrit par un modele a partir de ce que le site
 * fait VRAIMENT ce jour-la (rencontres ouvertes, sports, salles du Nexus),
 * puis l envoi sur X en deux appels : l image, le post. Une copie part sur
 * le Telegram, le journal reste sur le volume.
 *
 * ---- ce que ca coute, mesure le 18 septembre 2026 ----
 *
 *  - l image : 6 893 jetons de sortie pour une 1536x1024 en qualite high
 *    avec gpt-image-1.5, a 32 $ le million → environ 0,22 $ ;
 *  - le texte : quelques centaines de jetons, moins d un centime ;
 *  - X, en paiement a l usage : « Post: Create » 0,015 $ SANS lien dans le
 *    texte, 0,200 $ AVEC (grille docs.x.com, meme jour). D ou `X_LIEN` : le
 *    lien ne part que si on le demande, c est treize fois le prix.
 *  Soit environ 7 $ par mois sans lien, 13 $ avec.
 *
 * ---- les verrous ----
 *
 *  - UN post par jour, garde par le journal sur le volume : un redeploiement
 *    en cours de journee ne reposte pas.
 *  - L image est ECRITE SUR LE DISQUE avant l envoi : si X refuse, le
 *    prochain essai reprend la meme image au lieu d en payer une autre.
 *  - Trois essais par jour, pas plus ; au-dela on ecrit pourquoi et on
 *    attend demain. Rien ne boucle sur une cle refusee.
 *  - Sans les cinq cles, le module DIT ce qui manque et ne fait rien.
 *  - Aucune cle ne sort de l environnement : ni dans le journal, ni dans
 *    les reponses, ni dans le depot.
 *
 * ---- l authentification ----
 *
 * OAuth 1.0a « user context », signature HMAC-SHA1, sans dependance : c est
 * ce que la console X donne pour un compte (cle consommateur + jeton
 * d acces, permissions Read and Write). L implementation est verifiee dans
 * `x_post.test.js` contre l exemple chiffre de la documentation de X, au
 * caractere pres — une signature fausse ne se debogue pas a l oeil.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const API = 'https://api.x.com';
const LIEN = 'https://swoleeswoge.dog';
const CLES = ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'OPENAI_API_KEY'];

function env() {
  return {
    ck: process.env.X_CONSUMER_KEY || '', cs: process.env.X_CONSUMER_SECRET || '',
    at: process.env.X_ACCESS_TOKEN || '', as: process.env.X_ACCESS_SECRET || '',
    openai: process.env.OPENAI_API_KEY || '', anthropic: process.env.ANTHROPIC_API_KEY || '',
    heure: process.env.X_HEURE || '16:00',              // UTC — 18 h a Paris l ete
    lien: process.env.X_LIEN === '1',
    qualite: process.env.X_QUALITE || 'high',
    modeleImage: process.env.X_MODELE_IMAGE || 'gpt-image-1.5',
    modeleTexte: process.env.X_MODELE_TEXTE || 'claude-sonnet-5',
    compte: process.env.X_COMPTE || 'SwoleDogeSwoge',
    domaine: process.env.RAILWAY_PUBLIC_DOMAIN || '',
  };
}
/** Les variables absentes, par leur nom : c est ce qu on montre, jamais leur valeur. */
function manque() { return CLES.filter((k) => !process.env[k]); }
function enabled() { return manque().length === 0; }

// ------------------------------------------------------------ OAuth 1.0a

/* RFC 3986 : `encodeURIComponent` laisse passer ! ' ( ) *, OAuth non. */
const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * L en-tete Authorization d une requete signee. `params` sont les parametres
 * de requete ou de formulaire qui entrent dans la signature — pour un corps
 * JSON, aucun. `opts.nonce` et `opts.timestamp` ne servent qu aux essais.
 */
function signeOAuth(methode, url, params, cles, opts) {
  const o = opts || {};
  const oauth = {
    oauth_consumer_key: cles.ck,
    oauth_nonce: o.nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(o.timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: cles.at,
    oauth_version: '1.0',
  };
  const tous = Object.assign({}, params || {}, oauth);
  const paires = Object.keys(tous).map((k) => [enc(k), enc(tous[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const chaine = paires.map((p) => p[0] + '=' + p[1]).join('&');
  const base = methode.toUpperCase() + '&' + enc(url) + '&' + enc(chaine);
  const cle = enc(cles.cs) + '&' + enc(cles.as);
  oauth.oauth_signature = crypto.createHmac('sha1', cle).update(base).digest('base64');
  const entete = 'OAuth ' + Object.keys(oauth).sort().map((k) => enc(k) + '="' + enc(oauth[k]) + '"').join(', ');
  return { entete, base, signature: oauth.oauth_signature };
}

// ------------------------------------------------------------ les scenes

/* Le personnage, toujours le meme : c est lui qu on reconnait d un jour a
   l autre. La scene change, pas lui. */
const PERSONNAGE = "the famous 'buff Doge' meme character: a Shiba Inu head with a calm, smug expression on an extremely muscular bodybuilder torso, cream and tan fur, painterly digital-art style, wearing a royal blue tank top";
const STYLE = 'Landscape social-media illustration, dark cinematic style of a crypto game poster, deep navy and black background with electric green, gold and blue light, faint circuit traces, gold coins with a paw print floating in the air, high contrast, epic';
const NEGATIF = 'No text, no letters, no numbers, no logos, no watermark.';

const SCENES = [
  { nom: 'stade', prompt: 'standing like a champion with arms crossed in a stadium at night, floodlights, a wall of glowing scoreboards, sports balls of every sport floating around him' },
  { nom: 'arcade', prompt: 'leaning on a glowing retro arcade cabinet in a neon arcade hall, joystick in one paw, tokens raining' },
  { nom: 'casino', prompt: 'at a blackjack table under a golden chandelier, flipping a card with a grin, chips stacked high' },
  { nom: 'lune', prompt: 'planting a flag on the moon in a spacesuit with the visor open, Earth glowing behind, a rocket landed nearby' },
  { nom: 'fusee', prompt: 'riding a rocket through a green candlestick chart shooting upward, cape flying' },
  { nom: 'coffre', prompt: 'opening a giant golden vault door with one paw, light and coins pouring out' },
  { nom: 'chenil', prompt: 'kneeling with three adorable Shiba puppies at his feet next to a cozy dog house with a glowing paw sign' },
  { nom: 'tv', prompt: 'sitting on a couch in front of a wall of glowing TV screens showing sports and movies, remote in paw, popcorn' },
  { nom: 'cinema', prompt: 'walking down a red carpet in front of a grand cinema marquee, paparazzi flashes, sunglasses on' },
  { nom: 'salle', prompt: 'lifting a barbell loaded with giant gold coins in a gym, sweat and sparks' },
  { nom: 'trading', prompt: 'in front of six holographic trading screens with green candles, a coffee mug in one paw, thumbs up' },
  { nom: 'plage', prompt: 'on a tropical beach at sunset on a deck chair, cocktail with a tiny umbrella, a laptop showing a green chart' },
  { nom: 'trone', prompt: 'sitting on a golden throne made of coins in a throne room, crown slightly tilted, relaxed' },
  { nom: 'ring', prompt: 'in a boxing ring with a championship belt over the shoulder, arms raised, crowd of Shiba fans cheering' },
  { nom: 'course', prompt: 'crossing the finish line of a race track in first place, confetti, a checkered flag' },
  { nom: 'mine', prompt: 'in a crystal mine with a pickaxe over the shoulder, a cart full of glowing gold coins' },
  { nom: 'marche', prompt: 'behind a bustling market stall selling glowing potions and golden coins in a fantasy village' },
  { nom: 'portail', prompt: 'stepping through a glowing blue magic portal into a fantasy world, wind in the fur' },
  { nom: 'pluie', prompt: 'standing under a rain of gold coins with an umbrella turned upside down to catch them, laughing' },
  { nom: 'vaisseau', prompt: 'at the captain chair of a starship bridge, stars streaking past the window, one paw on the throttle' },
  { nom: 'foot', prompt: 'on a football pitch at night in a blue kit, ball under one foot, stadium roaring' },
  { nom: 'hockey', prompt: 'on the ice in a hockey rink, stick in paw, puck mid-air, snow spraying' },
  { nom: 'tennis', prompt: 'mid-serve on a floodlit tennis court, racket high, ball tossed, crowd silhouettes' },
  { nom: 'dragon', prompt: 'standing on the head of a friendly golden dragon flying over a neon city at night' },
];

/* Le jour de l annee choisit la scene ; on decale d un cran si c est celle
   d hier (deux jours de suite, le fil ressemble a une panne). */
function sceneDuJour(t, journal) {
  const d = new Date(t);
  const jour = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);
  let i = ((jour * 7) % SCENES.length + SCENES.length) % SCENES.length;
  const hier = jourDe(t - 86400000);
  const prec = journal && journal.jours && journal.jours[hier] && journal.jours[hier].scene;
  if (prec && SCENES[i].nom === prec) i = (i + 1) % SCENES.length;
  return SCENES[i];
}
function promptImage(scene) { return `${STYLE}. In the center, ${PERSONNAGE}, ${scene.prompt}. ${NEGATIF}`; }

// ------------------------------------------------------------ les faits du jour

const NOMS_SPORT = { foot: 'football', tennis: 'tennis', nba: 'NBA', nfl: 'NFL', nhl: 'NHL', mlb: 'MLB', cricket: 'cricket' };
/** Ce qui est vrai AUJOURD HUI sur le site : le texte s appuie dessus, il n invente pas. */
function faitsDuJour(t) {
  const faits = [];
  try {
    const paris = require('./paris');
    const l = paris.ouverts(t || Date.now());
    const parSport = {}; const comps = new Set();
    for (const m of l) { parSport[m.sport] = (parSport[m.sport] || 0) + 1; comps.add(m.competition); }
    const sports = Object.keys(parSport);
    if (l.length) {
      faits.push(`${l.length} matches open right now on SWOGE Bet across ${sports.length} sports (${sports.map((k) => NOMS_SPORT[k] || k).join(', ')}) and ${comps.size} competitions`);
    }
  } catch (e) { /* pas de calendrier : on parle du reste */ }
  faits.push('SWOGE Bet: sports betting paid in $SWOGE, odds on-chain, 7 sports, no signup');
  faits.push('SWOGE Nexus: a 2.5D pixel world with an arcade, a casino, a cinema, SWOGE TV (285 free live channels) and a pet world');
  faits.push('SWOGE Wallet: multi-chain, Solana included, keys stay on your device');
  faits.push('SWOGE is a community-run memecoin (CTO) with a real product shipping every week');
  return faits;
}

// ------------------------------------------------------------ le texte

const SYSTEME = `You write ONE post per day on X for SWOGE ($SWOGE), a community-run memecoin (CTO) with a real crypto game ecosystem.
Voice: bullish, playful, meme energy, confident and fun, never desperate, never rude.
Hard rules: English. Maximum 240 characters. Must contain "$SWOGE". 1 to 3 emojis. At most 2 hashtags. No links. No promises of returns, no "guaranteed", no price targets. Use the facts you are given when they are interesting; never invent numbers. Mention the scene of today's image if it fits.
Output only the post text, nothing else.`;

/* Si le modele ne repond pas, on poste quand meme — avec une phrase de
   reserve, vraie, plutot que de rater le jour. */
const RESERVE = [
  'Another day, another rep. $SWOGE keeps shipping. 💪🐕',
  'Bet, play, stake, repeat. The SWOGE machine never sleeps. 🐕🚀',
  'Seven sports, one dog, zero excuses. $SWOGE Bet is live. 🏟️🐕',
  'Community-run, product-first. That is the $SWOGE way. 🐕💚',
  'The Nexus is open. Arcade, casino, cinema, and a very buff dog. $SWOGE 🎮🐕',
  'We came for the memes. We stayed for the product. $SWOGE 🐕🔥',
  'Strong paws only. $SWOGE 🐕💪',
  'Every day the dog gets bigger. $SWOGE 📈🐕',
];

/** Le texte, rendu presentable et dans les regles, quoi qu ait ecrit le modele. */
function nettoie(brut, lien) {
  let t = String(brut || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  t = t.replace(/https?:\/\/\S+/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (!/\$SWOGE/i.test(t)) t += ' $SWOGE';
  const max = lien ? 280 - (LIEN.length + 1) : 280;
  if (t.length > max) {
    const coupe = (s, m) => { s = s.slice(0, m); return s.slice(0, Math.max(s.lastIndexOf(' '), m - 40)).trim(); };
    t = coupe(t, max);
    if (!/\$SWOGE/i.test(t)) t = coupe(t, max - 7) + ' $SWOGE';
  }
  if (lien) t += '\n' + LIEN;
  return t;
}

async function ecritTexte(faits, scene, t, prendre) {
  const e = env();
  const f = prendre || fetch;
  const jour = new Date(t || Date.now()).toISOString().slice(0, 10);
  if (e.anthropic) {
    try {
      const r = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': e.anthropic, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: e.modeleTexte, max_tokens: 200, system: SYSTEME,
          messages: [{ role: 'user', content: `Date: ${jour}\nToday's image: SWOGE ${scene.prompt}\nFacts:\n- ${faits.join('\n- ')}` }],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const brut = ((j.content || []).find((b) => b.type === 'text') || {}).text || '';
      if (brut.trim()) return { texte: nettoie(brut, e.lien), via: 'modele' };
      throw new Error('reponse vide');
    } catch (err) {
      console.error('[x] texte : le modele n a pas repondu (' + (err.message || err) + '), phrase de reserve');
    }
  }
  const i = Math.floor(Date.parse(jour) / 86400000) % RESERVE.length;
  return { texte: nettoie(RESERVE[i], e.lien), via: 'reserve' };
}

// ------------------------------------------------------------ l image

async function genereImage(prompt, prendre) {
  const e = env();
  const f = prendre || fetch;
  const r = await f('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + e.openai },
    body: JSON.stringify({ model: e.modeleImage, prompt, size: '1536x1024', quality: e.qualite, n: 1, output_format: 'png' }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('image : HTTP ' + r.status + ' ' + ((j.error && j.error.message) || '').slice(0, 120));
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error('image : reponse sans image');
  return { png: Buffer.from(b64, 'base64'), jetons: (j.usage && j.usage.output_tokens) || null };
}

// ------------------------------------------------------------ X

async function appelX(chemin, corps, prendre) {
  const e = env();
  const f = prendre || fetch;
  const url = API + chemin;
  const s = signeOAuth('POST', url, {}, e);          // corps JSON : rien dans la signature
  const r = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: s.entete },
    body: JSON.stringify(corps),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = (j.detail || j.title || (j.errors && j.errors[0] && j.errors[0].message) || '').slice(0, 160);
    throw new Error(`X ${chemin} : HTTP ${r.status}${detail ? ' — ' + detail : ''}`);
  }
  return j;
}
async function televerse(png, prendre) {
  const j = await appelX('/2/media/upload', { media: png.toString('base64'), media_category: 'tweet_image' }, prendre);
  const id = (j.data && (j.data.id || j.data.media_key)) || j.id || j.media_id_string;
  if (!id) throw new Error('X media : reponse sans identifiant');
  return String(id);
}
async function publie(texte, mediaId, prendre) {
  const j = await appelX('/2/tweets', { text: texte, media: { media_ids: [mediaId] } }, prendre);
  const id = j.data && j.data.id;
  if (!id) throw new Error('X tweets : reponse sans identifiant');
  return String(id);
}

// ------------------------------------------------------------ le journal

const FICHIER = () => path.join(cfg.DATA_DIR, 'x_posts.json');
const DOSSIER_IMAGES = () => path.join(cfg.DATA_DIR, 'x_images');
function litJournal() {
  try { return JSON.parse(fs.readFileSync(FICHIER(), 'utf8')) || { jours: {} }; }
  catch (e) { return { jours: {} }; }
}
function ecritJournal(j) {
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.writeFileSync(FICHIER(), JSON.stringify(j, null, 1));
}
function jourDe(t) { return new Date(t).toISOString().slice(0, 10); }
function heureAtteinte(t, heure) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(heure || '');
  if (!m) return true;
  const d = new Date(t);
  return d.getUTCHours() * 60 + d.getUTCMinutes() >= Number(m[1]) * 60 + Number(m[2]);
}
/* Trente images gardees : de quoi relire un mois, pas de quoi remplir le volume. */
function purgeImages() {
  try {
    const l = fs.readdirSync(DOSSIER_IMAGES()).filter((f) => /\.png$/.test(f)).sort();
    for (const f of l.slice(0, Math.max(0, l.length - 30))) fs.unlinkSync(path.join(DOSSIER_IMAGES(), f));
  } catch (e) { /* dossier absent */ }
}
/** Ce que le serveur montre sur /x/derniere : le journal sans rien de secret. */
function derniere() {
  const j = litJournal();
  const jours = Object.keys(j.jours).sort();
  const d = jours[jours.length - 1];
  if (!d) return { actif: enabled(), manque: manque(), heure: env().heure, derniere: null };
  const e = j.jours[d];
  return { actif: enabled(), manque: manque(), heure: env().heure,
           derniere: { jour: d, scene: e.scene, texte: e.texte, id: e.id || null, essais: e.essais || 0, erreur: e.erreur || null,
                       via: e.via || null, image: e.image ? '/x/image/' + d + '.png' : null,
                       url: e.id ? `https://x.com/${env().compte}/status/${e.id}` : null } };
}

// ------------------------------------------------------------ la tache

let enCours = false;
/**
 * Un tour. Rend un etat lisible : inactif · attend · deja · abandon · poste · rate.
 * `opts.maintenant` et `opts.prendre` (un faux fetch) servent aux essais ;
 * `opts.force` ignore l heure — pour `--publie`, pas pour le serveur.
 */
async function tache(opts) {
  const o = opts || {};
  const t = o.maintenant || Date.now();
  if (!enabled()) return { etat: 'inactif', manque: manque() };
  const e = env();
  const jour = jourDe(t);
  const journal = litJournal();
  const entree = journal.jours[jour] || { essais: 0 };
  if (entree.id) return { etat: 'deja', id: entree.id };
  if (!o.force && !heureAtteinte(t, e.heure)) return { etat: 'attend', heure: e.heure };
  if (entree.essais >= 3) return { etat: 'abandon', erreur: entree.erreur };
  if (enCours) return { etat: 'en cours' };
  enCours = true;
  try {
    const scene = entree.scene ? SCENES.find((s) => s.nom === entree.scene) || sceneDuJour(t, journal) : sceneDuJour(t, journal);
    entree.scene = scene.nom;
    /* L image d abord, sur le disque : un refus de X plus loin ne la fait
       pas payer deux fois. */
    fs.mkdirSync(DOSSIER_IMAGES(), { recursive: true });
    const fichierImage = path.join(DOSSIER_IMAGES(), jour + '.png');
    let png;
    if (entree.image && fs.existsSync(fichierImage)) png = fs.readFileSync(fichierImage);
    else {
      const g = await genereImage(promptImage(scene), o.prendre);
      png = g.png; fs.writeFileSync(fichierImage, png);
      entree.image = jour + '.png'; entree.jetonsImage = g.jetons;
      journal.jours[jour] = entree; ecritJournal(journal);
    }
    if (!entree.texte) {
      const r = await ecritTexte(faitsDuJour(t), scene, t, o.prendre);
      entree.texte = r.texte; entree.via = r.via;
      journal.jours[jour] = entree; ecritJournal(journal);
    }
    const mediaId = await televerse(png, o.prendre);
    const id = await publie(entree.texte, mediaId, o.prendre);
    entree.id = id; entree.quand = new Date(t).toISOString(); delete entree.erreur;
    journal.jours[jour] = entree; ecritJournal(journal);
    purgeImages();
    console.log(`[x] poste ${jour} · scene ${scene.nom} · https://x.com/${e.compte}/status/${id}`);
    if (o.signale) { try { o.signale({ jour, texte: entree.texte, id, image: e.domaine ? `https://${e.domaine}/x/image/${jour}.png` : null, url: `https://x.com/${e.compte}/status/${id}` }); } catch (x) { /* le Telegram ne fait pas rater le post */ } }
    return { etat: 'poste', id, texte: entree.texte, scene: scene.nom };
  } catch (err) {
    entree.essais = (entree.essais || 0) + 1;
    entree.erreur = String(err && err.message || err).slice(0, 200);
    journal.jours[jour] = entree; ecritJournal(journal);
    console.error(`[x] rate (${entree.essais}/3) : ${entree.erreur}`);
    return { etat: 'rate', essais: entree.essais, erreur: entree.erreur };
  } finally {
    enCours = false;
  }
}

/** Dans le serveur : un regard toutes les cinq minutes, le journal decide. */
function planifie(signale) {
  if (!enabled()) {
    console.log('[x] post quotidien ETEINT : il manque ' + manque().join(', '));
    return null;
  }
  console.log(`[x] post quotidien ARME a ${env().heure} UTC`);
  const tour = () => tache({ signale }).catch((e) => console.error('[x] ' + (e.message || e)));
  const premier = setTimeout(tour, 120000);
  const minuterie = setInterval(tour, 5 * 60000);
  return { arrete() { clearTimeout(premier); clearInterval(minuterie); } };
}

module.exports = { enabled, manque, env, enc, signeOAuth, SCENES, sceneDuJour, promptImage, faitsDuJour,
                   nettoie, ecritTexte, genereImage, televerse, publie, tache, planifie, derniere,
                   heureAtteinte, jourDe, litJournal, DOSSIER_IMAGES, RESERVE };

// ------------------------------------------------------------ en ligne de commande

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    if (a.includes('--essai')) {
      /* Image + texte, RIEN n est poste : pour voir a quoi ca ressemble. Coute l image. */
      if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY absente'); process.exit(1); }
      const t = Date.now(); const scene = sceneDuJour(t, litJournal());
      console.log('scene :', scene.nom);
      const g = await genereImage(promptImage(scene));
      const sortie = path.resolve(a[a.indexOf('--essai') + 1] && !a[a.indexOf('--essai') + 1].startsWith('--') ? a[a.indexOf('--essai') + 1] : '_x_essai.png');
      fs.writeFileSync(sortie, g.png);
      console.log('image :', sortie, '·', g.jetons, 'jetons');
      const r = await ecritTexte(faitsDuJour(t), scene, t);
      console.log('texte (' + r.via + ') :\n' + r.texte);
      return;
    }
    if (a.includes('--publie')) {
      const r = await tache({ force: true });
      console.log(JSON.stringify(r, null, 1));
      process.exit(r.etat === 'poste' || r.etat === 'deja' ? 0 : 1);
    }
    console.log('usage : --essai [fichier.png]  (image + texte, sans poster) | --publie  (poste maintenant, une fois par jour)');
    console.log('cles :', enabled() ? 'toutes presentes' : 'il manque ' + manque().join(', '));
  })().catch((e) => { console.error(e.message || e); process.exit(1); });
}
