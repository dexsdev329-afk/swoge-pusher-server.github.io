'use strict';
/*
 * ==================== LES POSTS QUOTIDIENS SUR X ====================
 *
 * ---- pourquoi ce fichier existe ----
 *
 * « Une image par jour avec SWOGE, differente, et un post bullish, que
 * j automatise. » Puis : « deux posts par jour, midi et minuit, des textes
 * et des images differents a chaque fois. » Porte a douze creneaux le
 * 24 septembre 2026 (toutes les 2 h, 00:00 a 22:00), a la demande du
 * proprietaire — vingt-quatre spammait trop.
 * RAMENE A QUATRE, A L HEURE DE NEW YORK, le 26 septembre 2026 : « avant on
 * faisait des centaines de vues » a deux par jour ; a douze, chaque post
 * partage la meme poignee d abonnes, et la moitie des creneaux tombaient la
 * nuit pour le public vise, americain. 09:00 / 12:30 / 17:00 / 20:30 heure de
 * New York : debut de journee cote Est, dejeuner (9:30 cote Ouest), fin de
 * journee, et le soir, quand le X crypto est le plus actif des deux cotes.
 * Aucune mesure de vues n est disponible cote serveur (elles vivent dans X
 * Analytics) : on comparera les vues moyennes par post sur une semaine.
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
 * Les creneaux sont donnes dans le fuseau du PUBLIC (`X_FUSEAU`,
 * America/New_York) : ces heures a New York, ete comme hiver, sans recalcul
 * a la main au changement d heure americain.
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
    heures: String(process.env.X_HEURES || process.env.X_HEURE || '09:00,12:30,17:00,20:30').split(',').map((h) => h.trim()).filter((h) => /^\d{1,2}:\d{2}$/.test(h)),
    fuseau: process.env.X_FUSEAU || 'America/New_York',
    lien: process.env.X_LIEN === '1',
    qualite: process.env.X_QUALITE || 'high',
    modeleImage: process.env.X_MODELE_IMAGE || 'gpt-image-1.5',
    modeleVision: process.env.X_MODELE_VISION || 'gpt-4o-mini',
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
/* Le 27 septembre 2026, le proprietaire : « j ai deja vu plusieurs fois des
   images similaires ». Sur les images postees, le debardeur bleu roi etait LE
   meme a chaque fois, quel que soit le decor : c est lui qui faisait le « deja
   vu ». Le corps et la tete restent (on doit reconnaitre SWOGE), la tenue suit
   la scene — la meme lecon que pour les images de SwoleMind. */
const PERSONNAGE = "the famous 'buff Doge' meme character: a Shiba Inu head with a calm, confident expression on an extremely muscular bodybuilder torso, cream and tan fur, and furry dog paws with paw pads, never human hands or fingers. His clothes fit this particular scene (never a plain blue tank top). He is the subject of the picture";

/* Le cadrage : la meme scene vue de pres, de loin, d en bas ou de dos n est pas
   la meme image. Tire en evitant les FENETRE_CADRAGE derniers. */
const CADRAGES = [
  'tight close-up on his face and shoulders, background soft',
  'wide establishing shot, he is small in a huge setting',
  'low angle looking up at him, heroic',
  'high angle looking down from above',
  'seen from behind over his shoulder, looking at what he looks at',
  'three-quarter view, mid shot, natural',
  'dutch tilt, dynamic diagonal composition',
  'silhouette against the brightest part of the scene',
];

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
/* Six ne suffisaient pas (27 septembre 2026) : a quatre posts par jour, une
   scene revenait en un jour et demi. Vingt sur trente : une scene ne revient
   pas avant cinq jours. */
