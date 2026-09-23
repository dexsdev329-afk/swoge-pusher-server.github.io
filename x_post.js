'use strict';
/*
 * ==================== LES POSTS QUOTIDIENS SUR X ====================
 *
 * ---- pourquoi ce fichier existe ----
 *
 * « Une image par jour avec SWOGE, differente, et un post bullish, que
 * j automatise. » Puis : « deux posts par jour, midi et minuit, des textes
 * et des images differents a chaque fois. » Porte a vingt-quatre creneaux le
 * 23 septembre 2026 (un par heure, 00:00 a 23:00), a la demande du
 * proprietaire, pour un compte le plus actif possible.
 * A chaque creneau : une scene
 * tiree d une banque (jamais une des six dernieres), une image generee par
 * l API d images d OpenAI, un texte court ecrit par un modele sous un ANGLE
 * qui tourne (hype, chiffres, humour, communaute…) a partir de ce que le
 * site fait VRAIMENT ce jour-la, puis l envoi sur X en deux appels : l image,
 * le post. Une copie part sur le Telegram, le journal reste sur le volume.
 *
 * ---- ce que ca coute, mesure le 18 septembre 2026 ----
 *
 *  - l image : 6 893 jetons de sortie pour une 1536x1024 en qualite high
 *    avec gpt-image-1.5, a 32 $ le million → environ 0,22 $ ;
 *  - le texte : quelques centaines de jetons, moins d un centime ;
 *  - X, en paiement a l usage : « Post: Create » 0,015 $ SANS lien dans le
 *    texte, 0,200 $ AVEC (grille docs.x.com, meme jour). D ou `X_LIEN` : le
 *    lien ne part que si on le demande, c est treize fois le prix.
 *  Deux posts par jour : environ 14 $ par mois sans lien, 26 $ avec.
 *
 * ---- les verrous ----
 *
 *  - UN post par creneau, garde par le journal sur le volume : un
 *    redeploiement en cours de journee ne reposte pas.
 *  - L image est ECRITE SUR LE DISQUE avant l envoi : si X refuse, le
 *    prochain essai reprend la meme image au lieu d en payer une autre.
 *  - Trois essais par creneau, pas plus ; au-dela on ecrit pourquoi et on
 *    attend le suivant. Rien ne boucle sur une cle refusee.
 *  - Sans les cinq cles, le module DIT ce qui manque et ne fait rien.
 *  - Aucune cle ne sort de l environnement : ni dans le journal, ni dans
 *    les reponses, ni dans le depot.
 *
 * ---- l heure ----
 *
 * Les creneaux sont donnes dans le fuseau du proprietaire (`X_FUSEAU`,
 * Europe/Paris) : un par heure, ces heures a Paris,
 * ete comme hiver, sans recalcul a la main au changement d heure.
 *
 * ---- l authentification ----
 *
 * OAuth 1.0a « user context », signature HMAC-SHA1, sans dependance : c est
 * ce que la console X donne pour un compte (cle consommateur + jeton
 * d acces, permissions Read and Write). L implementation est verifiee dans
 * `x_post.test.js` contre l exemple chiffre de la documentation de X, au
 * caractere pres. Premiere execution en service le 18 septembre 2026 :
 * 403 tant que le jeton avait ete genere en « Lire » ; poste des le jeton
 * regenere en « Lire et ecrire ».
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
    heures: String(process.env.X_HEURES || process.env.X_HEURE || '00:00,01:00,02:00,03:00,04:00,05:00,06:00,07:00,08:00,09:00,10:00,11:00,12:00,13:00,14:00,15:00,16:00,17:00,18:00,19:00,20:00,21:00,22:00,23:00').split(',').map((h) => h.trim()).filter((h) => /^\d{1,2}:\d{2}$/.test(h)),
    fuseau: process.env.X_FUSEAU || 'Europe/Paris',
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

// ------------------------------------------------------------ le temps

/** L heure et le jour dans le fuseau du proprietaire. */
function heureLocale(t, fuseau) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: fuseau || 'Europe/Paris', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { jour: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const minutesDe = (h) => { const m = /^(\d{1,2}):(\d{2})$/.exec(h); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
/**
 * Le creneau en cours : le dernier horaire deja passe aujourd hui (heure
 * locale), ou null s il n y en a pas encore eu. Sa cle est `jour#heure`, et
 * c est elle qui garantit UN post par creneau.
 */
function creneauDu(t, heures, fuseau) {
  const l = heureLocale(t, fuseau);
  const passes = (heures || []).filter((h) => minutesDe(h) <= l.minutes).sort((a, b) => minutesDe(b) - minutesDe(a));
  if (!passes.length) return null;
  return { cle: l.jour + '#' + passes[0], jour: l.jour, heure: passes[0] };
}
function jourDe(t) { return new Date(t).toISOString().slice(0, 10); }

// ------------------------------------------------------------ les scenes

/* ==========================================================================
 * CHAQUE IMAGE A SON PROPRE MONDE
 *
 * Releve du proprietaire, 19 septembre 2026 : « toutes les images que tu as
 * faites se ressemblent, il faut vraiment qu elles soient toutes uniques,
 * avec des scenes differentes, sans trop de courbes crypto ou autre ». C est
 * juste, et la cause etait dans le code : un STYLE unique — « affiche de jeu
 * crypto, bleu nuit et noir, vert electrique et or, traces de circuit » —
 * etait colle devant CHAQUE scene. Trente scenes differentes rendues avec la
 * meme recette donnent trente images qui se ressemblent : le fond, la lumiere
 * et la palette etaient identiques, seul le premier plan changeait.
 *
 * Trois changements, et ils portent tous sur ce qui se voit en premier :
 *
 *  1. LE MONDE EST DANS LA SCENE. Chaque scene decrit son lieu, sa lumiere et
 *     sa palette. Il n y a plus de fond commun a toutes.
 *  2. LA DIRECTION ARTISTIQUE TOURNE. Douze rendus — photographie argentique,
 *     encre de bande dessinee, peinture a l huile, estampe, rendu 3D, fusain…
 *     — tires par la cle du creneau. La meme scene deux mois plus tard n est
 *     donc pas la meme image.
 *  3. LES CLICHES SONT REFUSES. Courbes de bougies, ecrans de trading, pluie
 *     de pieces, symboles de cryptomonnaie : ecrits dans le refus, parce que
 *     le modele les ramene tout seul des qu il sent le sujet. Une scene qui en
 *     a vraiment besoin les demande elle-meme.
 *
 * Le personnage, lui, ne bouge pas : c est la seule chose qu on doit
 * reconnaitre d une image a l autre.
 * ======================================================================== */
const PERSONNAGE = "the famous 'buff Doge' meme character: a Shiba Inu head with a calm, confident expression on an extremely muscular bodybuilder torso, cream and tan fur, wearing a royal blue tank top. He is the subject of the picture, large in frame";

/* Douze directions artistiques. Aucune ne parle de crypto : c est le sujet qui
   raconte, pas la technique, et c est ce qui rendait les images jumelles. */
const RENDUS = [
  '35mm film photograph, natural light, shallow depth of field, visible grain',
  'bold comic book ink, heavy black outlines, flat saturated colour, halftone dots',
  'oil painting on canvas, thick visible brushwork, dramatic chiaroscuro',
  'Japanese woodblock print, flat colour planes, bold outline, aged paper texture',
  'high-end 3D render, soft studio lighting, clean matte surfaces, subtle depth of field',
  'gritty 1970s film still, warm faded colours, heavy vignette, anamorphic flare',
  'hand-painted animation cel, saturated colour, strong rim light, painted background',
  'charcoal and ink drawing on rough paper, monochrome with one spot colour',
  'vintage screen-printed travel poster, flat shapes, four-colour limited palette',
  'hyperreal macro photograph, single hard light source, deep black background',
  'watercolour and ink, loose wet edges, white paper showing through',
  'low-angle sports photography, long lens, frozen motion, stadium light',
];
const NEGATIF = 'No text, no letters, no numbers, no logos, no watermark. No paw prints anywhere. No candlestick charts, no trading screens, no floating coins, no cryptocurrency symbols, no circuit-board patterns unless the scene explicitly asks for them.';

/* ---- LES SCENES ----
 * Chacune porte SON lieu, SA lumiere et SA palette. Elles sont volontairement
 * eloignees les unes des autres : un desert, une cuisine, un ring, un fond
 * marin, une bibliotheque — pas trente variantes d une salle sombre. */
const SCENES = [
  { nom: 'stade', prompt: 'standing dead centre of a packed football stadium at night, arms crossed, the crowd a blur of colour behind him',
    monde: 'cold white floodlights cutting through drifting mist, emerald green pitch, deep blue night sky' },
  { nom: 'arcade', prompt: 'leaning on a battered arcade cabinet, joystick under one paw, a kid barely reaching his elbow looking up at him',
    monde: 'a 1990s Tokyo arcade, magenta and cyan tube light, sticky carpet, smoke, warm reflections on chrome' },
  { nom: 'casino', prompt: 'mid-shuffle at a card table, cards fanned impossibly wide between his paws, dealer frozen mid-gasp',
    monde: 'a red velvet private room, one low brass lamp, cigar haze, deep burgundy and gold' },
  { nom: 'lune', prompt: 'planting a plain flag in grey dust, visor up, Earth a small blue marble over his shoulder',
    monde: 'lunar surface, hard unfiltered sunlight, pure black sky, grey and white with one blue accent' },
  { nom: 'desert', prompt: 'walking out of a heat shimmer on a cracked salt flat, jacket over one shoulder, utterly calm',
    monde: 'white salt desert at noon, brutal overhead sun, pale gold and bleached blue, horizon warped by heat' },
  { nom: 'coffre', prompt: 'pulling open a bank vault door the size of a wall with one paw, the mechanism still turning',
    monde: 'a marble bank hall, cold morning light through tall windows, polished steel and cream stone' },
  { nom: 'chenil', prompt: 'sitting cross-legged on a lawn while five Shiba puppies climb all over him, laughing',
    monde: 'a suburban back garden at golden hour, long grass, warm low sun, soft greens and honey light' },
  { nom: 'cinema', prompt: 'alone in the front row of an empty cinema, feet up, the screen lighting his face',
    monde: 'red seats in near darkness, the only light is the flicker of the screen, deep reds and cold white' },
  { nom: 'salle', prompt: 'mid-lift under a loaded barbell, veins up, chalk dust hanging in the air',
    monde: 'an old iron gym, dusty window light in shafts, rust, worn rubber, grey and amber' },
  { nom: 'plage', prompt: 'floating flat on his back in clear shallow water, eyes closed, completely at peace',
    monde: 'a turquoise lagoon seen from above, white sand, caustic light patterns, tropical blue and cream' },
  { nom: 'trone', prompt: 'slouched sideways on an enormous stone throne, one leg over the armrest, bored',
    monde: 'a vast empty throne room, dust in a single shaft of light from high above, cold stone greys' },
  { nom: 'ring', prompt: 'in the corner of a boxing ring between rounds, breathing hard, towel round his neck, staring past the camera',
    monde: 'a smoky fight hall, one harsh overhead light, everything else black, sweat catching the light' },
  { nom: 'course', prompt: 'crossing a finish line in first, tape breaking across his chest, arms wide',
    monde: 'a red running track at dusk, low orange sun, long shadows, confetti caught in the air' },
  { nom: 'mine', prompt: 'deep in a crystal cavern, pickaxe resting on his shoulder, looking up at something enormous',
    monde: 'a cave of pale glowing crystals, cold blue light from within the rock, wet dark stone' },
  { nom: 'marche', prompt: 'haggling across a market stall piled with fruit, one paw raised, grinning',
    monde: 'a crowded Moroccan souk at midday, striped awnings, dust in slanted light, ochre and spice colours' },
  { nom: 'portail', prompt: 'stepping through a doorway of light that has opened in the middle of a forest',
    monde: 'a misty pine forest at dawn, cold blue-green shadows, one impossible warm light spilling out' },
  { nom: 'orage', prompt: 'standing on a cliff edge facing a wall of storm, fur and clothes flattened by the wind',
    monde: 'black thunderheads over a grey sea, one fork of lightning, monochrome with a sliver of white' },
  { nom: 'vaisseau', prompt: 'reclined in a pilot seat with his feet on the console, stars streaking past the canopy',
    monde: 'a cramped spacecraft cockpit, instrument glow on his face, everything else near black' },
  { nom: 'foot', prompt: 'mid-bicycle-kick, horizontal in the air, ball leaving his boot',
    monde: 'a floodlit pitch from a low angle, wet grass spraying, stadium lights flaring behind him' },
  { nom: 'hockey', prompt: 'carving a hard stop, ice spray exploding sideways, stick low',
    monde: 'an ice rink, blue-white ice, advertising boards blurred by speed, cold clean light' },
  { nom: 'tennis', prompt: 'at the top of a serve, fully extended, ball suspended above the racket',
    monde: 'a clay court in late afternoon, terracotta ground, long shadow, hot white light' },
  { nom: 'dragon', prompt: 'riding the neck of a vast dragon banking through cloud, one paw on a horn',
    monde: 'above a sea of cloud at sunrise, pink and gold light, the dragon in silhouette' },
  { nom: 'nuit', prompt: 'sitting alone on the edge of a rooftop, legs hanging over, looking at the city',
    monde: 'a sleeping city from twenty floors up, sodium street light, a huge low moon, deep blue and amber' },
  { nom: 'labo', prompt: 'peering into a beaker held up to the light, goggles pushed onto his forehead, one eyebrow raised',
    monde: 'a cluttered chemistry lab, green liquid casting light on his face, brass and glassware, dark wood' },
  { nom: 'surf', prompt: 'inside the barrel of a huge wave, one paw dragging the wall of water',
    monde: 'a breaking ocean wave from inside, sunlight through green water, spray, turquoise and white' },
  { nom: 'chef', prompt: 'tossing a pan of flames in a professional kitchen, entirely unbothered',
    monde: 'a restaurant kitchen at service, stainless steel, orange fire light against cold overheads' },
  { nom: 'concert', prompt: 'at the front of a stage mid-song, arm out to a crowd of thousands of lit phones',
    monde: 'a night festival main stage, hard back-light and lasers, silhouette against white beams' },
  { nom: 'bibliotheque', prompt: 'balanced on a rolling ladder in a vast library, three books open at once, absorbed',
    monde: 'an old university library, warm lamp light, endless dark wood shelves, dust in the air' },
  { nom: 'fond', prompt: 'walking along the seabed past the ribs of a shipwreck, unhurried, no equipment',
    monde: 'deep ocean, shafts of light from far above, blue-green gloom, drifting particles' },
  { nom: 'sommet', prompt: 'sitting on a narrow summit with his legs over the drop, eating a sandwich',
    monde: 'a rock spire above the clouds at sunrise, pink light on snow, impossible exposure, cold clean air' },
];


/* La scene est choisie par la cle du creneau, et ne peut pas etre une des
   six dernieres postees : deux posts par jour avec la meme image, le fil
   ressemble a une panne. */
function sceneSuivante(cle, journal) {
  const recentes = dernieres(journal, 6).map((e) => e.scene);
  let i = Number.parseInt(crypto.createHash('sha1').update(String(cle)).digest('hex').slice(0, 8), 16) % SCENES.length;
  for (let k = 0; k < SCENES.length && recentes.includes(SCENES[i].nom); k++) i = (i + 1) % SCENES.length;
  return SCENES[i];
}
/* Le rendu est tire de la cle du creneau, pas de la scene : la meme scene
   revenue deux mois plus tard n est donc pas la meme image. Ordre voulu :
   d abord la technique, puis le sujet, puis le monde — le modele suit le
   debut de la phrase, et c est le personnage qu on veut en grand. */
function renduDe(cle) {
  const n = Number.parseInt(crypto.createHash('sha1').update('rendu:' + String(cle)).digest('hex').slice(0, 8), 16);
  return RENDUS[n % RENDUS.length];
}
function promptImage(scene, cle) {
  /* Une scene ecrite a la main depuis le panneau (`special`) porte deja son
     decor dans sa phrase : on ne lui en colle pas un deuxieme. */
  const monde = scene.monde ? scene.monde + '. ' : '';
  return `${renduDe(cle)}. ${PERSONNAGE}, ${scene.prompt}. ${monde}${NEGATIF}`;
}

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
  faits.push('An AI agent writes, illustrates and posts on this X account by itself, twice a day');
  return faits;
}

// ------------------------------------------------------------ le texte

/* L angle tourne d un post a l autre : deux posts par jour ecrits sur le
   meme ton se lisent comme un robot. */
/* ---- LA PLUPART DES POSTS NE PARLENT PAS DU SITE ----
 * Demande du proprietaire, le 18 septembre 2026 : « pas forcement parler du
 * site, juste faire un tweet bullish ». Deux posts par jour qui enumerent des
 * fonctionnalites se lisent comme un catalogue, et un catalogue ne se partage
 * pas. Les angles marques `produit: false` interdisent de nommer quoi que ce
 * soit : c'est du meme, du ton, de l'humeur. Trois sur onze seulement parlent
 * de ce qu'on a construit — assez pour que le fil ne soit pas creux, assez peu
 * pour qu'il ne soit pas une brochure. */
const ANGLES = [
  { a: 'pure hype: two or three punchy lines about momentum and conviction, nothing else', produit: false },
  { a: 'humor: a joke about the very buff dog, self-aware meme energy', produit: false },
  { a: 'community: talk to the holders as a pack, we/us, CTO pride', produit: false },
  { a: 'midnight vibes: calm and confident, the dog never sleeps, late-night degen energy', produit: false },
  { a: 'one-liner: a single short line that could be a caption, sharp enough to quote', produit: false },
  { a: 'the flex: the dog is simply built different, say it with swagger', produit: false },
  { a: 'patience: early is uncomfortable, holders know, quiet conviction', produit: false },
  { a: 'good morning energy: greet the pack, set the tone for the day, light and warm', produit: false },
  { a: 'the numbers: lead with one real stat from the facts, make it feel huge', produit: true },
  { a: 'product flex: name ONE concrete thing from the facts and why it is cool, no list', produit: true },
  { a: 'teaser: hint at what is coming next without details, build curiosity', produit: true },
];
const SYSTEME = `You write posts on X for SWOGE ($SWOGE), a community-run memecoin (CTO) whose mascot is a very buff Shiba Inu. The goal is viral, bullish, shareable posts.
Voice: bullish, playful, meme energy, confident and fun, never desperate, never rude, never repetitive.
MOST POSTS ARE PURE VIBES. You do NOT have to talk about the product. A post that lists features reads like a brochure and nobody shares a brochure. The ANGLE tells you which kind this one is: when it says NO PRODUCT, write pure meme and conviction and mention no feature, no number, no place, nothing that is being built — the facts are there only so you never contradict them. When the ANGLE asks for the product, name ONE thing and one only.
Hard rules: English. Maximum 240 characters, and shorter is usually better. Must contain "$SWOGE". 1 to 3 emojis. At most 2 hashtags. No links. No promises of returns, no "guaranteed", no price targets. Never invent a number. Do NOT reuse the opening words, the structure or the jokes of the previous posts you are shown. Mention today's image only if it lands naturally.
Output only the post text, nothing else.`;

/* Si le modele ne repond pas, on poste quand meme — avec une phrase de
   reserve, vraie, plutot que de rater le creneau. */
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

/** L'angle, retrouve par son libelle : le journal n'en garde que le texte. */
function angleDe(a) {
  if (a && typeof a === 'object' && a.a) return a;
  const x = ANGLES.find((y) => y.a === a);
  return x || { a: a || ANGLES[0].a, produit: false };
}

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

/**
 * `o.scene` : la scene de l image ; `o.sujet` : un sujet impose (un post
 * special) ; `o.angle` : l angle du jour ; `o.precedents` : les derniers
 * textes, pour ne pas les repeter.
 */
async function ecritTexte(faits, o, prendre) {
  const e = env();
  const f = prendre || fetch;
  const t = o.maintenant || Date.now();
  const jour = jourDe(t);
  if (e.anthropic) {
    try {
      /* L'angle dit s'il a le droit de nommer quelque chose. Un post special
         (`o.sujet`) parle toujours de son sujet : c'est sa raison d'etre. */
      const ang = angleDe(o.angle);
      const produit = !!o.sujet || ang.produit;
      const demande = [`Date: ${jour}`, `ANGLE: ${ang.a}${produit ? '' : ' — NO PRODUCT: mention nothing that is built, no feature, no number, no place'}`]
        .concat(o.sujet ? [`Today's announcement (this is the subject of the post): ${o.sujet}`] : [])
        .concat([`Today's image: SWOGE ${o.scene.prompt}`,
                 produit ? `Facts:\n- ${faits.join('\n- ')}`
                         : `Background, do not quote any of it, it is only here so you never contradict it:\n- ${faits.join('\n- ')}`])
        .concat((o.precedents || []).length ? [`Previous posts (do not repeat their openings, structure or jokes):\n- ${o.precedents.join('\n- ')}`] : [])
        .join('\n');
      const r = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': e.anthropic, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: e.modeleTexte, max_tokens: 200, system: SYSTEME, messages: [{ role: 'user', content: demande }] }),
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
  const i = Number.parseInt(crypto.createHash('sha1').update(String(o.cle || jour)).digest('hex').slice(0, 6), 16) % RESERVE.length;
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
async function publie(texte, mediaId, prendre, enReponseA) {
  const corps = { text: texte, media: { media_ids: [mediaId] } };
  if (enReponseA) corps.reply = { in_reply_to_tweet_id: String(enReponseA) };
  const j = await appelX('/2/tweets', corps, prendre);
  const id = j.data && j.data.id;
  if (!id) throw new Error('X tweets : reponse sans identifiant');
  return String(id);
}

// ------------------------------------------------------------ le journal

const FICHIER = () => path.join(cfg.DATA_DIR, 'x_posts.json');
const DOSSIER_IMAGES = () => path.join(cfg.DATA_DIR, 'x_images');
function litJournal() {
  try {
    const j = JSON.parse(fs.readFileSync(FICHIER(), 'utf8')) || {};
    const jours = {};
    /* Le premier jour (18 septembre 2026) avait un post par jour, sous la
       cle du jour seul : elle se lit comme le creneau de midi, sinon le
       premier tour apres deploiement « rattraperait » un midi deja poste. */
    for (const [k, e] of Object.entries(j.jours || {})) jours[k.includes('#') ? k : k + '#12:00'] = e;
    return { jours };
  } catch (e) { return { jours: {} }; }
}
function ecritJournal(j) {
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.writeFileSync(FICHIER(), JSON.stringify(j, null, 1));
}
/** Les derniers posts PARTIS, du plus recent au plus ancien. */
function dernieres(journal, n) {
  return Object.entries(journal.jours).filter(([, e]) => e.id)
    .sort((a, b) => (b[1].quand || '').localeCompare(a[1].quand || '') || b[0].localeCompare(a[0]))
    .slice(0, n).map(([cle, e]) => Object.assign({ cle }, e));
}
/* Soixante images gardees : un mois a deux par jour, pas de quoi remplir le volume. */
function purgeImages() {
  try {
    const l = fs.readdirSync(DOSSIER_IMAGES()).filter((f) => /\.png$/.test(f)).sort();
    for (const f of l.slice(0, Math.max(0, l.length - 60))) fs.unlinkSync(path.join(DOSSIER_IMAGES(), f));
  } catch (e) { /* dossier absent */ }
}
const nomImage = (cle) => String(cle).replace(/[^0-9A-Za-z-]+/g, '_');
function vue(cle, e) {
  return { cle, scene: e.scene, angle: e.angle || null, texte: e.texte, id: e.id || null, essais: e.essais || 0, erreur: e.erreur || null,
           via: e.via || null, quand: e.quand || null, image: e.image ? '/x/image/' + e.image.replace(/\.png$/, '') + '.png' : null,
           url: e.id ? `https://x.com/${env().compte}/status/${e.id}` : null };
}
/** Ce que le serveur montre sur /x/derniere : le journal sans rien de secret. */
function derniere() {
  const j = litJournal();
  const e = env();
  const cles = Object.keys(j.jours).sort((a, b) => ((j.jours[b].quand || '') + b).localeCompare((j.jours[a].quand || '') + a));
  const c = cles[0];
  return { actif: enabled(), manque: manque(), heures: e.heures, fuseau: e.fuseau,
           creneau: creneauDu(Date.now(), e.heures, e.fuseau),
           derniere: c ? vue(c, j.jours[c]) : null,
           recents: dernieres(j, 6).map((x) => ({ cle: x.cle, scene: x.scene, quand: x.quand, url: `https://x.com/${e.compte}/status/${x.id}` })) };
}

// ------------------------------------------------------------ la tache

let enCours = false;
/**
 * Un tour. Rend un etat lisible : inactif · attend · deja · abandon · poste · rate.
 * `opts.maintenant` et `opts.prendre` (un faux fetch) servent aux essais ;
 * `opts.force` ignore l heure — pour `--publie`, pas pour le serveur ;
 * `opts.special = { nom, prompt, sujet }` fait un post hors creneau, sur un
 * sujet impose, avec sa propre image.
 */
async function tache(opts) {
  const o = opts || {};
  const t = o.maintenant || Date.now();
  if (!enabled()) return { etat: 'inactif', manque: manque() };
  const e = env();
  const journal = litJournal();
  let cle;
  if (o.special) {
    if (!o.special.nom || !o.special.sujet) return { etat: 'refuse', erreur: 'un post special demande un nom et un sujet' };
    cle = jourDe(t) + '#' + String(o.special.nom).replace(/[^0-9A-Za-z-]+/g, '-').slice(0, 24);
  } else {
    const c = creneauDu(t, e.heures, e.fuseau);
    if (!c && !o.force) return { etat: 'attend', heures: e.heures, fuseau: e.fuseau };
    cle = c ? c.cle : heureLocale(t, e.fuseau).jour + '#force';
  }
  const entree = journal.jours[cle] || { essais: 0 };
  if (entree.id) return { etat: 'deja', cle, id: entree.id };
  if (entree.essais >= 3) return { etat: 'abandon', cle, erreur: entree.erreur };
  if (enCours) return { etat: 'en cours' };
  enCours = true;
  try {
    const scene = o.special && o.special.prompt ? { nom: o.special.nom, prompt: o.special.prompt }
                : entree.scene ? (SCENES.find((s) => s.nom === entree.scene) || sceneSuivante(cle, journal))
                : sceneSuivante(cle, journal);
    entree.scene = scene.nom;
    if (!entree.angle) entree.angle = ANGLES[Number.parseInt(crypto.createHash('sha1').update(cle).digest('hex').slice(0, 6), 16) % ANGLES.length].a;
    /* L image d abord, sur le disque : un refus de X plus loin ne la fait
       pas payer deux fois. */
    fs.mkdirSync(DOSSIER_IMAGES(), { recursive: true });
    const fichierImage = path.join(DOSSIER_IMAGES(), nomImage(cle) + '.png');
    let png;
    if (entree.image && fs.existsSync(fichierImage)) png = fs.readFileSync(fichierImage);
    else {
      const g = await genereImage(promptImage(scene, cle), o.prendre);
      png = g.png; fs.writeFileSync(fichierImage, png);
      entree.image = nomImage(cle) + '.png'; entree.jetonsImage = g.jetons;
      journal.jours[cle] = entree; ecritJournal(journal);
    }
    if (!entree.texte) {
      const r = await ecritTexte(faitsDuJour(t), { scene, cle, maintenant: t, angle: entree.angle,
                                                    sujet: o.special && o.special.sujet,
                                                    precedents: dernieres(journal, 5).map((x) => x.texte) }, o.prendre);
      entree.texte = r.texte; entree.via = r.via;
      journal.jours[cle] = entree; ecritJournal(journal);
    }
    const mediaId = await televerse(png, o.prendre);
    const id = await publie(entree.texte, mediaId, o.prendre);
    entree.id = id; entree.quand = new Date(t).toISOString(); delete entree.erreur;
    journal.jours[cle] = entree; ecritJournal(journal);
    purgeImages();
    console.log(`[x] poste ${cle} · scene ${scene.nom} · https://x.com/${e.compte}/status/${id}`);
    if (o.signale) {
      try { o.signale({ cle, texte: entree.texte, id, image: e.domaine ? `https://${e.domaine}/x/image/${nomImage(cle)}.png` : null, url: `https://x.com/${e.compte}/status/${id}` }); }
      catch (x) { /* le Telegram ne fait pas rater le post */ }
    }
    return { etat: 'poste', cle, id, texte: entree.texte, scene: scene.nom, angle: entree.angle };
  } catch (err) {
    entree.essais = (entree.essais || 0) + 1;
    entree.erreur = String(err && err.message || err).slice(0, 200);
    journal.jours[cle] = entree; ecritJournal(journal);
    console.error(`[x] rate ${cle} (${entree.essais}/3) : ${entree.erreur}`);
    return { etat: 'rate', cle, essais: entree.essais, erreur: entree.erreur };
  } finally {
    enCours = false;
  }
}

/** Remet a zero les essais des creneaux non partis — apres une cle ou une
 *  permission corrigee, sans attendre le creneau suivant. Image et texte gardes. */
function reprend() {
  const journal = litJournal();
  let n = 0;
  for (const e of Object.values(journal.jours)) if (!e.id && e.essais) { delete e.essais; delete e.erreur; n++; }
  if (n) ecritJournal(journal);
  return n;
}

/** Dans le serveur : un regard toutes les cinq minutes, le journal decide. */
function planifie(signale) {
  if (!enabled()) {
    console.log('[x] posts ETEINTS : il manque ' + manque().join(', '));
    return null;
  }
  const e = env();
  console.log(`[x] posts ARMES a ${e.heures.join(' et ')} (${e.fuseau})`);
  const tour = () => tache({ signale }).catch((x) => console.error('[x] ' + (x.message || x)));
  const premier = setTimeout(tour, 120000);
  const minuterie = setInterval(tour, 5 * 60000);
  return { arrete() { clearTimeout(premier); clearInterval(minuterie); } };
}

module.exports = { enabled, manque, env, enc, signeOAuth, SCENES, RENDUS, NEGATIF, ANGLES, renduDe, sceneSuivante, promptImage, faitsDuJour,
                   nettoie, ecritTexte, genereImage, televerse, publie, tache, planifie, derniere, reprend,
                   heureLocale, creneauDu, jourDe, litJournal, dernieres, DOSSIER_IMAGES, RESERVE };

// ------------------------------------------------------------ en ligne de commande

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    if (a.includes('--essai')) {
      /* Image + texte, RIEN n est poste : pour voir a quoi ca ressemble. Coute l image. */
      if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY absente'); process.exit(1); }
      const t = Date.now(); const j = litJournal(); const cle = 'essai#' + t;
      const scene = sceneSuivante(cle, j);
      console.log('scene :', scene.nom);
      const g = await genereImage(promptImage(scene, cle));
      const i = a.indexOf('--essai');
      const sortie = path.resolve(a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : '_x_essai.png');
      fs.writeFileSync(sortie, g.png);
      console.log('image :', sortie, '·', g.jetons, 'jetons');
      const r = await ecritTexte(faitsDuJour(t), { scene, cle, maintenant: t, angle: ANGLES[t % ANGLES.length].a, precedents: dernieres(j, 5).map((x) => x.texte) });
      console.log('texte (' + r.via + ') :\n' + r.texte);
      return;
    }
    if (a.includes('--publie')) {
      reprend();
      const r = await tache({ force: true });
      console.log(JSON.stringify(r, null, 1));
      process.exit(r.etat === 'poste' || r.etat === 'deja' ? 0 : 1);
    }
    console.log('usage : --essai [fichier.png]  (image + texte, sans poster) | --publie  (poste le creneau en cours)');
    console.log('cles :', enabled() ? 'toutes presentes' : 'il manque ' + manque().join(', '));
    console.log('creneaux :', env().heures.join(', '), env().fuseau);
  })().catch((e) => { console.error(e.message || e); process.exit(1); });
}