const FENETRE_SCENES = 20;
const FENETRE_RENDUS = 6;
const FENETRE_CADRAGE = 4;
function sceneSuivante(cle, journal) {
  const recentes = dernieres(journal, FENETRE_SCENES).map((e) => e.scene);
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
/* Le rendu et le cadrage d un creneau : tires par la cle (une reprise refait
   la meme image), mais jamais un des derniers, et jamais un trio scene +
   rendu + cadrage deja poste — le journal garde les trois. */
function choixImage(cle, scene, journal) {
  const passes = journal ? dernieres(journal, 10000) : [];
  const rendusRecents = passes.slice(0, FENETRE_RENDUS).map((e) => e.rendu);
  const cadragesRecents = passes.slice(0, FENETRE_CADRAGE).map((e) => e.cadrage);
  const trios = new Set(passes.map((e) => e.scene + '|' + e.rendu + '|' + e.cadrage));
  const h = (sel) => Number.parseInt(crypto.createHash('sha1').update(sel + String(cle)).digest('hex').slice(0, 8), 16);
  let r = h('rendu:') % RENDUS.length, c = h('cadrage:') % CADRAGES.length;
  for (let k = 0; k < RENDUS.length && rendusRecents.includes(r); k++) r = (r + 1) % RENDUS.length;
  /* Le cadrage : ni un des derniers, ni un trio deja poste ; a defaut de
     trio neuf (apres des mois), au moins pas un des derniers. */
  const ok = (x) => !cadragesRecents.includes(x);
  let neuf = -1;
  for (let k = 0; k < CADRAGES.length; k++) { const x = (c + k) % CADRAGES.length; if (ok(x) && !trios.has(scene.nom + '|' + r + '|' + x)) { neuf = x; break; } }
  if (neuf < 0) for (let k = 0; k < CADRAGES.length; k++) { const x = (c + k) % CADRAGES.length; if (ok(x)) { neuf = x; break; } }
  return { rendu: r, cadrage: neuf < 0 ? c : neuf };
}
function promptImage(scene, cle, choix) {
  /* Une scene ecrite a la main depuis le panneau (`special`) porte deja son
     decor dans sa phrase : on ne lui en colle pas un deuxieme. */
  const monde = scene.monde ? scene.monde + '. ' : '';
  const rendu = choix ? RENDUS[choix.rendu] : renduDe(cle);
  const cadrage = choix ? CADRAGES[choix.cadrage] : CADRAGES[Number.parseInt(crypto.createHash('sha1').update('cadrage:' + String(cle)).digest('hex').slice(0, 8), 16) % CADRAGES.length];
  return `${rendu}. ${cadrage}. ${PERSONNAGE}, ${scene.prompt}. ${monde}${NEGATIF}`;
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
  faits.push('$SWOGE lives on Robinhood Chain (chain 4663), the new chain from Robinhood');
  faits.push('SWOGE AI: a colony of 13 AI agents that scouts new Robinhood Chain tokens and paper-trades them on real prices, every trade public');
  faits.push('An AI agent writes, illustrates and posts on this X account by itself, four times a day');
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
const SYSTEME = `You write posts on X for SWOGE ($SWOGE), a community-run memecoin (CTO) on Robinhood Chain whose mascot is a very buff Shiba Inu. The goal is viral, bullish, shareable posts.
Audience: American crypto Twitter. Write in natural US English, with the humor and slang of US crypto X where it fits (never forced). Robinhood Chain is the hook Americans recognize: bring it up when it lands, never in every post.
Voice: bullish, playful, meme energy, confident and fun, never desperate, never rude, never repetitive.
MOST POSTS ARE PURE VIBES. You do NOT have to talk about the product. A post that lists features reads like a brochure and nobody shares a brochure. The ANGLE tells you which kind this one is: when it says NO PRODUCT, write pure meme and conviction and mention no feature, no number, no place, nothing that is being built — the facts are there only so you never contradict them. When the ANGLE asks for the product, name ONE thing and one only.
Hard rules: English. Maximum 240 characters, and shorter is usually better. The request tells you, in its TICKER and HASHTAG lines, whether this post carries "$SWOGE" and "#RobinhoodChain": follow them exactly, and weave them in naturally rather than tacking them on. No other hashtag. 1 to 3 emojis. No links. No promises of returns, no "guaranteed", no price targets. Never invent a number. Do NOT reuse the opening words, the structure or the jokes of the previous posts you are shown. Mention today's image only if it lands naturally.
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

/* ---- LE TICKER ET LE HASHTAG, PAR ROTATION EXACTE ----
 * Le 24 septembre, « $SWOGE » dans chaque post spammait : on l'avait retire
 * partout. Mais sur le X crypto c'est le cashtag qui rend TROUVABLE, et
 * « #RobinhoodChain » est ce que cherche un Americain curieux de la chaine.
 * Decide le 26 septembre 2026 avec le proprietaire : le cashtag un creneau
 * sur DEUX, le hashtag un sur TROIS. Le numero du creneau (jour × creneaux +
 * rang) decide, pas le modele : laisse a lui-meme il le mettait partout ou
 * nulle part. `nettoie` ajoute ce qui manque et neutralise ce qui est en trop. */
function etiquettes(cle, heures) {
  const m = /^(\d{4}-\d{2}-\d{2})#(\d{1,2}:\d{2})$/.exec(String(cle || ''));
  let n;
  if (m && (heures || []).indexOf(m[2]) >= 0) {
    n = Math.floor(Date.parse(m[1] + 'T00:00:00Z') / 864e5) * heures.length + heures.indexOf(m[2]);
  } else {
    n = Number.parseInt(crypto.createHash('sha1').update(String(cle || '')).digest('hex').slice(0, 6), 16);
  }
  return { ticker: n % 2 === 0, hashtag: n % 3 === 0 };
}

/** Le texte, rendu presentable et dans les regles, quoi qu ait ecrit le modele. */
function nettoie(brut, lien, tags) {
  let t = String(brut || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  t = t.replace(/https?:\/\/\S+/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (tags) {
    /* En trop : on garde le mot, on retire le signe — « $SWOGE keeps shipping »
       devient « SWOGE keeps shipping », la phrase reste entiere. */
    if (!tags.ticker) t = t.replace(/\$SWOGE\b/gi, 'SWOGE');
    if (!tags.hashtag) t = t.replace(/#RobinhoodChain\b/gi, 'Robinhood Chain');
    t = t.replace(/#(?!RobinhoodChain\b)[A-Za-z]\w*/g, (h) => h.slice(1));   /* aucun autre hashtag */
    const ajout = [];
    if (tags.ticker && !/\$SWOGE\b/i.test(t)) ajout.push('$SWOGE');
    if (tags.hashtag && !/#RobinhoodChain\b/i.test(t)) ajout.push('#RobinhoodChain');
    if (ajout.length) t = t + ' ' + ajout.join(' ');
  }
  const url = typeof lien === 'string' ? lien : LIEN;
  const max = lien ? 280 - (url.length + 1) : 280;
  if (t.length > max) {
    const coupe = (s, m) => { s = s.slice(0, m); return s.slice(0, Math.max(s.lastIndexOf(' '), m - 40)).trim(); };
    t = coupe(t, max);
  }
  if (lien) t += '\n' + url;
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
  const tags = etiquettes(o.cle, e.heures);
  if (e.anthropic) {
    try {
      /* L'angle dit s'il a le droit de nommer quelque chose. Un post special
         (`o.sujet`) parle toujours de son sujet : c'est sa raison d'etre. */
      const ang = angleDe(o.angle);
      const produit = !!o.sujet || ang.produit;
      const demande = [`Date: ${jour}`, `ANGLE: ${ang.a}${produit ? '' : ' — NO PRODUCT: mention nothing that is built, no feature, no number, no place'}`,
        `TICKER: ${tags.ticker ? 'include "$SWOGE" exactly once' : 'do NOT write "$SWOGE"'}`,
        `HASHTAG: ${tags.hashtag ? 'include "#RobinhoodChain" exactly once' : 'no hashtag at all'}`]
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
      if (brut.trim()) return { texte: nettoie(brut, o.lien !== undefined ? o.lien : e.lien, tags), via: 'modele' };
      throw new Error('reponse vide');
    } catch (err) {
      console.error('[x] texte : le modele n a pas repondu (' + (err.message || err) + '), phrase de reserve');
    }
  }
  const i = Number.parseInt(crypto.createHash('sha1').update(String(o.cle || jour)).digest('hex').slice(0, 6), 16) % RESERVE.length;
  if (o.reserve) return { texte: nettoie(o.reserve, o.lien !== undefined ? o.lien : e.lien, tags), via: 'reserve' };
  return { texte: nettoie(RESERVE[i], o.lien !== undefined ? o.lien : e.lien, tags), via: 'reserve' };
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

/* ---- LE CONTROLE DES PATTES ----
 * Demande du proprietaire, 04/10 : « les images que tu generes pour les tweets,
 * verifie qu il n a pas des MAINS mais des PATTES de chien ». Le prompt le
 * demande deja (PERSONNAGE : « furry dog paws, never human hands or fingers »),
 * mais les modeles d images derapent. On REGARDE donc l image avec un modele de
 * vision et on refuse celle ou le personnage a des mains ou des doigts humains.
 *
 * Reponse stricte en JSON { hands:boolean, why:string }. On ne bloque QUE sur
 * un « oui » clair : si le verificateur lui-meme echoue (reseau, cle, reponse
 * illisible), on laisse passer et on le dit — une panne du controleur ne doit
 * pas eteindre toute la file. `X_PATTES=0` desactive le controle.
 * Teste avec un faux fetch (`prendre`) dans x_post.test.js. */
async function verifiePattes(png, prendre) {
  if (process.env.X_PATTES === '0') return { ok: true, saute: 'desactive' };
  const e = env();
  if (!e.openai) return { ok: true, saute: 'pas de cle vision' };
  const f = prendre || fetch;
  const b64 = Buffer.isBuffer(png) ? png.toString('base64') : String(png || '');
  let r, j;
  try {
    r = await f('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + e.openai },
      body: JSON.stringify({
        model: e.modeleVision, max_tokens: 120, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'This is a cartoon of a muscular Shiba Inu dog character. Look only at his hands. '
            + 'Does he have HUMAN hands or human fingers instead of dog paws? A correct image has furry dog paws with paw pads, no separate fingers. '
            + 'Answer ONLY with JSON: {"hands": true or false, "why": "a few words"}. "hands" is true if you see any human hand or human fingers.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
        ] }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    j = await r.json();
  } catch (err) {
    return { ok: true, saute: 'controleur injoignable : ' + String(err && err.message || err).slice(0, 80) };
  }
  if (!r.ok) return { ok: true, saute: 'controleur HTTP ' + r.status };
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) return { ok: true, saute: 'reponse illisible' };
  let verdict; try { verdict = JSON.parse(m[0]); } catch (x) { return { ok: true, saute: 'JSON illisible' }; }
  /* On ne bloque que sur un oui franc. */
  return verdict.hands === true ? { ok: false, raison: String(verdict.why || 'human hands').slice(0, 120) } : { ok: true };
}

/* Generer une image ET s assurer qu elle a des pattes : jusqu a `essais`
 * tentatives, le prompt renforce apres un refus. Rend { png, jetons, controle }.
 * Si toutes echouent, LEVE : le creneau abandonne plutot que de poster une
 * image a mains humaines (le vrai but du controle). */
async function genereImageVerifiee(prompt, prendre, essais) {
  const n = essais || 2;
  let dernier = null;
  for (let i = 0; i < n; i++) {
    const renfort = i === 0 ? '' : ' IMPORTANT: the character MUST have furry dog paws with paw pads, absolutely NO human hands and NO human fingers.';
    const g = await genereImage(prompt + renfort, prendre);
    const c = await verifiePattes(g.png, prendre);
    if (c.ok) return { png: g.png, jetons: g.jetons, controle: c.saute ? 'non verifie (' + c.saute + ')' : 'pattes ok' };
    dernier = c.raison;
    console.error(`[x] image refusee (${i + 1}/${n}) : mains humaines — ${dernier}`);
  }
  throw new Error('image : mains humaines detectees apres ' + n + ' essais (' + (dernier || '') + ')');
}

// ------------------------------------------------------------ l annonce en video

/* ---- UNE ANNONCE, UNE FOIS, EN VIDEO ----
 * Demande du proprietaire, 27 septembre 2026 : « le prochain tweet auto,
 * exceptionnellement, une video de 6 secondes et un texte viral pour annoncer
 * SwoleMind ; ensuite les tweets reprennent comme avant ». Le prochain creneau
 * la prend ; le journal (`annonces`) la retient partie — ou abandonnee apres
 * trois essais, et le creneau suivant redevient normal. `X_ANNONCE=0` l eteint.
 * La video : Grok Imagine (xAI), POST /v1/videos/generations puis GET
 * /v1/videos/{id} (specification OpenAPI xAI relue le 26 septembre 2026, voir
 * studio_xai.js) ; « grok-imagine-video-1.5 » a 0,08 $ la seconde, soit
 * environ 0,48 $ pour 6 s (prix du catalogue de studio_media.js). */
/* 03/10 : la deuxieme annonce, meme mecanisme (« le prochain tweet, explique que les gens peuvent
 * lancer un token via le launchpad ou directement via SwoleMind »). Un nouveau `nom` : celle de
 * SwoleMind est partie le 27/09 (journal : status/2104195640398164440) et reste notee partie. Le
 * texte ne promet que ce qui est vrai des DEUX chemins : un jeton sur Robinhood Chain, signe par le
 * portefeuille du joueur, en une transaction (launchpad.html ; SwoleMind via l outil
 * propose_token_launch, studio_agent.js). Aucun chiffre de frais : ils different entre les deux. */
/* 03/10 (soir) : la troisieme, « sur l un des prochains tweets, poste le nouveau design de SWOGE
 * wallet ». Celle du launchpad est partie le 03/10 a 09:00 (status/2106370028996350032). Ici PAS de
 * video generee : une video inventee ne montrerait pas le vrai design. L image est une CAPTURE de
 * swoge_wallet.html (1600 x 900, x1,5), prise le 03/10 vers 15 h UTC avec les vraies lectures du
 * moment (DexScreener : $0.00002785, liquidite $14.0K ; bloc #79,177,262) — `annonces/wallet_design.png`.
 * Le texte ne decrit que ce qui se voit dessus. */
const ANNONCE = {
  nom: 'wallet-design',
  image: 'annonces/wallet_design.png',
  lien: 'https://swoleeswoge.dog/swoge_wallet.html',
  scene: 'showing a screenshot of the redesigned SWOGE Wallet web page',
  sujet: 'The SWOGE Wallet has a brand new design: the wallet app sits in the middle of the page, with live cards around it: the $SWOGE market from DexScreener, Robinhood Chain live block and gas, quick actions (send, receive, swap, bridge, buy $SWOGE), your tokens, and the casino game vault. Sign in with email or a browser wallet; the player keeps their own keys.',
  reserve: 'The new SWOGE Wallet is live 🐾 Send, receive, swap and bridge on Robinhood Chain, with the live $SWOGE market and the casino vault right next to your wallet. Sign in with email or your browser wallet. $SWOGE',
};
function cleXai() { return (process.env.XAI_API_KEY || process.env.GROK_API_KEY || '').trim(); }
/* Une annonce en IMAGE (un fichier du depot) n a pas besoin de xAI ; une annonce en video, si. */
function annonceEnAttente(journal, a) {
  a = a || ANNONCE;
  if (process.env.X_ANNONCE === '0' || !a || (!a.image && !cleXai())) return false;
  return !((journal.annonces || {})[a.nom]);
}
async function genereVideo(prompt, duree, prendre, pause) {
  const f = prendre || fetch;
  const dors = pause || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = (process.env.XAI_BASE_URL || 'https://api.x.ai').replace(/\/$/, '');
  const h = { 'content-type': 'application/json', authorization: 'Bearer ' + cleXai() };
  const r = await f(base + '/v1/videos/generations', { method: 'POST', headers: h, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model: 'grok-imagine-video-1.5', prompt, duration: duree, resolution: '720p', aspect_ratio: '16:9' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.request_id) throw new Error('video : HTTP ' + r.status + (j.error ? ' — ' + String(j.error.message || j.error).slice(0, 100) : ''));
  for (let tour = 0; tour < 90; tour++) {                       /* 90 × 10 s : 15 min, comme STUDIO_VIDEO_MAX_MS */
    await dors(10000);
    const q = await f(base + '/v1/videos/' + encodeURIComponent(j.request_id), { headers: { authorization: h.authorization }, signal: AbortSignal.timeout(30000) });
    const x = await q.json().catch(() => ({}));
    const v = x.response && x.response.status ? x.response : x;
    const st = v.status || x.status;
    if (st === 'done' && v.video && v.video.url) {
      const d = await f(v.video.url, { signal: AbortSignal.timeout(120000) });
      if (!d.ok) throw new Error('video : telechargement HTTP ' + d.status);
      const mp4 = Buffer.from(await d.arrayBuffer());
      const ticks = v.usage && Number(v.usage.cost_in_usd_ticks);
      return { mp4, coutUsd: Number.isFinite(ticks) ? ticks / 1e10 : null };
    }
    if (st === 'failed' || st === 'expired') throw new Error('video : ' + st + (v.error ? ' — ' + String(v.error.message || v.error.code || '').slice(0, 100) : ''));
  }
  throw new Error('video : pas prete apres 15 min');
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
async function appelXGet(chemin, params, prendre) {
  const e = env();
  const f = prendre || fetch;
  const url = API + chemin;
  const s = signeOAuth('GET', url, params, e);        /* les parametres de requete entrent dans la signature */
  const r = await f(url + '?' + Object.keys(params).map((k) => enc(k) + '=' + enc(params[k])).join('&'), {
    method: 'GET', headers: { authorization: s.entete }, signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`X ${chemin} : HTTP ${r.status}`);
  return j;
}
/* ---- UNE VIDEO SUR X : le televersement en morceaux ----
 * docs.x.com (relu le 27 septembre 2026) : POST /2/media/upload/initialize
 * {media_type, total_bytes, media_category: tweet_video} → id ; POST
 * /2/media/upload/{id}/append {media (base64 accepte en JSON), segment_index}
 * par morceaux de 5 Mo au plus ; POST /2/media/upload/{id}/finalize ; puis
 * GET /2/media/upload?command=STATUS&media_id=… tant que processing_info dit
 * pending ou in_progress (check_after_secs). */
const MORCEAU = 4 * 1024 * 1024;
async function televerseVideo(mp4, prendre, pause) {
  const dors = pause || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const i = await appelX('/2/media/upload/initialize', { media_type: 'video/mp4', total_bytes: mp4.length, media_category: 'tweet_video' }, prendre);
  const id = String((i.data && (i.data.id || i.data.media_key)) || i.id || i.media_id_string || '');
  if (!id) throw new Error('X media : initialize sans identifiant');
  for (let k = 0, n = 0; k < mp4.length; k += MORCEAU, n++) {
    await appelX('/2/media/upload/' + id + '/append', { media: mp4.slice(k, k + MORCEAU).toString('base64'), segment_index: n }, prendre);
  }
  let fin = await appelX('/2/media/upload/' + id + '/finalize', {}, prendre);
  let info = (fin.data || fin).processing_info;
  for (let tour = 0; info && (info.state === 'pending' || info.state === 'in_progress'); tour++) {
    if (tour >= 60) throw new Error('X media : la video n est pas prete apres 60 lectures');
    await dors(Math.min(30, Math.max(1, Number(info.check_after_secs) || 5)) * 1000);
    const st = await appelXGet('/2/media/upload', { command: 'STATUS', media_id: id }, prendre);
    info = (st.data || st).processing_info;
  }
  if (info && info.state === 'failed') throw new Error('X media : traitement de la video rate' + (info.error && info.error.message ? ' — ' + String(info.error.message).slice(0, 100) : ''));
  return id;
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
    return { jours, annonces: j.annonces || {} };
  } catch (e) { return { jours: {}, annonces: {} }; }
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
    const v = fs.readdirSync(DOSSIER_IMAGES()).filter((f) => /\.mp4$/.test(f)).sort();
    for (const f of v.slice(0, Math.max(0, v.length - 5))) fs.unlinkSync(path.join(DOSSIER_IMAGES(), f));
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
    if (!o.special && (entree.annonce || annonceEnAttente(journal, o.annonce))) return await posteAnnonce(cle, entree, journal, t, o);
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
      if (entree.rendu === undefined || entree.cadrage === undefined) {
        const ch = choixImage(cle, scene, journal);
        entree.rendu = ch.rendu; entree.cadrage = ch.cadrage;
      }
      const g = await genereImageVerifiee(promptImage(scene, cle, { rendu: entree.rendu, cadrage: entree.cadrage }), o.prendre);
      png = g.png; fs.writeFileSync(fichierImage, png);
      entree.image = nomImage(cle) + '.png'; entree.jetonsImage = g.jetons; entree.pattes = g.controle;
      journal.jours[cle] = entree; ecritJournal(journal);
    }
    /* `special.texte` (27/09) : un texte ecrit a l avance part tel quel (nettoie seul : longueur, lien). */
    if (!entree.texte && o.special && o.special.texte) {
      /* Les paragraphes gardes (nettoie les ecrase) ; trop long : nettoie coupe proprement. */
      const lien = o.special.lien || '', brut = String(o.special.texte).trim();
      entree.texte = brut.length + (lien ? lien.length + 2 : 0) <= 280 ? brut + (lien ? '\n\n' + lien : '') : nettoie(brut, lien || false, null);
      entree.via = 'impose';
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
    journal.jours[cle] = entree;
    /* L annonce ratee trois fois : abandonnee, le creneau suivant redevient normal. */
    if (entree.annonce && entree.essais >= 3) journal.annonces = Object.assign(journal.annonces || {}, { [entree.annonce]: { abandon: true, cle, erreur: entree.erreur } });
    ecritJournal(journal);
    console.error(`[x] rate ${cle} (${entree.essais}/3) : ${entree.erreur}`);
    return { etat: 'rate', cle, essais: entree.essais, erreur: entree.erreur };
  } finally {
    enCours = false;
  }
}

/** Le creneau de l annonce : la video d abord, sur le disque (un refus de X
 *  plus loin ne la fait pas payer deux fois), puis le texte, puis X. */
async function posteAnnonce(cle, entree, journal, t, o) {
  const e = env();
  const a = o.annonce || ANNONCE;   /* `o.annonce` : les essais rejouent une annonce en video */
  entree.annonce = a.nom; entree.scene = 'annonce-' + a.nom;
  /* Une annonce en image : le fichier du depot, tel quel — rien a generer, rien a payer. */
  const img = a.image ? fs.readFileSync(path.join(__dirname, a.image)) : null;
  if (img) entree.imageAnnonce = a.image;
  fs.mkdirSync(DOSSIER_IMAGES(), { recursive: true });
  const fichier = path.join(DOSSIER_IMAGES(), nomImage(cle) + '.mp4');
  let mp4;
  if (img) mp4 = null;
  else if (entree.video && fs.existsSync(fichier)) mp4 = fs.readFileSync(fichier);
  else {
    const v = await genereVideo(a.prompt, a.duree, o.prendre, o.pause);
    mp4 = v.mp4; fs.writeFileSync(fichier, mp4);
    entree.video = nomImage(cle) + '.mp4'; entree.coutVideoUsd = v.coutUsd;
    journal.jours[cle] = entree; ecritJournal(journal);
  }
  if (!entree.texte) {
    const r = await ecritTexte(faitsDuJour(t), { scene: { nom: entree.scene, prompt: a.scene }, cle, maintenant: t,
      angle: 'viral launch announcement: hype, one clear hook, make people want to try it now', sujet: a.sujet, reserve: a.reserve,
      lien: a.lien, precedents: dernieres(journal, 5).map((x) => x.texte) }, o.prendre);
    entree.texte = r.texte; entree.via = r.via;
    journal.jours[cle] = entree; ecritJournal(journal);
  }
  const mediaId = img ? await televerse(img, o.prendre) : await televerseVideo(mp4, o.prendre, o.pause);
  const id = await publie(entree.texte, mediaId, o.prendre);
  entree.id = id; entree.quand = new Date(t).toISOString(); delete entree.erreur;
  journal.jours[cle] = entree;
  journal.annonces = Object.assign(journal.annonces || {}, { [a.nom]: { cle, id, quand: entree.quand } });
  ecritJournal(journal);
  purgeImages();
  console.log(`[x] annonce ${a.nom} postee en ${img ? 'image' : 'video'} ${cle} · https://x.com/${e.compte}/status/${id}`);
  if (o.signale) {
    try { o.signale({ cle, texte: entree.texte, id, image: null, url: `https://x.com/${e.compte}/status/${id}` }); }
    catch (x) { /* le Telegram ne fait pas rater le post */ }
  }
  return { etat: 'poste', cle, id, texte: entree.texte, scene: entree.scene, annonce: a.nom };
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

/* ---- LES POSTS PROGRAMMES (27 septembre 2026) ----
 * Un post special a heure fixe, une fois : sa cle est calculee sur SON heure
 * (`maintenant: p.a`), donc un redeploiement ou minuit ne le reposte pas ; au-dela
 * de PROGRAMME_RETARD_MS apres l heure, il est abandonne sans rien poster.
 * « Fais un post X viral sur x402, PayAI et notre agentic, programme-le, et
 * fais une image en rapport » (27/09, 00 h 35 a Paris). Faits verifies le meme
 * soir : 15 outils au catalogue public de PayAI (/discovery/resources),
 * payables en USDC sur Base et Solana (et Robinhood Chain), dont
 * chat_completion (Claude, GPT-6, Grok). Le lien (0,20 $ au lieu de 0,015 $
 * chez X) : c est un post de lancement, il doit mener quelque part. */
const PROGRAMME_RETARD_MS = 2 * 3600e3;
const PROGRAMMES = [
  { nom: 'x402-payai', a: Date.parse('2026-09-27T22:55:00Z'), lien: 'https://swoleeswoge.dog/swogeagentic.html',
    sujet: 'SWOGE AI agents are live on the PayAI x402 catalog: 15 tools any AI agent can pay per call in USDC on Base or Solana, no account, no API key.',
    texte: 'AI agents can now hire SWOGE 🤖💪\n\n15 tools on the PayAI x402 catalog: token scans, "can I sell?", Robinhood Chain reads, Claude, GPT and Grok per call.\n\n'
      + 'No account. No API key. Just USDC, Base or Solana.\n\nThe dog has an API now. $SWOGE',
    prompt: 'standing behind the counter of a futuristic neon "API shop" at night, calmly serving a long queue of small friendly robot AI agents; each robot drops a glowing blue coin '
      + 'into a slot and receives a glowing data cube from him; holographic screens behind him show charts and a big glowing padlock opening; confident smirk, cinematic lighting' },
  /* 05/10/2026 : « un post pour dire que notre launchpad est pas cher, rapide, sans alerte, et s affiche sur DexScreener ».
   * Chaque affirmation a ete verifiee AVANT d etre ecrite, sur la vraie paire test que le proprietaire a montree
   * (DexScreener robinhood/0x4e3e…2584, c est le POOL ; token derriere : 0xaba8…b16d « SWV4WTEST », pair WETH, UniswapV3, fee 1 %) :
   *   - PRIX : launchpad.html → « 0.0001 ETH, or 10,000 $SWOGE burned » (lu, pas devine).
   *   - SANS ALERTE : GoPlus chaine 4663 sur le token, le 05/10 — honeypot 0, mintable 0, open_source 1, owner 0x0 (renonce),
   *     takeback 0, hidden_owner 0, selfdestruct 0, blacklist 0, pausable 0, anti_whale 0. Sur une paire WETH GoPlus SIMULE le
   *     swap : buy_tax « 0 » / sell_tax « 0 » — connus et NULS (contrairement a la paire a quote Robinhood ou la taxe reste « inconnu »).
   *     Donc ici « every flag green, 0 % tax » est litteralement vrai, verifiable par n importe qui sur GoPlus.
   *   - DEXSCREENER : la page du pool s affiche (is_in_dex 1, UniV3). On evite « instant » : l API token de DexScreener
   *     n indexe pas encore les pools v3/v4 de test (0 paire renvoyee), donc on dit « live on DexScreener », pas « indexe a la seconde ».
   * Image : prompt dedie, passe par genereImageVerifiee → le controle pattes-de-chien (verifiePattes) s applique tout seul. */
  { nom: 'launchpad-cheap', a: Date.parse('2026-10-06T16:00:00Z'), lien: 'https://swoleeswoge.dog/launchpad.html',
    sujet: 'Launching a token on the SWOGE launchpad is cheap (0.0001 ETH or 10,000 $SWOGE burned), fast, has a clean GoPlus security report (no honeypot, not mintable, open-source, ownership renounced, 0% tax) and the pool shows up on DexScreener.',
    texte: 'Launch your token on SWOGE 🐕\n\n'
      + 'Cheap: 0.0001 ETH or 10,000 $SWOGE burned. No subscription, no hidden cut.\n'
      + 'Clean: every GoPlus flag green — no honeypot, not mintable, open-source, ownership renounced, 0% tax.\n'
      + 'Live on DexScreener. 🚀',
    prompt: 'pressing a big glowing green launch button on a sleek futuristic mission-control console at night; behind him a small rocket shaped like a dog bone blasts off, '
      + 'trailing bright green light; holographic screens show a candlestick chart spiking and a large green checkmark security shield; confident grin, cinematic neon lighting' },
];
async function programmes(o) {
  const t = (o && o.maintenant) || Date.now();
  const journal = litJournal(), faits = [];
  for (const p of (o && o.liste) || PROGRAMMES) {
    if (t < p.a) continue;
    const cle = jourDe(p.a) + '#' + String(p.nom).replace(/[^0-9A-Za-z-]+/g, '-').slice(0, 24);
    const e = journal.jours[cle] || {};
    if (e.id || e.abandonne || (e.essais || 0) >= 3) continue;
    if (t - p.a > PROGRAMME_RETARD_MS) {
      journal.jours[cle] = Object.assign(e, { abandonne: true, erreur: 'trop tard : plus de 2 h apres l heure prevue' }); ecritJournal(journal);
      console.log(`[x] programme ${p.nom} abandonne (trop tard)`); continue;
    }
    faits.push(await tache(Object.assign({}, o, { maintenant: p.a, special: { nom: p.nom, sujet: p.sujet, prompt: p.prompt, texte: p.texte, lien: p.lien } })));
  }
  return faits;
}

/** Dans le serveur : un regard toutes les cinq minutes, le journal decide. */
function planifie(signale) {
  if (!enabled()) {
    console.log('[x] posts ETEINTS : il manque ' + manque().join(', '));
    return null;
  }
  const e = env();
  console.log(`[x] posts ARMES a ${e.heures.join(' et ')} (${e.fuseau})`);
  const tour = () => tache({ signale }).catch((x) => console.error('[x] ' + (x.message || x)))
    .then(() => programmes({ signale })).catch((x) => console.error('[x] programme : ' + (x.message || x)));
  const premier = setTimeout(tour, 120000);
  const minuterie = setInterval(tour, 5 * 60000);
  return { arrete() { clearTimeout(premier); clearInterval(minuterie); } };
}

module.exports = { enabled, manque, env, enc, signeOAuth, SCENES, RENDUS, CADRAGES, NEGATIF, ANGLES, renduDe, sceneSuivante, promptImage, choixImage,
                   ANNONCE, annonceEnAttente, genereVideo, televerseVideo, appelXGet, FENETRE_SCENES, FENETRE_RENDUS, FENETRE_CADRAGE, faitsDuJour, etiquettes,
                   nettoie, ecritTexte, genereImage, verifiePattes, genereImageVerifiee, televerse, publie, tache, planifie, derniere, reprend, programmes, PROGRAMMES, PROGRAMME_RETARD_MS,
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
