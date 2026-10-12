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
 * Depuis le 11 octobre 2026, chaque creneau parle d UN produit ou d UNE
 * nouveaute, avec une scene de ce produit ; l angle ne regle plus que le ton
 * (voir « CHAQUE POST PARLE D UN PRODUIT » plus bas).
 *
 * ---- ce que ca coute, mesure le 18 septembre 2026 ----
 *
 *  - l image : 6 893 jetons de sortie pour une 1536x1024 en qualite high
 *    avec gpt-image-1.5, a 32 $ le million → environ 0,22 $ ;
 *  - le texte : quelques centaines de jetons, moins d un centime (deux appels
 *    depuis le 11/10 : l auteur, puis le second regard, `jugeTexte`) ;
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
    modeleJuge: process.env.X_MODELE_JUGE || process.env.X_MODELE_TEXTE || 'claude-sonnet-5',
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
  /* Le tango a trois pattes (liaison d un compte) : request_token n a pas encore
     de jeton (on le retire), et oauth_callback / oauth_verifier entrent dans la
     signature ET dans l en-tete. Un tweet normal ne passe rien de tout cela. */
  if (!cles.at) delete oauth.oauth_token;
  if (o.oauthExtra) Object.assign(oauth, o.oauthExtra);
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

/* ==========================================================================
 * CHAQUE POST PARLE D UN PRODUIT (11 octobre 2026)
 *
 * Demande du proprietaire, 11/10/2026 : « on a mis des tweets automatiques
 * pour 4 fois dans la journee, mais ca serait bien que ca soit concentre plus
 * sur les produits qu on a [...] sur les nouvelles mises a jour qu on fait et
 * sur les produits qu on a exactement. Donc on a le betting, on a le SWOGE
 * World, on a le casino, etc. Et ca serait bien qu on parle de ca dans les
 * tweets, a chaque fois. » Elle REMPLACE celle du 18/09 (« pas forcement
 * parler du site, juste faire un tweet bullish ») : huit angles sur onze
 * interdisaient alors de nommer quoi que ce soit.
 *
 * Desormais chaque creneau choisit UN sujet avant d ecrire :
 *  1. une NOUVEAUTE de moins de NOUVEAUTE_FRAICHE_JOURS jours, jamais tweetee
 *     (puis au plus une fois de plus, NOUVEAUTE_RETOUR_JOURS jours apres) ;
 *  2. sinon le produit suivant de la ROTATION, ou paris, SWOGE World et casino
 *     — les trois que le proprietaire nomme — reviennent plus souvent.
 * Le modele recoit le nom du produit, UN fait vedette et deux faits voisins,
 * rien d autre : il ne peut citer que ce qui est ecrit ici. L ANGLE ne choisit
 * plus que le TON.
 *
 * Un tweet est PUBLIC. Chaque fait ci-dessous a ete relu le 11/10/2026 dans le
 * code pousse sur main (serveur d592de0, site 01d2818) ou sur la page publique,
 * et porte sa preuve (fichier:ligne ou commit). Un fait qui depend d une
 * variable Railway (non lue) n est pas ecrit en dur : il porte une `condition`
 * evaluee au moment du post sur ce que le processus lit vraiment (prix au
 * marche, reglement automatique), ou il est calcule depuis `cfg` (mise minimum,
 * nombre de selections). Ce qui n est PAS vendu (pari en direct, plus/moins au
 * prix du marche, coupes : en OBSERVATION) n est nulle part — et
 * MOTS_INTERDITS le refuse si le modele l invente.
 *
 * AJOUTER UNE NOUVEAUTE : une ligne dans NOUVEAUTES (id, date du jour ou elle
 * est en ligne, produit, texte en anglais de 208 signes au plus, preuve).
 * x_post.test.js refuse une ligne sans preuve, trop longue, qui ne nomme pas
 * son produit ou qui porte un mot interdit.
 * ======================================================================== */
const VERIFIE = '2026-10-11';
const fmt = (n) => Number(n).toLocaleString('en-US');

/* Les onze championnats secondaires passes au prix du marche le 09/10/2026 par
   la variable PARIS_PRIX_LIGUES (paris_import.js:159-169, EXPLOITATION.md 8.8quinquies).
   La variable n est pas lue d ici : on ne dit « 17 » que si `prix_ligues.ligues()`
   le confirme dans le processus qui poste. */
const SECONDAIRES = ['soccer_efl_champ', 'soccer_france_ligue_two', 'soccer_germany_bundesliga2', 'soccer_spain_segunda_division',
  'soccer_italy_serie_b', 'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga', 'soccer_belgium_first_div',
  'soccer_turkey_super_league', 'soccer_usa_mls', 'soccer_mexico_ligamx'];

/* Les images de chaque produit : sa scene a lui (celle de l inventaire du
   11/10, reecrite sans personnage puisque PERSONNAGE le porte, et sans texte,
   ecran de trading ni courbe puisque NEGATIF les refuse), plus des scenes de
   la banque qui lui vont. Une scene du produit tourne : la moins recemment
   postee d abord (sceneProduit), le rendu et le cadrage tournent par-dessus. */
const SCENES_PRODUITS = [
  { nom: 'tunnel', prompt: 'bursting out of the players\' tunnel into a packed stadium, a match ball tucked under one front paw, the other paw raised to the roaring crowd',
    monde: 'a floodlit soccer stadium at night, bright green pitch, confetti drifting through white floodlights, a wall of scarves in the stands' },
  { nom: 'nexus', prompt: 'standing proud in a pixel-art town square, a tiny shiba puppy pet trotting at his side, a few small pixel adventurers in the background',
    monde: 'a glowing 2.5D pixel-art plaza at night, a stone fountain, a swirling blue portal and a swirling crimson portal at the edge of the square, a lava glow on the far horizon' },
  { nom: 'oeuf', prompt: 'kneeling on mossy stone as a speckled glowing egg cracks open between his paws and a tiny pixel shiba puppy peeks out',
    monde: 'a hidden pixel-art grove at dusk, fireflies, soft violet and teal light, ancient standing stones' },
  { nom: 'table', prompt: 'leaning over a glowing green blackjack table, sliding a tall stack of blank gold chips forward with one huge paw, playing cards frozen mid-air around him',
    monde: 'a neon-lit casino at night, a tall board of glowing pegs on the wall behind him, warm gold and purple light on his muscles' },
  { nom: 'plinko', prompt: 'dropping a single glowing ball into a giant board of brass pegs twice his height, watching it bounce with a calm grin',
    monde: 'a dark velvet game hall, the peg board lit from within in warm amber, deep purple shadows' },
  { nom: 'rampe', prompt: 'on a rooftop launch pad as a small dog-bone-shaped rocket lifts off on a bright green trail, a tiny friendly robot sidekick waving from it, his other paw resting on a heavy steel vault door sealed with a glowing chain',
    monde: 'a neon city at dusk seen from a rooftop, magenta sky, cool blue city lights far below' },
  { nom: 'pont', prompt: 'striding across a glowing suspension bridge that links two floating islands, a small travel bag over one shoulder',
    monde: 'two floating islands above a sea of clouds at sunrise, the bridge glowing soft gold, pastel pink and blue sky' },
  { nom: 'village', prompt: 'sitting at the center of a night village of tiny friendly robot agents, a satellite-dish scout, a shield-bearing guard, a little whale-shaped watcher and a crystal-ball oracle, each carrying a glowing blue cube to him',
    monde: 'a cozy village square at night, warm lanterns, soft neon accents, blank letterless speech bubbles drifting upward' },
  { nom: 'popcorn', prompt: 'lounging in a red velvet cinema seat with a giant popcorn bucket, watching a tall vertical movie screen that shows a cartoon tropical island at sunset on one half and an electric-blue time portal on the other',
    monde: 'a dark cinema room, a projector beam cutting through the air, empty rows around him, warm gold and cool blue light' },
  { nom: 'projection', prompt: 'in a cramped projection booth, carefully threading a film reel onto an old projector, the beam already shining through the little window',
    monde: 'a tiny projection room, warm tungsten light, dust in the beam, film cans stacked on wooden shelves' },
];

/* ---- LE CATALOGUE ----
 * `nom` : le nom public, tel que le tweet doit l ecrire ; `motsCles` : ce qui
 * compte comme « le tweet le nomme » ; `faits` : { id, texte, preuve, verifie,
 * nom? (un volet du produit, ex. le launchpad dans le portefeuille),
 * condition? (lecture vivante) } ; `reserves` : des textes vrais si le modele
 * se tait ou se trompe ; `interdits` : ce que CE produit ne doit jamais dire,
 * en plus de MOTS_INTERDITS. Les six produits suivent les six groupes de
 * l inventaire verifie du 11/10 (le portefeuille et le launchpad y forment un
 * seul produit, SWOGE AI et SWOGE Agents un autre). */
const PRODUITS = [
  { cle: 'bet', nom: 'SWOGE Bet', motsCles: /SWOGE Bet\b/i, lien: 'https://swoleeswoge.dog/swogebet.html',
    scenes: ['tunnel', 'foot', 'tennis', 'hockey'],
    faits: [
      /* Aucun domaine nu dans un fait (relecture du 11/10) : X fait un lien de « swoleeswoge.dog »
         comme de « Pump.fun », et un post avec lien coute 0,200 $ au lieu de 0,015 $ (en tete). */
      { id: 'carnet', texte: 'SWOGE Bet is our sportsbook: real fixtures, and your odds are locked in the moment you place the bet.',
        preuve: 'site swogebet.html:108 (title), :3966 « Odds are locked in when you place the bet. Nothing changes them afterwards. »' },
      { id: 'swogebet', texte: 'Bets on SWOGE Bet are played in $SWOGEBET only: deposit it in the bet vault, and winnings come back to your $SWOGEBET bet balance.',
        preuve: 'site swogebet.html:2574 ; serveur game.js:3746, 3796, 3811 (jeton swogebet), 4424-4426 (_crediteTicket)' },
      { id: 'paire', texte: '$SWOGEBET is paired with $SWOGE and nothing else, so buying $SWOGEBET for SWOGE Bet buys $SWOGE first.',
        preuve: 'site whitepaper.html:2786-2790 (section 41 « Buying it buys $SWOGE first, even when the buyer pays in ETH »)' },
      { id: 'achat', texte: 'No $SWOGEBET yet? The SWOGE Bet page links its DexScreener pair on Robinhood Chain, so you can pick some up before your first bet.',
        preuve: 'site swogebet.html:2731-2732 (carte BUY $SWOGEBET), :2780 (dexscreener.com/robinhood/0xc129…924e)' },
      { id: 'sports', texte: 'Seven sports have a tab on SWOGE Bet: soccer, tennis, NBA, NFL, cricket, NHL and MLB.',
        preuve: 'serveur paris.js:60-90 (SPORTS), paris_import.js:1263-1265 ; site swogebet.html:3457-3486' },
      { id: 'marches', texte: 'Soccer matches on SWOGE Bet carry six markets: match result, double chance, both teams to score, over/under 2.5 goals, handicap -1.5 and correct score.',
        preuve: 'serveur paris.js:169-252 (MARCHES) ; site swogebet.html:3333-3344, index.html:1179' },
      { id: 'combines', texte: `Accumulators of up to ${fmt(cfg.PARI_JAMBES_MAX)} selections on SWOGE Bet, one per match: the odds multiply, and one wrong pick loses the whole slip.`,
        preuve: 'serveur config.js:1465 (PARI_JAMBES_MAX, lu dans le processus qui poste), game.js:3681-3682, 3701 ; site swogebet.html:3964-3966' },
      { id: 'mise', texte: `The minimum stake on SWOGE Bet is ${fmt(cfg.PARI_MIN)} $SWOGEBET a slip.`,
        preuve: 'serveur config.js:1423 (PARI_MIN, lu dans le processus qui poste) ; site whitepaper.html:2826' },
      { id: 'prix-marche', condition: (v) => !!v.sixGrands,
        texte: 'On SWOGE Bet, the Premier League, La Liga, Serie A, Bundesliga, Ligue 1 and the Champions League are priced off the betting market (Betfair, else Pinnacle, else the median of the books), with the house margin added.',
        preuve: 'serveur prix_ligues.js:16-17 (LIGUES_DEFAUT), prix_marche.js:32-37 (ordre des references) ; commit d856863. Condition : les six cles dans prix_ligues.ligues()' },
      { id: 'elo', texte: 'SWOGE Bet prices tennis, NBA, NFL, NHL, MLB and cricket with its own Elo ratings, recalibrated every week.',
        preuve: 'serveur paris.js:631 (aLElo) ; EXPLOITATION.md:481 (etalonnage hebdomadaire de paris_notes.json)' },
      /* « soccer » (seconde relecture du 11/10) : le tennis n a ni tableau ESPN (paris_import.js:1430-1433)
         ni verrou d heure reelle (paris.js:603-607) ; le football, lui, a un chemin ESPN pour chaque
         championnat vendu (scores_espn.js:47, CHEMINS). */
      { id: 'fermeture', texte: 'Betting on a soccer match on SWOGE Bet closes at kickoff, checked against the real start time on ESPN, not just the schedule.',
        preuve: 'serveur paris.js:506-511 (ouverts), :576-610 (ouvert : etat ESPN in/post, heure ESPN moins 60 s), scores_espn.js:47-70 (CHEMINS, un tableau par championnat de football vendu)' },
      /* Le tableau LIVE NOW (scores des matchs en cours) est RETIRE a la seconde relecture du 11/10 : vrai,
         mais c est l appat du pari en direct, qui n est pas vendu (paris_en_jeu.js n est pas sur main) —
         ses paraphrases (« real-time betting », « bet while you watch », « scores update live », faux
         aussi : la page ne redemande parisListe qu a hello et auth, swogebet.html:4085-4105) passaient. */
      /* Sans « from ESPN » : le tennis se regle par le /scores de The Odds API (paris_import.js:1430-1433). */
      { id: 'reglement', condition: (v) => !!v.auto,
        texte: 'SWOGE Bet settles on its own: once the final score is in and a safety delay has passed, winning slips are paid to your $SWOGEBET bet balance, no claim needed.',
        preuve: 'serveur paris_import.js:1726-1730 (PARIS_AUTO, AUTO_DELAI_MIN 90) ; game.js:4320-4332, 4424-4426 (_crediteTicket : betBalance, pas le portefeuille). Condition : PARIS_AUTO different de 0 dans le processus' },
      { id: '90min', texte: 'Soccer bets on SWOGE Bet settle on the 90-minute score. Extra time and penalties don\'t count.',
        preuve: 'serveur scores_espn.js:255-257 (FOOT_REGLEMENTAIRE), commit 1a9dcd6' },
      { id: 'coffre', texte: 'The SWOGE Bet vault is its own on-chain contract, verified on Blockscout, and withdrawals are signed vouchers that you cash yourself.',
        preuve: 'site whitepaper.html:2800-2805' },
      { id: 'casino', texte: 'Your SWOGE Bet balance also plays in the SWOGE casino and at the SWOGE World blackjack table: pick Stake from: Bet $SWOGEBET, and wins come back in $SWOGEBET.',
        preuve: 'site coffre.js:130-135 (libelles), commits a1c2b88, 0e3bb9d, 086f639 ; serveur game.js:4442-4461, commit 358bf8a' },
    ].map((f) => Object.assign({ verifie: VERIFIE }, f)),
    reserves: [
      'SWOGE Bet: real fixtures, and your odds lock in the moment you place the bet. Nothing changes them after. 🏟️🐕',
      'Seven sports, one sportsbook. SWOGE Bet covers soccer, tennis, NBA, NFL, cricket, NHL and MLB, played in $SWOGEBET only. ⚽🐕',
    ],
    /* En anglais americain « football » est la NFL ; « $SWOGE Bet » est un faux nom ; le carnet n est
       pas « provably fair » (c est le vocabulaire du casino) ; les cotes ne sont pas sur la chaine ;
       aucune mise maximum (la page et le serveur se contredisent) ; jamais « copie du livre ».
       Relecture du 11/10 : le pari en jeu se dit aussi « in-game », « in-running » ; aucun cash-out
       (un pari reste jusqu au reglement) ; aucune cadence du tableau LIVE NOW (il ne se rafraichit pas seul). */
    /* Seconde relecture du 11/10, 130 textes adverses :
       - le pari en direct, paraphrase (« Real-time betting », « live wagering », « bet while you watch »,
         « place your bets after kickoff », « halftime bets », « next goal markets », « matches already
         under way ») : « live » n est permis que dans « is live » / « now live » (le produit est en ligne) ;
       - le prix du marche etendu a ce qui ne l a pas : prix_marche.js ne releve que le h2h (:152), le
         plus/moins au total des livres est en OBSERVATION (87528fc), le tennis est a l Elo ou suspendu
         (paris.js:603-607) — refuse un marche, un sport ou « tous » dans la MEME phrase que le marche ;
       - le paiement : la passe quotidienne attend jusqu a 24 h (paris_import.js:1737-1742) et le gain va
         au solde des paris, pas au portefeuille (game.js:4424-4426). */
    interdits: [/\bfootball\b/i, /\$SWOGE Bet\b/, /provably fair/i, /on[- ]?chain odds|odds (are |live )?on[- ]?chain/i, /no sign[- ]?up/i,
      /\bmax(imum)? (stake|bet)\b|\bup to [\d,]+ \$SWOGEBET/i, /copied|straight from\b|\b(fair|true|raw) odds\b|\bminus\b|\bidentical\b/i, /every bet is (announced|posted)/i,
      /\bin[- ](game|match|running)\b/i, /\bcash(es|ed|ing)?[- ]?out\b/i, /\brefresh\w*|\bupdates? every\b|\bevery \w+ seconds\b/i,
      /(?<!\b(?:is|are|went|goes|go|now) )\blive\b|\blive[\s-]+(?!(and|now|on|today|for|to|in|with)\b)[a-z]/i,
      /\breal[- ]?time\b|\b(half|full)[- ]?time\b|\bnext goal\b|\bunder ?way\b|\bin progress\b|\bsecond[- ]half\b|\bwhile (you('re)? |u )?watch\w*|\bunfold\w*|\bstream\w*/i,
      /\b(over|under|O\/U|goal lines?|total goals|handicaps?|correct score|both teams|BTTS|double chance|(every|all|each) (markets?|sports?|leagues?|matches|games)|tennis|NBA|NFL|NHL|MLB|cricket)\b[^.!?\n]*\b(\bmarket\b|Betfair|Pinnacle|exchange|the books)\b|\b(\bmarket\b|Betfair|Pinnacle|exchange|the books)\b[^.!?\n]*\b(over|under|O\/U|goal lines?|total goals|handicaps?|correct score|both teams|BTTS|double chance|(every|all|each) (markets?|sports?|leagues?|matches|games)|tennis|NBA|NFL|NHL|MLB|cricket)\b/i,
      /\bwhistle\b|\b(to|into|in) your wallet\b/i,
      /* Ce qui n est pas au carnet : props, combines du meme match (une selection par match), esport,
         F1, UFC… ; un marche ou un sport dit d un autre ; le tennis sur ESPN ; un paiement « the moment »
         ou « within the hour » ; paye en autre chose que $SWOGEBET ; « worldwide », « legal ». */
      /\bprops?\b|\bsame[- ]game\b|\besports?\b|\bF1\b|\bUFC\b|\bMMA\b|\bboxing\b|\bhorse\w*/i,
      /\bmarkets?\b[^.!?]{0,20}\b(tennis|NBA|NFL|NHL|MLB|cricket)\b|\btennis\b[^.!?]*\bESPN\b|\bESPN\b[^.!?]*\btennis\b/i,
      /\bthe moment\b(?! you place)|\bwithin\b|\bafter\b[^.!?]{0,20}\b(goal|kick[- ]?off|start|whistle)\b|\bpaid (out )?(in|with) (?!\$?SWOGEBET)|\bdoubl(es|ed|ing)\b|\btripl\w*/i,
      /\bworldwide\b|\bglobal(ly)?\b|\blegal\w*|\bstates?\b|\bcountr(y|ies)\b/i] },

  { cle: 'world', nom: 'SWOGE World', motsCles: /SWOGE World\b/i, lien: 'https://swoleeswoge.dog/nexus.html',
    scenes: ['nexus', 'oeuf', 'portail', 'mine'],
    faits: [
      { id: 'monde', texte: 'SWOGE World is our multiplayer pixel game: you land in the Nexus, a hub where you watch the other players walk around live.',
        preuve: 'site index.html:1009, :1314, games.html:1068-1069, nexus.js:2-12 ; serveur server.js:9843-9847 (nexusEtat, sur main d592de0)' },
      /* « The SWOGE World Nexus is drawn in 2.5D pixel art » retire le 11/10 : le commit 0b9fd0e n a
         refait en 2,5D (rendu, pas pixel) que les cinq batiments de la place, sur un sol vu de dessus,
         et nexus.js:3420-3428 sont les libelles de l editeur de cartes. */
      { id: 'gratuit', texte: 'Every account gets a free character in SWOGE World, so anyone who signs in can play.', preuve: 'serveur skins.js:83-95 (OFFERT)' },
      { id: 'persos', texte: 'SWOGE World has six playable characters, each with its own level, its own XP and 8 RPG stats: HP, MP, ATT, DEF, SPD, DEX, VIT and WIS.',
        preuve: 'serveur skins.js:55-62 (6 SKINS, compte le 11/10), personnages.js:4-9, 44-53' },
      { id: 'niveau', texte: 'Characters in SWOGE World level up to 20.', preuve: 'serveur personnages.js:121 (NIVEAU_MAX = 20) ; site index.html:1142, 1155' },
      { id: 'equipement', texte: 'Each SWOGE World character has four gear slots: a power fruit, a weapon, armor and a ring.', preuve: 'site nexus.js:1161 (EMPLACEMENTS)' },
      { id: 'anneaux', texte: 'The SWOGE World map is built in rings, calm plains at the edge and a lava core in the middle. The closer you get to the center, the harder it hits.',
        preuve: 'serveur monde.js:21-28, 61-67 (ANNEAUX)' },
      { id: 'monstres', texte: 'SWOGE World has 34 monster types, and 19 of them roam the open world.',
        preuve: 'serveur monde.js:2156 (MONSTRES, 34 cles), 3367-3420 (PEUPLEMENT, 19 especes) ; comptes en requerant monde.js le 11/10' },
      { id: 'donjons', texte: 'Four dungeons in SWOGE World, each with its own boss: The Forge, Pirate Cave, Cinder Sanctum and The Storm Arena.',
        preuve: 'serveur monde.js:169-345 (DONJONS)' },
      { id: 'portail', texte: 'In SWOGE World some monsters rip open a dungeon portal when they die. It stays open 40 seconds, and anyone in that world can jump in.',
        preuve: 'serveur monde.js:378-386 (PORTAIL.duree 40), :404 ; server.js:10295-10318 (sur main d592de0)' },
      { id: 'arene', texte: 'The Storm Arena has its own portal in the SWOGE World Nexus: a solo boss fight you can run again and again.',
        preuve: 'site nexus.js:6964-6974 ; serveur server.js:8527-8554 (une salle par joueur, sur main d592de0)' },
      { id: 'crimson', texte: 'The Crimson Reach is the PvP world of SWOGE World, and loot there never drops below Legendary.',
        preuve: 'site nexus.js:6961-6963 ; serveur server.js:957 (PLANCHER_CRIMSON legendaire), :978-985 (pvp: true, sur main d592de0)' },
      { id: 'pvp', texte: 'Get taken down by another player in the SWOGE World Crimson Reach and you only drop what you picked up on that run. Your gear, your level and your vault come home with you.',
        preuve: 'serveur server.js:10327-10345 (sur main d592de0) ; site nexus.js:10803-10804' },
      { id: 'mort', texte: 'Die to a monster in SWOGE World and your character goes back to level 0, losing the gear it wore and the loot it carried. Your vault stays safe.',
        preuve: 'serveur game.js:8192-8196, server.js:10321-10324, 10365 (sur main d592de0) ; site nexus.js:10805' },
      { id: 'reliques', texte: 'Relics are the one SWOGE World rarity you cannot buy. They only drop in the world.', preuve: 'serveur boutique.js:112-121 (relique)' },
      { id: 'oeufs', texte: 'Monsters in SWOGE World can drop eggs, about 1 in every 1,200 kills, in six kinds from the Plain Egg to the Prism Egg.',
        preuve: 'serveur monde.js:4441-4464 (chance 1/1200, 6 especes), game.js:143-149' },
      { id: 'familiers', texte: 'Hatched pets live in Petworld. Pick one and it follows you everywhere in SWOGE World.', preuve: 'site nexus.html:2939, nexus.js:7003-7005' },
      { id: 'familiers-niveau', texte: 'SWOGE World pets level up to 100. At level 1 a pet acts once a minute, and at level 100 it acts 20 times a minute.',
        preuve: 'serveur monde.js:3814-3836 (niveauMax 100, parMinute 1 -> 20)' },
      { id: 'blackjack', texte: 'The SWOGE World Nexus has a blackjack table on the same balance as the casino. The dealer stands on 17, and insurance is offered.',
        preuve: 'site nexus.html:2950, nexus.js:6613-6616, 7008 ; serveur game.js:6209' },
      { id: 'editeur', texte: 'SWOGE World has a Map Editor: players build their own maps, share them in a gallery and walk them together.',
        preuve: 'site nexus.html:3198, nexus.js:2702-2706 ; serveur server.js:8071-8165, 8455-8471 (sur main d592de0)' },
      /* Le prix vient de PRIX_MONDE_GOLD (variable d env, non lue d ici) : dit seulement s il est > 0 dans
         le processus qui poste. Verse chaque MOIS (server.js:7008-7016, game.verseMonde) ; le commentaire
         « chaque semaine » de config.js:347 est perime, le code et la page disent mois. */
      { id: 'classement', condition: () => cfg.PRIX_MONDE_GOLD > 0,
        texte: 'The SWOGE World leaderboard ranks living characters by XP. Die and you drop off it, and every month the top of the board splits a prize in in-game gold.',
        preuve: 'site nexus.js:11810-11815 ; serveur game.js:2761-2797, 2801-2818 (moisCle), 2837-2856 (verseMonde), server.js:7008-7016, config.js:361 (PRIX_MONDE_GOLD)' },
    ].map((f) => Object.assign({ verifie: VERIFIE }, f)),
    reserves: [
      'SWOGE World is a multiplayer pixel world: land in the Nexus and watch the other players walk around live. Every account gets a free character. 🎮🐕',
      'Four dungeons, four bosses. The Forge, Pirate Cave, Cinder Sanctum and The Storm Arena are waiting in SWOGE World. Bring your gear. ⚔️🐕',
    ],
    /* La salle de cinema est vide depuis le 27/09 (liens pirates retires) ; Manga et Series sont des
       facades ; le portail +18 mene a une ville vide ; aucun agent IA dans le monde ; pas de
       play-to-earn, l or ne sort pas du jeu ; les objets ne sont pas des NFT ; personnages de tiers
       (Boy's Club) et monstre au nom de marque jamais nommes ; aucun chiffre de joueurs invente.
       (Les NFT, le manga et le play-to-earn sont refuses par MOTS_INTERDITS, pour tous les produits.) */
    /* Seconde relecture du 11/10 : l or ne s echange contre rien (config.js:350-355) — ni retrait, ni
       cash-out, ni echange, ni vente, ni « real prizes » ; « AI-driven NPCs » ; « a growing player base ».
       (« earn » est refuse pour tous les produits, MOTS_INTERDITS.) */
    interdits: [/cinema|\bmovies?\b|\bfilms?\b|\bseries\b|\+18/i, /\bAI\b/i,
      /\bPepe\b|\bAndy\b|\bBrett\b|Landwolf|Optimus|Street Fighter/i, /thousands of players|\bmillions?\b|\bplayer ?base\b|\bgrowing\b/i, /provably fair|exclusive|premium/i,
      /\bwithdraw\w*|\bcash(es|ed|ing)?[- ]?out\b|\btrad(e|es|ed|ing|able|eable)\b|\bsell\w*|\bprize pool\b|\breal (money|value|rewards?|prizes?)\b|\bpaid\b|\bpay(s|outs?)?\b|\bon[- ]?chain\b/i,
      /\bpermanent\w*|\bpermadeath\b|\blose everything\b/i] },

  { cle: 'casino', nom: 'the SWOGE casino', motsCles: /SWOGE (casino|Games|Blackjack|Spin|Smash|Bonanza|Kennel|Poker)\b|DEAD SWOGE/i, lien: 'https://swoleeswoge.dog/games.html',
    scenes: ['table', 'casino', 'plinko'],
    faits: [
      { id: 'salle', texte: 'The SWOGE casino lists 11 games against the house, 4 against other players and 5 head-to-head 1v1 duels.',
        preuve: 'site games.html:1123-1125 (nb 11), 1205-1207 (nb 4), 1222-1224 (nb 5)' },
      { id: 'maison', texte: 'Against the house in the SWOGE casino: Blackjack Gold Table, SWOGE Spin, Casino Hold\'em, Three Card, Mines, Hi-Lo, Plinko, SWOGE Bonanza, SWOGE Kennel, DEAD SWOGE and SWOGE Smash.',
        preuve: 'site games.html:1133-1158' },
      { id: 'joueurs', texte: 'Against other players in the SWOGE casino: Boulier, SWOGE Poker, the shared Coin Pusher and Crash, plus 1v1 duels where the winner takes the stake.',
        preuve: 'site games.html:1205-1236' },
      /* Pas « every round » (relecture du 11/10) : Crash et le Boulier tirent d une chaine de hachage
         engagee d avance (crash.js:8-16, boulier_salle.js:63), le Poker a la graine de sa table
         (poker_room.js:45-58), les duels HMAC(graine, 'duel:id') sans graine client (game.js:10159).
         Graine serveur + graine client + nonce : verifie jeu par jeu ci-dessous.
         Sans « your client seed » (seconde relecture du 11/10) : la graine client est TIREE par le serveur
         (game.js:5677, crypto.randomBytes) et aucune page du site n envoie setClientSeed (server.js:7344 ;
         git grep vide sur le site 01d2818) — « your » laissait croire que le joueur la choisit. */
      { id: 'equitable', texte: 'Blackjack, Plinko, Mines and Hi-Lo in the SWOGE casino are provably fair: the server seed\'s SHA-256 hash is shown before you play, and the seed itself is published when it rotates.',
        preuve: 'serveur game.js:5537-5540 (_rotateSeed), 5585-5600 (tourneGraine, publie l ancienne), 6289 (blackjack), 6583 (hilo), 6691 (mines), 6766-6767 (plinko), casino.js:23-31 ; site swoge_blackjack.html:1931, swoge_casino.html:1904' },
      { id: 'graine', texte: 'When the SWOGE casino seed rotates, the old server seed is published so anyone can recompute every round played under it, and a rotation is refused while a hand is still open.',
        preuve: 'serveur game.js:5585-5600 (tourneGraine), 5551-5576 (partiesEnCours) ; site whitepaper.html:1482-1492' },
      { id: 'crash-chaine', texte: 'Crash in the SWOGE casino plays a pre-built hash chain backwards. The commitment is published before the first round, so the house cannot change a future round.',
        preuve: 'serveur crash.js:8-16, 57-70 ; site crash.html:2054-2058' },
      { id: 'crash-auto', texte: 'Crash in the SWOGE casino: everyone rides the same curve and cashes out when they want, and auto cash out fires on the server the instant the curve hits your target, even if your connection lags.',
        preuve: 'serveur crash.js:2-4, 36-39 ; site crash.html:1281, 1289' },
      { id: 'blackjack', nom: 'SWOGE Blackjack', texte: 'SWOGE Blackjack pays 3:2 on a blackjack, the dealer stands on 17, insurance pays 2:1, and there are Perfect Pairs and 21+3 side bets.',
        preuve: 'serveur game.js:6214, 6300, 6394-6396, config.js:1169-1171 ; site swoge_blackjack.html:1605-1616, 1637' },
      { id: 'side-bets', nom: 'SWOGE Blackjack', texte: 'SWOGE Blackjack side bets: Perfect Pairs pays up to 25 to 1, and 21+3 pays up to 100 to 1 on suited trips.',
        preuve: 'serveur config.js:1169 (BJ_PP_PAY parfaite 25), :1170 (BJ_213_PAY brelanServi 100), constantes hors env' },
      { id: 'plinko', texte: 'Plinko in the SWOGE casino: choose 8, 12 or 16 rows and low, medium or high risk. The ball\'s path is drawn from the seed first, and the animation just replays it.',
        preuve: 'serveur plinko.js:8-14, 35-36 ; site plinko.html:1669, 1187-1188' },
      { id: 'bonanza', nom: 'SWOGE Bonanza', texte: 'SWOGE Bonanza is a 6x5 grid that pays anywhere with 8+ matching symbols, with tumbling wins, multiplier bombs and a Buy bonus.',
        preuve: 'serveur bonanza.js:11-20 ; site swoge_bonanza.html:121, 1688' },
      { id: 'chenil', nom: 'SWOGE Kennel', texte: 'SWOGE Kennel: 5 reels and 20 fixed lines, Wilds that stay sticky during free spins, and a free-spin count that is drawn, not fixed.',
        preuve: 'serveur chenil.js:5-14, 36, 52-60 ; site swoge_chenil.html:121' },
      { id: 'dod', nom: 'DEAD SWOGE', texte: 'DEAD SWOGE: 5 reels and 243 ways. The Wild stretches to fill its reel and multiplies, and Wilds multiply together: three x3 Wilds make x27.',
        preuve: 'serveur dod.js:5-38 ; site swoge_dod.html:121' },
      { id: 'smash', nom: 'SWOGE Smash', texte: 'SWOGE Smash: smash the gem, and the top prize is 250x the bet.',
        preuve: 'serveur config.js:1114-1126 (SPIN_PRIZES, 250 au plus, constante) ; site swoge_smash.html:122' },
      { id: 'spin', nom: 'SWOGE Spin', texte: 'SWOGE Spin is the Volcano slot, with a Buy Bonus button.',
        preuve: 'site swoge_spin.html:118-123, 235 ; serveur game.js:6165, 6190' },
      { id: 'hilo-mines', texte: 'Hi-Lo in the SWOGE casino: call higher or lower and cash out whenever you like. Mines: a 5x5 grid where you pick how many bombs to play against.',
        preuve: 'serveur hilo.js:3-8, mines.js:5, 35 ; site games.html:1141-1144' },
      { id: 'three', texte: 'In Three Card at the SWOGE casino, a straight beats a flush, because three-card straights are rarer than flushes.',
        preuve: 'serveur casino.js:50-57 (eval3)' },
      { id: 'boulier', texte: 'Boulier in the SWOGE casino: pick 10 numbers out of 90, watch 30 balls drop, and hit 10 out of 10 for the progressive jackpot.',
        preuve: 'serveur boulier.js:3-7, 66-68 ; site boulier.html:121, 1488' },
      { id: 'poker', nom: 'SWOGE Poker', texte: 'SWOGE Poker is 6-max Texas Hold\'em with real players only, never a bot. A table with one player just waits for a second.',
        preuve: 'serveur poker_room.js:9, 47 ; site swoge_poker.html:122' },
      { id: 'email', texte: 'Sign in to the SWOGE casino with just your email and a wallet is created for you automatically. No app needed.',
        preuve: 'site crash.html:1483-1484' },
      { id: 'retrait', texte: 'Withdrawals from the SWOGE casino balance go straight to your wallet through a signed voucher.',
        preuve: 'site swoge_blackjack.html:1748 ; serveur game.js:4-11' },
      { id: 'deux-coffres', texte: 'Holders of $SWOGEBET can stake it on 12 SWOGE casino games with the Stake from: Vault $SWOGE / Bet $SWOGEBET selector, and wins come back in the same token.',
        preuve: 'site coffre.js:1-16, 100, 130-135 ; serveur game.js:4442-4461' },
      { id: 'chaine', texte: '$SWOGE and the SWOGE casino run on Robinhood Chain (chain 4663).', preuve: 'serveur config.js:102-103 ; site crash.html:121, plinko.html:121' },
    ].map((f) => Object.assign({ verifie: VERIFIE }, f)),
    reserves: [
      'Blackjack, Plinko, Mines and Hi-Lo in the SWOGE casino are provably fair: the seed\'s hash is shown before you play, and the old seed is published when it rotates. 🎰🐕',
      'Blackjack, Plinko, Crash, Mines, Hi-Lo, Poker and more. The SWOGE casino runs on Robinhood Chain, and you sign in with just your email. 🃏🐕',
    ],
    /* Aucun taux de retour ni avantage de la maison (plusieurs viennent de l env) ; l equite est un
       engagement du serveur, pas « sur la chaine » ; aucune page ne laisse choisir sa graine ; pas
       de bonus de bienvenue ; aucune promesse de gain. */
    /* Seconde relecture du 11/10 : « set / change / control your client seed » (aucune page ne le permet,
       la graine client est tiree par le serveur, game.js:5677) ; « provably fair » seulement pour les
       quatre jeux du fait (Blackjack, Plinko, Mines, Hi-Lo), jamais « every game » ni un autre jeu ;
       « fairness verified on Robinhood Chain ». (« house edge », « welcome gift », « cashback »,
       « instantly », « in seconds » : MOTS_INTERDITS, pour tous.) */
    interdits: [/\bRTP\b|return to player/i, /\b(fair\w*|verif\w*|provabl\w*)\b[^.!?]{0,30}\b(on[- ]?chain|blockchain|Robinhood Chain)\b|\bon[- ]?chain fair/i,
      /\bclient seeds?\b|\b(choose|chose|pick|set|change|control|enter|type|edit)\w*\b[^.!?]{0,25}\bseeds?\b|\byour own seed/i, /free \$?SWOGE\b/i,
      /\bweekly\b|every week|\bmax(imum)? bet\b|\bmin(imum)? bet\b/i,
      /\bverif\w*\b[^.!?]{0,25}\b(every|all|any|each)\b|\b(every|all|any|each)\b[^.!?]{0,25}\bverif\w*/i,
      /\brake\w*|\bcheat\w*|\brigged\b|\bmanipulat\w*|\btournaments?\b|\bjackpot (hits|drops)\b/i,
      /^(?![\s\S]*\b(Blackjack|Plinko|Mines|Hi-Lo)\b)[\s\S]*\bprovabl/i,
      /\bprovabl\w*[^.!?]*\b(every|all|each|any|Bonanza|Kennel|Spin|Smash|DEAD SWOGE|Poker|Boulier|Three Card|Hold'?em|slots?|duels?|Crash)\b|\b(every|all|each|any|Bonanza|Kennel|Spin|Smash|DEAD SWOGE|Poker|Boulier|Three Card|Hold'?em|slots?|duels?|Crash)\b[^.!?]*\bprovabl/i] },

  { cle: 'wallet', nom: 'SWOGE Wallet', motsCles: /SWOGE Wallet\b|launchpad|SWOGE FUN\b/i, lien: 'https://swoleeswoge.dog/swoge_wallet.html',
    scenes: ['rampe', 'coffre', 'pont'],
    faits: [
      { id: 'wallet', texte: 'SWOGE Wallet holds, sends and swaps $SWOGE and $SWOGEBET on Robinhood Chain (chain ID 4663).', preuve: 'site swoge_wallet.html:6-7, 3324-3325' },
      { id: 'email', texte: 'Sign in to SWOGE Wallet with just your email and a wallet is created on the spot: no extension, no app to install. Or connect the browser wallet you already use.',
        preuve: 'site swoge_wallet.html:3413-3416, 3433' },
      { id: 'swap', texte: 'SWOGE Wallet swaps $SWOGE, $SWOGEBET and ETH on Robinhood Chain\'s own pools, and shows you the price impact and the minimum you receive before you sign.',
        preuve: 'site swoge_wallet.html:3332-3333, 2747-2748' },
      /* Pas « bridges ETH from … BNB Chain, Polygon or Avalanche » : de ces trois-la on envoie du BNB,
         du POL ou de l AVAX (CHAINES_PONT, sym). */
      { id: 'pont', texte: 'SWOGE Wallet bridges into Robinhood Chain from Ethereum, Base, Arbitrum, Optimism, BNB Chain, Polygon or Avalanche, and back out, with the bridge fee and network fee quoted before you sign.',
        preuve: 'site swoge_wallet.html:3339-3340, 3523-3544 (CHAINES_PONT, sym ETH/BNB/POL/AVAX), 3128' },
      /* Pas « every send » : un envoi Solana n est pas simule (swoge_wallet.html:7294-7295, etat 'autre'). */
      { id: 'apercu', texte: 'Before you sign a send on Robinhood Chain, SWOGE Wallet dry-runs it and shows expected to succeed or would FAIL, with the reason. It warns you, it never blocks you.',
        preuve: 'site swoge_wallet.html:3148, 7280-7296, 7327, 7336-7339' },
      { id: 'faceid', texte: 'SWOGE Wallet has an optional Face ID / Touch ID lock, checked by the server. It hides your screen, and every transaction still needs your wallet\'s signature.',
        preuve: 'site swoge_wallet.html:2963-2966, 4750-4754 ; serveur wallet_passkey.js' },
      { id: 'assistant', texte: 'SWOGE Wallet has a built-in assistant: type or say buy $50 of SWOGE or bridge 0.2 ETH to Base, it fills in the real form, you review it, and your own wallet signs.',
        preuve: 'site swoge_wallet.html:2833-2834, 2846-2848, 2852-2857, 11717 ; serveur wallet_assistant.js:54-61' },
      { id: 'soldes', texte: 'SWOGE Wallet shows both game balances, $SWOGE for the casino and $SWOGEBET for bets: deposit to play, and withdraw back to your wallet whenever you like.',
        preuve: 'site swoge_wallet.html:2878-2879, 2916-2918, 3349, 3362' },
      { id: 'cle', texte: 'SWOGE never sees or stores your private key, and an email wallet can export its key from the Account screen of SWOGE Wallet.',
        preuve: 'site swoge_wallet.html:3020-3025, 3394-3397' },
      { id: 'sol', texte: 'SOL and classic Solana tokens can be sent from SWOGE Wallet too.', preuve: 'site swoge_wallet.html:6754-6757' },
      { id: 'lp', nom: 'the SWOGE launchpad', texte: 'Launch a token on Robinhood Chain from the SWOGE launchpad into a real Uniswap pool paired with ETH or $SWOGE, signed from your own wallet. SWOGE never holds your keys.',
        preuve: 'site launchpad.html:640-645, 1276-1279, lance_v4.js:4-6' },
      { id: 'lp-frais', nom: 'the SWOGE launchpad', texte: 'The SWOGE launchpad fee is 0.0001 ETH on the ETH pool, or 10,000 $SWOGE burned on the $SWOGE pool.',
        preuve: 'site launchpad.html:641, 645, lance_v4.js:25-26 (feeWei) ; contrats/SwogeFunV4.sol:162, 227' },
      /* La fiche securite (launchpad.html:1245-1252) ne vaut que pour les pools ETH et $SWOGE de
         Robinhood Chain ; un lancement Solana suit les regles de sa courbe (:1231-1238 : frais a part,
         achat du createur possible, aucun partage). D ou « on Robinhood Chain » dans ces quatre-la,
         au present (« you launch ») : l ancien bouton Classic (V3), ou le launchpad etait proprietaire
         du jeton, est retire depuis le 05/10 (launchpad.html:637-638). */
      { id: 'lp-offre', nom: 'the SWOGE launchpad', texte: 'A token you launch on Robinhood Chain from the SWOGE launchpad has a 1,000,000,000 supply, all of it in the pool: no team bag, and nothing for the creator either.',
        preuve: 'site launchpad.html:637-647, 1247 ; contrats/SwogeFunV4Weth.sol:168, 250-257, 277' },
      { id: 'lp-verrou', nom: 'the SWOGE launchpad', texte: 'Liquidity of a token you launch on Robinhood Chain from the SWOGE launchpad is locked forever: the pool position stays in the launchpad contract, which has no function to withdraw it.',
        preuve: 'site launchpad.html:1248 ; contrats/SwogeFunV4Weth.sol:290-316 (collectFees seulement)' },
      { id: 'lp-erc20', nom: 'the SWOGE launchpad', texte: 'A token you launch on Robinhood Chain from the SWOGE launchpad is a bare ERC-20 with no owner, no mint, no tax and no blacklist.',
        preuve: 'site launchpad.html:1249 ; contrats/SwogeFunV4Weth.sol:93, 101, 104-117' },
      { id: 'lp-partage', nom: 'the SWOGE launchpad', texte: 'Tokens you launch on Robinhood Chain from the SWOGE launchpad carry a 1% trading fee, split 50% to the creator and 50% to the SWOGE treasury, and the token side of the fees is burned.',
        preuve: 'site launchpad.html:1250 ; contrats/SwogeFunV4Weth.sol:156, 163, 297-315' },
      { id: 'lp-claim', nom: 'the SWOGE launchpad', texte: 'Creators collect their fee share from the SWOGE launchpad\'s Portfolio with one Claim all my fees button.',
        preuve: 'site launchpad.html:2308' },
      { id: 'lp-copies', nom: 'the SWOGE launchpad', texte: 'The SWOGE launchpad refuses copycats: no official Robinhood stock token names, no major tickers like BTC, ETH or USDC, and no SWOGE.',
        preuve: 'site launchpad.html:1251 ; serveur lancement_v4.js:81-88' },
      { id: 'lp-agent', nom: 'the SWOGE launchpad', texte: 'On the SWOGE launchpad a token can get its own AI agent: pick a personality (Hype, Analyst, Stoic, Contrarian or Builder) and an objective, and preview its first post before you launch.',
        preuve: 'site launchpad.html:642-643, 675-687 ; serveur agent_jeton.js:51-57' },
      { id: 'lp-pilote', nom: 'the SWOGE launchpad', texte: 'A creator runs their SWOGE launchpad token\'s agent from their wallet with a gas-free signature: set it up, pause it, link its X account and a Telegram group, and see its activity and spending.',
        preuve: 'site launchpad.html:784-786, 1405-1440' },
      { id: 'lp-public', nom: 'the SWOGE launchpad', texte: 'Every SWOGE launchpad token agent and its posts are public on the AI Agents page.', preuve: 'site token_agents.html:53-54, 93, 120' },
      /* Sans « Pump.fun » (un domaine : X en fait un lien), et dans son propre `groupe` : ses voisins ne
         sont jamais les regles des pools de Robinhood Chain, fausses pour un jeton Solana. */
      { id: 'lp-solana', nom: 'the SWOGE launchpad', groupe: 'solana', texte: 'The SWOGE launchpad can also launch your token on Solana, on a bonding curve, signed with Phantom. SWOGE never holds your keys.',
        preuve: 'site launchpad.html:646-647, 1231-1238, 1262-1264' },
      { id: 'lp-telegram', nom: 'the SWOGE launchpad', texte: 'Launch from Telegram: /launch Moon Dog MDOG eth replies with a pre-filled SWOGE launchpad link, and you sign in your own wallet. The bot never signs.',
        preuve: 'serveur tg_lance.js:7-14, tg_commandes.js:23, 97' },
    ].map((f) => Object.assign({ verifie: VERIFIE }, f)),
    reserves: [
      'SWOGE Wallet: sign in with your email, then hold, send and swap $SWOGE and $SWOGEBET on Robinhood Chain, with the price impact shown before you sign. 👛🐕',
      'Launch a token on Robinhood Chain from the SWOGE launchpad: all of the supply goes in the pool, liquidity is locked forever, and SWOGE never holds your keys. 🚀🐕',
    ],
    /* Le pool est Uniswap v3 (« V4 » est la version de NOTRE launchpad) ; le 70/30 est l ancien
       modele ; pas d « instantane » sur DexScreener ; V4 n est pas audite ; le rachat de l agent est
       du papier ; Face ID est un verrou de confidentialite, pas une protection des fonds ; l apercu
       avertit, il ne garantit rien ; l assistant pre-remplit, il n execute pas. (« Uniswap v4 » est
       refuse par MOTS_INTERDITS, « renounced » couvre « ownership renounced ».) */
    /* Seconde relecture du 11/10 — les faux retires, sous leur FORME et plus sous une phrase exacte :
       « keys never leave your device », « self-custodial » ; « every send / transaction is simulated » (un
       envoi Solana ne l est pas) ; « blocks failed transactions » (l apercu « warns, never blocks ») ; « bridge
       ETH from BNB Chain / Polygon / Avalanche » (on y envoie BNB, POL, AVAX : CHAINES_PONT) ; « every token
       on the launchpad … locked forever » et les regles des pools dites avec Solana (courbe Pump.fun,
       launchpad.html fiche Solana) ; l agent « buys back » / « trades for it » / « pumps » ; Face ID qui
       « keeps your funds safe ». (« instant », « audited », « honeypot-proof » : MOTS_INTERDITS.) */
    interdits: [/\bv4\b/i, /\bbuys?[- ]?backs?\b|\bbuying back\b|fund(s|ed)? (it|them)sel(f|ves)/i,
      /\b(Face|Touch) ID\b[^.!?]{0,40}\b(funds?|money|safe\w*|secur\w*|protect\w*|guard\w*|assets?|sign\w*)\b|sign with (Face|Touch) ID|protects? your (funds|money)/i,
      /\bkeys? (never|don'?t|do not) leave\b|\bkeys? stays?\b|\bself[- ]?custod\w*|\bnon[- ]?custod\w*/i,
      /(?<!never )\bblock(s|ed|ing)?\b|\bstops? (scams?|honeypots?|rugs?|rug pulls?)\b/i,
      /\btrades? for (you|it|them)\b|\bexecut\w*|\bpump(s|ed|ing)?\b|\bautomatic\w*|\bwhile you sleep\b/i, /\brenounced\b/i, /volume bench/i,
      /\b(every|all|each) (sends?|transactions?|transfers?|swaps?|bridges?)\b(?! still needs)/i,
      /\bETH\b[^.!?]{0,40}\b(BNB|Polygon|Avalanche)\b|\b(BNB|Polygon|Avalanche)\b[^.!?]{0,40}\bETH\b/i,
      /\b(every|all|any|each)\b[^.!?]{0,40}\b(tokens?|launch(es)?)\b(?! agents?)/i,
      /^(?=[\s\S]*\bSolana\b)[\s\S]*\b(lock\w*|team bag|supply|burn\w*|ERC-?20|no owner|no mint|no tax|blacklist|liquidity|Uniswap|copycats?|trading fees?|fee share)\b/i,
      /* MEV, recuperation par e-mail, lancement sur une autre chaine, Raydium, l agent qui fait la promotion. */
      /\bMEV\b|\bfront[- ]?run\w*|\bsandwich\w*|\brecover\w*|\brestor\w*|\bbackup\b|\blose your (phone|device)\b|\blaunch\w*\b[^.!?]{0,30}\b(Base|Ethereum|Arbitrum|BNB|Polygon|Avalanche|Optimism)\b|\bRaydium\b|\bgraduat\w*|\bshill\w*|\bpromot\w*|\bmarkets? (it|your token)\b/i] },

  /* « SWOGE AI » seul, jamais le debut de « SWOGE AI Cinema » : un tweet du cinema ne nomme pas SWOGE AI.
     Le lien du produit est celui de la colonie (son volet sans `nom`) ; chaque volet a le sien (LIENS_VOLETS). */
  { cle: 'ai', nom: 'SWOGE AI', motsCles: /SWOGE AI\b(?!\s+Cinema)|SWOGE Agents\b|SwoleMind|SwogeAgentic|Agent Passport|Agent Store|Solana AI|Ethereum AI|SWOGE Security/i,
    lien: 'https://swoleeswoge.dog/swoge_ai.html',
    scenes: ['village', 'labo', 'bibliotheque'],
    faits: [
      { id: 'colonie', texte: 'SWOGE AI is a colony of AI agents that reads new Robinhood Chain tokens, scores them, paper-trades them at the real price, and learns from what actually worked.',
        preuve: 'site swoge_ai.html:6, 972' },
      /* Pas « SWOGE AI is paper trading » ni « Paper only » (seconde relecture du 11/10) : la page propose
         un miroir LIVE en argent reel (swoge_ai.html:977, 1009-1010, 1336). La colonie, elle, est papier. */
      { id: 'papier', texte: 'The SWOGE AI colony trades on paper, at real prices, and the SWOGE AI page itself signs no real transaction.',
        preuve: 'site swoge_ai.html:977 (« No real transactions are signed by this interface. The colony\'s trades below are paper, at real prices »)' },
      { id: 'roles', texte: 'In SWOGE AI each agent has one job: the Scout finds new pools, the Warden checks the contract, Whale-Watch reads the holders, Whisper reads the trades one by one, and any of them can veto.',
        preuve: 'site swoge_ai.html:1331-1333 ; serveur ai_colonie.js:797-809 (ROSTER_DEPART)' },
      { id: 'oracle', texte: 'In SWOGE AI the Oracle scores what survived and decides, and before any buy the Test Subject simulates the sale on chain, signing nothing.',
        preuve: 'site swoge_ai.html:1334-1335 ; serveur ai_colonie.js:810-818' },
      { id: 'naissance', texte: 'The SWOGE AI colony can give birth to new specialist agents, and the page counts how many were born from it.',
        preuve: 'serveur ai_colonie.js:787-794 ; site swoge_terminal.js:96, 387-388' },
      { id: 'suivi', texte: 'Every token SWOGE AI looks at, bought or rejected, is followed to its deadline and priced again.', preuve: 'site swoge_ai.html:1302, 1337' },
      { id: 'preuve', texte: 'The SWOGE AI Proof tab lists everything the server kept, newest first, each token linked to its DexScreener pair.', preuve: 'site swoge_ai.html:1314' },
      { id: 'scanner', texte: 'Paste a token address into the SWOGE AI market scanner and submit it to the colony: it is judged by the same rules as every other token.',
        preuve: 'site swoge_ai.html:1254, swoge_terminal.js:1134-1141 ; serveur server.js:7537-7543 (colonieSoumets, sur ws.addr seulement)' },
      /* Pas « every new token » (seconde relecture du 11/10) : l observatoire lit UNE page de
         GeckoTerminal new_pools (20 pools) par chaine et par cycle de 3 min (observatoire.js:15-17, 106,
         236) — un echantillon, et un jeton sans pool n est jamais vu. La meta description des deux pages
         du site disait aussi « Every new token » : corrigee le 11/10 au soir (« A sample of new … tokens —
         the 20 newest pools every 3 minutes »). */
      { id: 'sol-eth', nom: 'Solana AI and Ethereum AI', texte: 'Solana AI and Ethereum AI follow new tokens on their chain from their first price to 30 minutes later, and a paper colony buys some at real quotes, fees included, against a blind control.',
        preuve: 'serveur observatoire.js:8-19, 73 (HORIZON_MIN 30), 236 (new_pools page 1) ; site swoge_sol_ai.html:8, swoge_eth_ai.html:8 (devis Jupiter / KyberSwap, temoin aveugle)' },
      { id: 'chat', nom: 'SWOGE Agents', texte: 'SWOGE Agents: chat with Claude, ChatGPT and Grok and create images and videos, with no subscription. Each request is billed at its actual cost.',
        preuve: 'site swoge_agents.html:122, 1604-1605' },
      /* Pas « No $SWOGE needed » tout court : « Videos are paid in $SWOGE for now » (swoge_agents.html:1579). */
      { id: 'usdc', nom: 'SWOGE Agents', texte: 'No $SWOGE needed for chat, images or agent tasks on SWOGE Agents: sign USDC from your wallet on Base or Solana, or top up a dollar credit once. Videos are paid in $SWOGE for now.',
        preuve: 'site swoge_agents.html:1579 (« every answer and image », « Videos are paid in $SWOGE for now »), 1605, 1736' },
      { id: 'mission', nom: 'SWOGE Agents', texte: 'Give SwoleMind an objective on SWOGE Agents: it plans the work, runs the tools (web search, token and on-chain checks) and shows every step it ran with what each one cost.',
        preuve: 'site swoge_agents.html:1597, 1651' },
      { id: 'compare', nom: 'SWOGE Agents', texte: 'Compare on SWOGE Agents: ask 2 or 3 AI models the same question side by side, then a Council verdict shows where they agree and disagree.',
        preuve: 'site swoge_agents.html:1657, 3959' },
      { id: 'images', nom: 'SWOGE Agents', texte: 'SWOGE Agents makes images with Grok Imagine or ChatGPT Image and short videos with Grok, and Series & Ads keeps the same characters and voices in every scene.',
        preuve: 'site swoge_agents.html:1605, 1659' },
      { id: 'pieces', nom: 'SWOGE Agents', texte: 'On SWOGE Agents you can attach a photo or a PDF to a chat and dictate your message with the mic. You read it back and send it yourself.',
        preuve: 'site swoge_agents.html:1646-1649, 4265-4279' },
      { id: 'agent', nom: 'SWOGE Agents', texte: 'The Agent tab of SWOGE Agents reads tokens, new launches, wallets, the SWOGE AI colony and the web, then answers with the numbers it read. Read-only: it can\'t buy, sell, sign or post.',
        preuve: 'site swoge_agents.html:1752, 1761' },
      { id: 'browse', nom: 'SWOGE Agents', texte: 'Browse on SWOGE Agents is a real browser running on SWOGE\'s server. Screen asks the AI about what you see, and the AI never follows instructions written on a page.',
        preuve: 'site swoge_agents.html:1548, 1937, 1962' },
      { id: 'autopilot', nom: 'SWOGE Agents', texte: 'Browse Autopilot on SWOGE Agents: write a goal and Claude, ChatGPT or Grok clicks, scrolls and types in that browser by itself, 30 minutes max, never over the AI budget you set.',
        preuve: 'site swoge_agents.html:1965, 2000' },
      { id: 'x402', nom: 'SWOGE Agents', texte: 'With x402, any AI agent can hire SWOGE Agents tools with no account and no API key: it gets a 402 with the price and pays per call in USDC on Base or Solana.',
        preuve: 'site swoge_agents.html:1804, llms.txt:9' },
      { id: 'outils', nom: 'SWOGE Agents', texte: 'SWOGE Agents tools include token scans with GoPlus security, a can I sell? check, Robinhood Chain reads, provably fair draws, a token roast, images, videos and a full research agent.',
        preuve: 'site llms.txt:15-40, swoge_agents.html:1812' },
      { id: 'devs', nom: 'SWOGE Agents', texte: 'Developers plug SwogeAgentic into Claude Desktop, Claude Code, Cursor or their own script (API key or MCP) with a daily cap they set, and a price quote is free.',
        preuve: 'site swoge_agents.html:1817, llms.txt:11' },
      { id: 'passport', nom: 'Agent Passport', texte: 'Agent Passport: an AI agent\'s key gets a passport (owner wallet, limits, permissions, measured history) signed by SWOGE that anyone can verify.',
        preuve: 'site agent_passport.html:8, llms.txt:46 ; serveur passeport.js' },
      { id: 'store', nom: 'Agent Store', texte: 'The SWOGE Agent Store lists measured agents and paid tools, with the numbers behind each one and no invented ratings.',
        preuve: 'site agent_store.html:8, swoge_agents.html:2668-2681' },
      { id: 'cansell', nom: 'SWOGE Security', texte: 'The free Can I sell? check on SWOGE Security simulates a buy and a sell of a Robinhood Chain token, read-only, and shows the round-trip cost, the pool, the liquidity and whether the LP is burned.',
        preuve: 'site swoge_security.html:147-153, 330-345 ; serveur server.js:4654-4662 (/bugbounty/cansell, gratuit pour la page, sur main d592de0)' },
    ].map((f) => Object.assign({ verifie: VERIFIE }, f)),
    reserves: [
      'SWOGE AI: a colony of AI agents reads new Robinhood Chain tokens, scores them and paper-trades them at the real price, and the Proof tab shows what it kept. 🤖🐕',
      'Claude, ChatGPT and Grok in one place, no subscription: SWOGE Agents bills each request at its actual cost, and you can pay in USDC. 🧠🐕',
    ],
    /* SWOGE AI est du papier : ni gain (« profit » est refuse partout, MOTS_INTERDITS), ni taux de gain, ni P&L, ni « l IA gagne » ; le miroir n est
       pas presente ; fournisseurs « peu censures », Tor, bug bounty, mode blackjack (jeu sur des sites
       tiers) jamais ; aucun agent exterieur « qui paie deja » ; l eSIM depend d un fournisseur non
       verifie ; l agent du chat ne lance pas de jeton. */
    /* Seconde relecture du 11/10 : la colonie qui « beats the blind control », « outperforms », « is
       crushing it », « trades for you », « buys for real », « on-chain AI trading », « copy the colony » ;
       des LECTURES prises pour des jetons distincts (« has scanned 52,340 tokens ») ; « No $SWOGE needed »
       hors chat / images / taches d agent, et les videos avec USDC (elles se paient en $SWOGE,
       swoge_agents.html:1579) ; Agent Passport « on-chain » (signe par SWOGE, verifiable : pas sur la
       chaine) ; Autopilot « for hours » (30 minutes au plus). (« win », « gains », « immune »,
       « can't be prompt-injected » : MOTS_INTERDITS.) */
    interdits: [/\bP&L\b|\bPnL\b|makes? money|\bbeat(s|ing|en)?\b|\boutperform\w*|\bcrush\w*/i, /\bmirror\b|real money|\bfor real\b|\breal trades?\b|\blive trading\b|\bcop(y|ies|ying)\b/i,
      /uncensored|Venice|OpenRouter|DeepSeek|Mistral|\bTor\b|\.onion|bug bounty|martingale|paroli|blackjack mode|restyle/i,
      /already (pay|paying|use|using)|agents? (are )?paying us|\brevenue\b/i, /\beSIM\b/i, /launch(es)? (a |your )?token/i,
      /\btrades? for (you|it|them)\b|\b(can|will|it'?ll) (buy|sell|trade|swap)\b|\bbuys? (tokens? )?for you\b|\bon[- ]?chain (AI )?trad\w*/i,
      /\b(tokens?|coins?) (scanned|analy[sz]ed|vetted|looked at|checked|screened|reviewed|processed|tracked|seen)\b|\b(scanned|analy[sz]ed|vetted|looked at|checked|screened|reviewed|processed|tracked|seen|read)\b[^.!?]{0,20}\b(tokens|coins)\b|\d[\d,.]*\s*\+?\s*(different |unique |distinct |new )?(tokens|coins)\b/i,
      /\b(no|without|zero|don'?t need( any)?|never need) \$?SWOGE\b(?! (needed for (AI )?(chat|images|agent tasks)|Agents|AI|Wallet|Bet|World|Security)\b)|\bno \$?SWOGE needed\b[^.!?]*\bvideos?\b|\bUSDC\b[^.!?]{0,60}\bvideos?\b|\bvideos?\b[^.!?]{0,60}\bUSDC\b|\beverything\b[^.!?]{0,30}\b(USDC|paid|pay\w*)\b/i,
      /\b(identity|passport|verified|verification)\b[^.!?]{0,20}\bon[- ]?chain\b|\bon[- ]?chain (identity|passport|ID)\b/i, /\bhours?\b/i,
      /* « AI that buys tokens on Robinhood Chain » : la colonie achete sur PAPIER ; un texte qui la fait
         acheter, vendre ou trader sans dire « paper » est refuse (« reads the trades » reste permis). */
      /^(?![\s\S]*\bpaper\b)[\s\S]*(?<!the )\b(buys|buying|trades|trading|sells|selling)\b/i,
      /* Les « calls » et « signals » de la colonie, ses « picks » et ses « gems » ; SWOGE Security hors de
         Robinhood Chain (cansell ne simule que Robinhood Chain, swoge_security.html:147-153) ; Browse qui
         se connecte a vos comptes, Autopilot qui achete. */
      /\b(calls|signals?|picks|gems?|alpha)\b/i,
      /^(?=[\s\S]*\b(SWOGE Security|Can I sell)\b)[\s\S]*\b(Ethereum|Solana|Base|BNB|Arbitrum|other chains)\b/i,
      /\blog(s|ging)? ?in(to)?\b|\bpasswords?\b|\byour accounts?\b|\bshop\w*|\bpurchas\w*/i] },

  { cle: 'cinema', nom: 'SWOGE AI Cinema', motsCles: /SWOGE AI Cinema\b/i, lien: 'https://swoleeswoge.dog/swoge_cinema.html',
    scenes: ['popcorn', 'cinema', 'projection'],
    faits: [
      { id: 'ouvert', texte: 'SWOGE AI Cinema is live: three AI-made cartoon series, free to watch in the browser, no sign-in.',
        preuve: 'site swoge_cinema.html:531-541, 600-620, commit f88b4eb' },
      { id: 'episodes', texte: 'SWOGE AI Cinema has 14 episodes across 3 series: SWOGE ISLAND (3), SWOGE SAGA (6) and SWOGE SAGA Season 2 (5).',
        preuve: 'site swoge_cinema.html:601-619 (CATALOGUE, 3 + 6 + 5 compte le 11/10), :725' },
      { id: 'format', texte: 'Every SWOGE AI Cinema episode is a short vertical 9:16 video, about 1 to 1.5 minutes long.',
        preuve: 'site swoge_cinema.html:648 ; durees d: 55 a 90 s dans le CATALOGUE (:601-619)' },
      { id: 'island', texte: 'SWOGE ISLAND on SWOGE AI Cinema is a dating-reality parody: nine singles, then the bombshells.', preuve: 'site swoge_cinema.html:601-602' },
      { id: 'saga', texte: 'SWOGE SAGA on SWOGE AI Cinema: a jacked shiba from 2099 crashes into Leo\'s tiny Paris flat with a warning he is not allowed to explain.',
        preuve: 'site swoge_cinema.html:606-607' },
      { id: 'saison2', texte: 'SWOGE SAGA Season 2 on SWOGE AI Cinema: the meme multiverse moves in.', preuve: 'site swoge_cinema.html:614' },
      { id: 'choix', texte: 'Four SWOGE AI Cinema episodes end on an A/B choice, and viewers are asked to drop A or B in the comments.',
        preuve: 'site swoge_cinema.html:602-604, 612 (champs a/b), 650-657' },
      { id: 'partage', texte: 'Each SWOGE AI Cinema episode has its own link, plus Share on X, Telegram and Copy link buttons.',
        preuve: 'site swoge_cinema.html:551-553, 632-635, 665-666' },
      { id: 'suite', texte: 'On SWOGE AI Cinema, when an episode ends, the next one starts on its own.', preuve: 'site swoge_cinema.html:722' },
      { id: 'heberge', texte: 'All SWOGE AI Cinema episodes are hosted on our own site, with no outside player.', preuve: 'site swoge_cinema.html:644, swoge_cinema.test.js:83' },
    ].map((f) => Object.assign({ verifie: VERIFIE }, f)),
    reserves: [
      'SWOGE AI Cinema is live: three AI-made cartoon series, free to watch in your browser, no sign-in. When an episode ends, the next one starts on its own. 🎬🐕',
      'A jacked shiba from 2099 crashes into a tiny Paris flat. SWOGE SAGA is free to watch on SWOGE AI Cinema. 🍿🐕',
    ],
    /* Les personnages de la saison 2 viennent de memes connus : jamais « 100 % original » ni « aucun
       sous licence » ; aucun vote n est compte (on demande A ou B en commentaire) ; aucun episode
       promis ; aucune audience ; les episodes ne sont pas faits avec SwoleMind. (FLIX, ferme, est refuse
       par MOTS_INTERDITS pour tous les produits.) */
    /* Seconde relecture du 11/10 : aucun choix n est compte (on demande A ou B en commentaire) — ni
       « you decide », ni « the community chooses the ending », ni « the story follows your choice » ;
       aucun episode a venir (« dropping soon ») ; rien « on chain ». (« licensed » : MOTS_INTERDITS.) */
    interdits: [/100% original|\boriginal characters\b/i, /\bPepe\b|\bBrett\b|\bWojak\b|\bAndy\b|\bLandwolf\b|\bBonk\b/i, /\bvot(e|es|ed|ing)\b/i,
      /season 3|new episodes|\bmore episodes\b|\bviews\b|\bviewers watched\b|\bevery (week|day)\b|\bweekly\b|\bdaily\b|\b4K\b|\bHD\b|award/i, /SwoleMind|same tools/i,
      /\bdecid\w*|\bchoos\w*|\bchose\b|\bfollows? your\b|\byour (choice|pick|call)\b|\bwhat happens next\b|\b(shape|steer|write|change) the (story|ending|plot)\b/i,
      /\bon[- ]?chain\b/i] },
].map((p) => Object.assign({ interdits: [] }, p));

/* ---- LES MOTS QU AUCUN TWEET NE PORTE ----
 * Ce qui n est pas vendu (en OBSERVATION seulement : pari en direct, plus/moins
 * au prix du marche, coupes), toute promesse de gain, ce qui est ferme (staking,
 * FLIX, la ville +18) et les mots que l inventaire du 11/10 a releves faux.
 * Le texte du modele qui en porte un est remplace par une reserve (verifieTexte). */
const MOTS_INTERDITS = [
  /\blive[- ]?bet/i, /\bbet(s|ting)? (live|in[- ]play)\b/i, /\bin[- ]play\b/i, /\bin[- ]game bet/i, /\blive odds\b/i,
  /* Les coupes (seconde relecture du 11/10) : la Ligue des champions est VENDUE comme un championnat
     (prix_ligues.js:16-17, LIGUES_DEFAUT ; estCoupe ne la compte pas, :238-243) ; les huit coupes de
     COUPES et les autres ne le sont pas. « Europa » / « Conference » seuls, « Copa » (del Rey,
     Libertadores, America), Carabao, Sudamericana, Community Shield, phase a elimination directe. */
  /\btotals\b/i, /\bcups?\b/i,
  /\bEuropa\b|\bConference\b|Pokal|\bCopa\b|Coppa Italia|Coupe de France|Carabao|Libertadores|Sudamericana|Community Shield|\bknock[- ]?outs?\b/i,
  /\bguarantee/i, /price target/i, /\b(beat(s|ing)?|smash(es|ing)?|outsmart\w*|outplay\w*|crush(es|ing)?|fleec\w*)\b[^.!?]{0,12}\b(the )?(bookies|books|bookmakers?|house|market|sportsbooks?)\b/i, /\+EV\b|positive EV/i,
  /easy money|free money|risk[- ]free|sure (win|thing)|passive income|get rich/i,
  /\bAPR\b|\bAPY\b|\byield\b|\bstaking\b/i,
  /* La vitesse : un paiement du carnet attend la passe quotidienne, jusqu a 24 h (paris_import.js:
     1737-1742) ; un retrait est un bon signe a encaisser soi-meme. « the instant the curve hits » (fait
     crash-auto, le cash-out automatique de Crash) reste permis. */
  /(?<!the )\binstant(ly|aneous(ly)?)?\b|\b(in|within) (seconds|minutes|no time)\b|\bright away\b|\bimmediately\b|final whistle/i,
  /\bbest odds\b|sharp(est)? odds|zero margin|no margin|same odds/i,
  /play[- ]to[- ]earn|\bP2E\b|\bNFTs?\b/i,
  /Uniswap v4/i, /SWOGE \+18|SWOGE FLIX|\bmanga\b/i,
  /* Relecture du 11/10 : les memes choses, dites autrement. Le pari pendant le match (pas vendu) ;
     les promesses de gain ; un domaine nu (« swoleeswoge.dog », « Pump.fun ») que X transforme en
     lien, donc facture au prix d un post avec lien (0,200 $ au lieu de 0,015 $, en tete) meme sans
     X_LIEN. */
  /\bbet(s|ting)? on (live|ongoing|running)\b|\blive (match|game|sports?) (bet|betting|wager)/i,
  /\b(bet|bets|betting|wager\w*)\b[^.!?\n]{0,40}\b(during|mid[- ]?(match|game)|while (the|they|it|games?|matches?)\b|as (it|they) (play|happen))/i,
  /\bodds\b[^.!?\n]{0,20}\b(move|moving|change|changing|update|updating)\b[^.!?\n]{0,12}\blive\b/i,
  /* Toute promesse de gain (seconde relecture du 11/10 : « double your stack », « make bank », « cash in »,
     « payday », « Easy wins », « your next big win », « Earn $SWOGEBET », « win 250x », « top players win
     $SWOGE » passaient). « win » sous toutes ses formes, sauf ce que disent les faits vrais : « wins come
     back », « winnings come back », « winning slips », « tumbling wins », « the winner takes the stake ». */
  /(?<!tumbling )\bwin(s|ning|nings|ner|ners)?\b(?! (come|comes) back| slips?\b| takes\b)|(?<!to[- ])\bearn\w*|\bprofit\w*|\bgains?\b|\bpayday\b|\bmake bank\b|\bstack(ing)? (your |the )?bags?\b|\bcash in\b|\b(double|triple|\d+x) your\b/i,
  /\bbest (payouts?|prices?)\b|\bbetter (odds|payouts?|than)\b/i,
  /* Un domaine nu, meme colle derriere un « _ » (« _swoleeswoge.dog » passait : pas de \b entre _ et s),
     et le nom du domaine du site sous toute forme (« swoleeswoge . dog »). */
  /(?<![a-z0-9-])[a-z0-9][a-z0-9-]*\.[a-z]{2,}\b|swoleeswoge/i,
  /* Ce que personne ne peut affirmer pour SWOGE (seconde relecture du 11/10) : audit, licence,
     regulation, KYC ; « no house edge » (la marge du carnet est de 10 %, whitepaper.html:2830). */
  /\baudit\w*|\blicen[sc]\w*|\bregulat\w*|\bKYC\b|\banonym\w*|\bhouse edge\b|\b(low|no|zero|tiny|small|lowest|thin) (house )?edge\b/i,
  /* L invulnerable : « can't be rugged », « immune to prompt injection », « rug-proof », « never … again ». */
  /\b(can'?t|cannot|can not|won'?t) (be |get )?(rug|rugs|rugged|hacked|exploited|scammed|injected|prompt[- ]injected|honeypotted|fail|lose|stop\w*|go wrong)\b|\bimpossible\b|\bimmune\b|\bunstoppable\b|\bun(rugg?|hack)able\b|\b(rug|honeypot|scam|hack|exploit|bullet|fraud)[- ]?(proof|free)\b|\bnever\b[^.!?]{0,40}\bagain\b|\bnever (miss\w*|fails?)\b/i,
  /* Ce qui n existe pas : application mobile, cashback, bonus, airdrop. */
  /\b(iOS|Android|App Store|Google Play|mobile)\b|\bcash ?back\b|\brake ?back\b|\bwelcome (bonus|gift|offer|pack)\b|\bfree bets?\b|\bdeposit bonus\b|\bairdrop\w*|\bgiveaway\w*/i,
  /* Aucune comparaison nommee avec un concurrent. */
  /\b(DraftKings|FanDuel|Bet365|BetMGM|Caesars|Rollbit|Polymarket|Kalshi|Netflix|Hulu|Disney|TikTok|Binance|Coinbase)\b/i,
  /* « the first / only / best sportsbook on Robinhood Chain » : un superlatif sur un produit. */
  /\b(the|our|its|a) (very )?(best|first|only|biggest|largest|leading|fastest|cheapest|safest)\b[^.!?]{0,25}\b(sportsbook|casino|launchpad|wallet|book|colony|cinema|platform|dex|exchange|chain|app)s?\b|#1\b|\bnumber one\b/i,
  /\b(any|every|all) (EVM )?chains?\b|\bpenn(y|ies)\b|\bcents?\b/i,
  /* Ce qui n est pas encore la, ou n existe pas : une promesse (« coming soon », « we'll make it »,
     « real trading tomorrow »), une assurance, un stockage « decentralise ». */
  /\bsoon\b|\bcoming\b|\bupcoming\b|\btomorrow\b|\bnext (week|month|year|season)\b|\bstay tuned\b|\broadmap\b|\bwe'?ll\b|\bwe will\b/i,
  /\binsured\b|\binsurance (fund|cover\w*|policy)\b|\bbacked by\b|\bIPFS\b|\bArweave\b|\bdecentrali[sz]\w*/i,
];

/* ---- LES MOTS QUI AFFIRMENT, PERMIS SEULEMENT S ILS SONT DANS LES FAITS (seconde relecture du 11/10) ----
 * Une liste noire ne finit jamais : 130 textes adverses, dont des paraphrases de chaque faux deja
 * retire, passaient. La plupart portent un QUANTIFICATEUR ou un SUPERLATIF que les faits donnes ne
 * portent pas (« every token », « all markets », « the only sportsbook », « free AI chat », « cheaper
 * than », « keys never leave », « no house edge », « no KYC »). Comme les nombres : un de ces mots, ou
 * un « no X » / « zero X » / « without X », n est permis que si les faits donnes au modele (fait
 * vedette, voisins, chiffres vivants) l ecrivent aussi. Sinon la reserve part, vraie. */
const RE_ABSOLUS = /\b(every(one|body|thing|where)?|all|any(one|body|thing|where|time)?|always|forever|unlimited|endless|only|first|free|best|biggest|fastest|cheapest|lowest|highest|largest|safest|safer|safe|secure(d|ly)?|sharpest|greatest|smartest|top|leading|than|beat(s|ing)?|outperform(s|ed|ing)?|fully|completely|totally|entirely)\b/gi;
/* Des tournures qui n affirment rien : « y'all », « all in », « at all », « after all », « all set ». */
const RE_IDIOMES = /\by'?all\b|\ball[- ](in|set|eyes|aboard)\b|\bat all\b|\bafter all\b/gi;
const RE_NEGATIONS = /\b(no|zero|without)[\s-]+(\$?[a-z][a-z0-9'-]*)/gi;
const NEGATIONS_LIBRES = new Set(['cap', 'joke', 'doubt', 'brainer', 'kidding', 'way', 'question', 'fluff', 'worries']);
/** Les mots qui affirment et les « no X » d un texte, en minuscules, sans $. */
function absolus(s) {
  const t = String(s || '').replace(RE_IDIOMES, ' ');
  const mots = (t.match(RE_ABSOLUS) || []).map((m) => m.toLowerCase());
  const neg = [];
  for (const m of t.matchAll(RE_NEGATIONS)) {
    const mot = m[2].toLowerCase().replace(/^\$/, '').replace(/'s$/, '');
    if (!NEGATIONS_LIBRES.has(mot)) neg.push(m[1].toLowerCase() + ' ' + mot);
  }
  return mots.concat(neg);
}
/* ---- UN NOMBRE ET CE QU IL COMPTE (seconde relecture du 11/10) ----
 * « SWOGE Bet: 8 sports » passait parce que 8 est dans un fait (8 selections) ; « 40 players online »
 * passerait avec « 40 characters are alive ». Pour ce qui se compte en public (sports, championnats,
 * matchs, joueurs, jetons, agents…), le nombre et son nom doivent aller ENSEMBLE dans un fait donne
 * (deux mots au plus entre eux : « 17 soccer leagues », « 12 SWOGE casino games »). */
const UNITES = ['sport', 'league', 'competition', 'market', 'match', 'game', 'player', 'user', 'holder', 'bettor', 'member', 'follower',
  'token', 'agent', 'chain', 'country', 'model', 'episode', 'series', 'character', 'creator', 'trader', 'wallet',
  'kill', 'level', 'second', 'minute', 'hour', 'day', 'week', 'month'];

/* ---- LES NOUVEAUTES, COTE JOUEUR ----
 * Celles de l inventaire du 11/10 qui changent quelque chose pour un joueur,
 * dedoublonnees (le casino en $SWOGEBET y figurait trois fois) ; les
 * retouches d interface seules (onglets, cadre) n y sont pas. `deja` : les
 * sorties faites HORS rotation (le post programme casino-swogebet du 08/10
 * compte pour la premiere). `condition` : comme pour les faits. */
const NOUVEAUTES = [
  { id: 'bet-marche-17', date: '2026-10-09', produit: 'bet', condition: (v) => !!v.dixSept,
    texte: '11 more soccer leagues on SWOGE Bet now use market-priced odds, from the Championship and Serie B to MLS and Liga MX. That makes 17 leagues on market prices.',
    preuve: 'serveur 26cd304 ; paris_import.js:159-169 ; EXPLOITATION.md:466 (PARIS_PRIX_LIGUES posee le 09/10). Condition : 17 cles soccer_ dans prix_ligues.ligues(), les onze comprises' },
  { id: 'lp-gaz', date: '2026-10-09', produit: 'wallet', nom: 'the SWOGE launchpad',
    texte: 'The SWOGE launchpad now tells you the full ETH you need before you sign, launch fee plus gas, so a launch no longer fails halfway for lack of gas.',
    preuve: 'site 01d2818, lance_v4.js:28-38' },
  { id: 'bet-marche-6', date: '2026-10-08', produit: 'bet', condition: (v) => !!v.sixGrands,
    texte: 'SWOGE Bet now prices the Premier League, La Liga, Serie A, Bundesliga, Ligue 1 and the Champions League off the betting market, with the house margin added.',
    preuve: 'serveur d856863 ; prix_marche.js, prix_ligues.js:16-17. Condition : les six cles dans prix_ligues.ligues()' },
  { id: 'bet-90', date: '2026-10-08', produit: 'bet',
    texte: 'Soccer bets on SWOGE Bet now settle on the 90-minute score (extra time and penalties don\'t count), and a match closes at its real kickoff, checked on ESPN.',
    preuve: 'serveur 1a9dcd6 ; scores_espn.js:255-257, paris.js:576-610' },
  { id: 'casino-swogebet', date: '2026-10-08', produit: 'casino', deja: ['2026-10-08T19:00:00Z'],
    texte: 'Your $SWOGEBET from SWOGE Bet now plays in the SWOGE casino: pick Stake from: Bet $SWOGEBET on Smash, Spin, Plinko, Crash, Blackjack and more, and wins come back in $SWOGEBET.',
    preuve: 'serveur 358bf8a (game.js:4442-4461) ; site 0e3bb9d, a1c2b88, 086f639 (coffre.js:130-135) ; deja annonce : PROGRAMMES casino-swogebet, 08/10 19:00 UTC' },
  { id: 'ai-sol-eth', date: '2026-10-08', produit: 'ai', nom: 'Solana AI and Ethereum AI',
    texte: 'Solana AI and Ethereum AI are now two separate SWOGE AI paper colonies: each follows new tokens on its chain from their first price to 30 minutes later, against a blind-buy control.',
    preuve: 'site afe74c6 (swoge_sol_ai.html, swoge_eth_ai.html) ; serveur observatoire.js:15-17, 236 (un echantillon de new_pools, pas « every new token »)' },
  { id: 'cinema-ouvert', date: '2026-10-07', produit: 'cinema',
    texte: 'SWOGE AI Cinema is open: 3 AI-made cartoon series, 14 short vertical episodes, free to watch, with A/B choice episodes and a share link for each one.',
    preuve: 'site f88b4eb (swoge_cinema.html, media/cinema/*.mp4)' },
  { id: 'wallet-apercu', date: '2026-10-06', produit: 'wallet',
    texte: 'SWOGE Wallet now dry-runs your Robinhood Chain sends and burns before you sign and shows expected to succeed or would FAIL, with the reason. It warns, it never blocks.',
    preuve: 'site 30883ca (swoge_wallet.html:7280-7340 ; Solana non simule, :7294-7295)' },
  { id: 'wallet-faceid', date: '2026-10-06', produit: 'wallet',
    texte: 'SWOGE Wallet now has an optional Face ID / Touch ID lock, checked by the server. It hides your screen, and every transaction still needs your wallet\'s signature.',
    preuve: 'site db8fed2 ; serveur 19875a7, 2df90dd (wallet_passkey.js)' },
  { id: 'ai-micro', date: '2026-10-06', produit: 'ai', nom: 'SWOGE Agents',
    texte: 'SwoleMind on SWOGE Agents: tap the mic and dictate your chat message instead of typing it.',
    preuve: 'site 1ea6150 (swoge_agents.html:1647) ; serveur 7018433' },
  /* L agent par jeton et sa conduite depuis le portefeuille ont deja eu leurs deux sorties le 05/10,
     hors rotation : PROGRAMMES agents-48h (« every SWOGE token gets its own AI agent … the creator owns
     & controls it from their wallet ») et agent-explique (« You own and control it from your wallet »,
     « link X/Telegram » dans son sujet). Ils ne repartent pas en nouveaute ; leurs faits (lp-agent,
     lp-pilote) restent dans la rotation. */
  { id: 'lp-agent', date: '2026-10-05', produit: 'wallet', nom: 'the SWOGE launchpad', deja: ['2026-10-05T16:00:00Z', '2026-10-05T19:40:00Z'],
    texte: 'AI Agent Launch is now the default on the SWOGE launchpad: your token gets its own AI agent with a personality and an objective, and you preview its first post before launch.',
    preuve: 'site cdc7c0b, dab8333 (launchpad.html) ; serveur c4a1bd6..cfb81d0 (agent_jeton.js) ; deja annonce : PROGRAMMES agents-48h et agent-explique, 05/10' },
  { id: 'lp-tableau', date: '2026-10-05', produit: 'wallet', nom: 'the SWOGE launchpad', deja: ['2026-10-05T16:00:00Z', '2026-10-05T19:40:00Z'],
    texte: 'Creators on the SWOGE launchpad now run their token\'s agent from a dashboard: link its X account and a Telegram group, pause or resume it, and see its activity.',
    preuve: 'site 39b3a7f, 9bb7bb8, b45dbb9, a3e9f1a, 7f14bb4, ed115b1 (launchpad.html:784-786, 1405-1440) ; deja annonce : PROGRAMMES agents-48h et agent-explique, 05/10' },
  { id: 'lp-page-agents', date: '2026-10-05', produit: 'wallet', nom: 'the SWOGE launchpad',
    texte: 'New public AI Agents page: every token agent from the SWOGE launchpad, its posts and its settings, in one place.',
    preuve: 'site 64484fe (token_agents.html)' },
  { id: 'lp-solana', date: '2026-10-05', produit: 'wallet', nom: 'the SWOGE launchpad', groupe: 'solana',
    texte: 'The SWOGE launchpad now launches your token on Solana too, on a bonding curve, signed with Phantom. SWOGE never holds your keys.',
    preuve: 'site 5fa8e2a (launchpad.html:646-647, 1231-1238) ; serveur 6242321 (solana_pump.js)' },
  { id: 'ai-osint', date: '2026-10-05', produit: 'ai', nom: 'SWOGE Agents',
    texte: 'New on SWOGE Agents: Analyze my socials shows what is publicly exposed about your own handle, email or domain. Public sources only.',
    preuve: 'site b3d9ac3 (swoge_agents.html:2527)' },
  { id: 'wallet-assistant', date: '2026-10-04', produit: 'wallet',
    texte: 'SWOGE Wallet now has a built-in assistant you can type or talk to: it fills in send, swap or bridge for you, and only your wallet signs.',
    preuve: 'site 901ffe6 (wallet_assistant.js, swoge_wallet.html)' },
  { id: 'securite-cansell', date: '2026-10-04', produit: 'ai', nom: 'SWOGE Security',
    texte: 'New SWOGE Security page: a free Can I sell? check that simulates a buy and a sell of a Robinhood Chain token before you ape in.',
    preuve: 'site ee14f00 (swoge_security.html) ; serveur server.js:4654 (sur main d592de0)' },
  { id: 'lp-pools', date: '2026-10-03', produit: 'wallet', nom: 'the SWOGE launchpad',
    texte: 'On the SWOGE launchpad you now pick the ETH pool or the $SWOGE pool right on the page, and new tokens show up in Explore, where they can be traded.',
    preuve: 'site 904f672, d5516dc (launchpad.html)' },
  { id: 'lp-telegram', date: '2026-10-03', produit: 'wallet', nom: 'the SWOGE launchpad',
    texte: 'Launch a token from Telegram with /launch: you get a pre-filled SWOGE launchpad link, you sign in your own wallet, and the launch is announced once confirmed on-chain.',
    preuve: 'site f89304d (launchpad.html) ; serveur 36727c9 (tg_lance.js)' },
  { id: 'ai-autopilot', date: '2026-10-02', produit: 'ai', nom: 'SWOGE Agents',
    texte: 'Browse Autopilot on SWOGE Agents: write a goal and Claude, ChatGPT or Grok uses a real browser by itself, inside an AI budget it can never exceed.',
    preuve: 'site 99568c4 (swoge_agents.html:1965, 2000) ; serveur ae2d79e' },
  { id: 'ai-store', date: '2026-10-01', produit: 'ai', nom: 'Agent Store',
    texte: 'The Agent Store is now a tab of SWOGE Agents: measured agents and paid tools, with the numbers behind each one.',
    preuve: 'site 9185e2e (swoge_agents.html:2668)' },
  { id: 'lp-claim', date: '2026-09-30', produit: 'wallet', nom: 'the SWOGE launchpad',
    texte: 'Creators on the SWOGE launchpad now collect their 50% of trading fees from Portfolio, with one Claim all my fees button.',
    preuve: 'site f79f0f6 (launchpad.html:2308)' },
  { id: 'ai-mission', date: '2026-09-29', produit: 'ai', nom: 'SWOGE Agents',
    texte: 'SwoleMind on SWOGE Agents now asks what you want to accomplish: give it an objective, and it plans, runs the tools and shows every step with its cost.',
    preuve: 'site 6f01dba (swoge_agents.html:1596-1597)' },
  { id: 'ai-usdc', date: '2026-09-29', produit: 'ai', nom: 'SWOGE Agents',
    texte: 'No $SWOGE needed for AI chat or agent tasks on SWOGE Agents: sign USDC from your wallet on Base or Solana, or use a dollar credit.',
    preuve: 'site 7d2fd5e, a485eb4 (swoge_agents.html:1579, 1736)' },
  { id: 'ai-passport', date: '2026-09-29', produit: 'ai', nom: 'Agent Passport',
    texte: 'New: Agent Passport, a signed identity for an AI agent\'s API key (owner, limits, permissions, measured history) that anyone can verify.',
    preuve: 'site 9d34bb1 (agent_passport.html) ; serveur be179fb' },
  { id: 'ai-scanner', date: '2026-09-28', produit: 'ai',
    texte: 'Paste a token contract into the SWOGE AI scanner, submit it to the colony and see what it decided.',
    preuve: 'site e9a7fff (swoge_ai.html:1254, swoge_terminal.js:1134) ; serveur 873cd56' },
  /* Premiere sortie hors rotation : PROGRAMMES x402-payai, 27/09 22:55 UTC (« AI agents can now hire SWOGE »). */
  { id: 'ai-x402', date: '2026-09-28', produit: 'ai', nom: 'SWOGE Agents', deja: ['2026-09-27T22:55:00Z'],
    texte: 'SWOGE Agents opened its tools to other AI agents: any agent can pay per call in USDC with x402, with prices shown live.',
    preuve: 'site 623b211 (swoge_agents.html:1803-1812) ; deja annonce : PROGRAMMES x402-payai, 27/09' },
].map((n) => Object.assign({ verifie: VERIFIE }, n));

/* ---- LA ROTATION ----
 * Deux jours = huit creneaux. Dans chaque bloc de huit : les six produits, plus
 * deux retours pour paris, SWOGE World et casino, qui tournent d un bloc a
 * l autre. Les trois produits « autres » gardent la MEME place dans chaque bloc
 * (3, 5, 7), donc ils reviennent tous les huit creneaux pile ; les trois nommes
 * par le proprietaire ne sont jamais a plus de six creneaux de leur passage
 * precedent. Sur 24 creneaux (six jours) : 5 fois chacun pour paris, World et
 * casino, 3 fois pour les trois autres. Verifie dans x_post.test.js : toute
 * fenetre de huit creneaux consecutifs couvre les six produits, et jamais deux
 * fois le meme d affilee, y compris d un tour au suivant. */
const ROTATION = [
  'bet', 'world', 'casino', 'wallet', 'bet', 'ai', 'world', 'cinema',
  'casino', 'bet', 'world', 'wallet', 'casino', 'ai', 'bet', 'cinema',
  'world', 'casino', 'bet', 'wallet', 'world', 'ai', 'casino', 'cinema',
];
/* Une nouveaute : de moins de 14 jours (au-dela ce n est plus une nouveaute),
   deux sorties au plus, la seconde 7 jours apres la premiere au plus tot
   (demande du 11/10).
   ---- UN CRENEAU SUR DEUX AU PLUS ----
   Le 11/10, 27 nouveautes sont fraiches, dont 22 portefeuille, launchpad ou
   IA. Mesure sur la semaine simulee du 12 au 18/10 (choixSujet, journal vide,
   liste par defaut des championnats) :
     - sans plafond : les 16 premiers creneaux (quatre jours) sont TOUS des
       nouveautes, dont 3 seulement pour paris / World / casino — les trois
       que le proprietaire nomme ; sur la semaine, 17 nouveautes, et paris 5,
       World 3, casino 3 contre portefeuille + launchpad 9, IA 6 ;
     - avec NOUVEAUTE_UN_SUR = 2 (jamais deux nouveautes d affilee) : 14
       nouveautes sur 28 posts, paris 6, World 3, casino 4, portefeuille +
       launchpad 8, IA 4, cinema 3 ; la semaine d apres (stock ecoule,
       journal vide) : paris 7, World 5, casino 6.
   Le reglage se juge sur les vues de X Analytics (le serveur ne les voit
   pas) : 4 = une nouveaute par jour au plus. */
const NOUVEAUTE_FRAICHE_JOURS = 14;
const NOUVEAUTE_RETOUR_JOURS = 7;
const NOUVEAUTE_SORTIES_MAX = 2;
const NOUVEAUTE_UN_SUR = 2;

const produitDe = (cle) => PRODUITS.find((p) => p.cle === cle) || null;
const sceneDeNom = (nom) => SCENES_PRODUITS.find((s) => s.nom === nom) || SCENES.find((s) => s.nom === nom) || null;
const hache = (s) => Number.parseInt(crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8), 16);

/* Les pages de chaque volet (X_LIEN) : « the SWOGE launchpad » mene au launchpad, pas au
   portefeuille ; Solana AI, Agents, Security, Passport, Store a leur page. Toutes presentes
   dans le site (01d2818). Un volet absent d ici prend le lien de son produit. */
const LIENS_VOLETS = {
  'the SWOGE launchpad': 'https://swoleeswoge.dog/launchpad.html',
  'SWOGE Agents': 'https://swoleeswoge.dog/swoge_agents.html',
  'Solana AI and Ethereum AI': 'https://swoleeswoge.dog/swoge_sol_ai.html',
  'SWOGE Security': 'https://swoleeswoge.dog/swoge_security.html',
  'Agent Passport': 'https://swoleeswoge.dog/agent_passport.html',
  'Agent Store': 'https://swoleeswoge.dog/agent_store.html',
};

/* Les nombres ecrits en lettres comptent aussi (relecture du 11/10 : « eight sports », « hundreds of
   players » passaient). Un mot-nombre vaut son chiffre, des deux cotes : « Seven sports » dans un fait
   permet « 7 sports ». « one » n est pas compte : il sert a tout (« one place », « one slip ») sans
   rien affirmer. Les ordres de grandeur (dozens, hundreds…) ne valent qu eux-memes : un fait ecrit
   en chiffres ne les permet pas. */
/* Seconde relecture du 11/10 : sixty, seventy, eighty et ninety manquaient (« ninety leagues » passait). */
const MOTS_NOMBRES = { zero: '0', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: 'hundred', thousand: 'thousand', million: 'million', billion: 'billion', dozen: 'dozen' };
const RE_MOTS_NOMBRES = new RegExp('\\b(' + Object.keys(MOTS_NOMBRES).join('|') + ')s?\\b', 'gi');
/* Un nombre suivi de K, M, B ou x est un nombre a part (seconde relecture du 11/10) : « 1M tokens »
   passait des que « 1% » etait dans les faits, « 250K players » avec « 250x », « a 100x » avec la mise
   de 100. « 250x » ne vaut que « 250x », « 1B » que « 1B ». */
const RE_CHIFFRES = /(\d[\d,]*(?:\.\d+)?)(?:\s?([kmb]|bn|mm|x)\b)?/gi;
/** Les nombres d un texte, sans separateurs de milliers : « 1,200 » et « 1200 » sont le meme ; « seven » vaut « 7 ». */
function nombres(s) {
  const t = String(s || '');
  const chiffres = [];
  for (const m of t.matchAll(RE_CHIFFRES)) chiffres.push(m[1].replace(/,/g, '').replace(/^0+(?=\d)/, '') + (m[2] ? m[2].toLowerCase() : ''));
  const mots = (t.match(RE_MOTS_NOMBRES) || []).map((m) => MOTS_NOMBRES[m.toLowerCase().replace(/s$/, '')]);
  return chiffres.concat(mots);
}
const RE_UNITES = new RegExp('(\\d[\\d,]*(?:\\.\\d+)?|\\b(?:' + Object.keys(MOTS_NOMBRES).join('|') + '))\\s+(?:[a-z][a-z-]*\\s+){0,2}?('
  + UNITES.map((u) => (u === 'match' ? 'match(?:es)?' : u === 'series' ? 'series' : u === 'country' ? 'countr(?:y|ies)' : u + 's?')).join('|') + ')\\b', 'gi');
const uniteDe = (u) => { const x = u.toLowerCase(); return x === 'series' ? x : x === 'countries' ? 'country' : x === 'matches' ? 'match' : x.replace(/s$/, ''); };
/** Les paires « nombre + ce qu il compte » d un texte : « 17 soccer leagues » donne « 17 league ». */
function comptes(s) {
  const out = [];
  for (const m of String(s || '').matchAll(RE_UNITES)) {
    const n = /^\d/.test(m[1]) ? m[1].replace(/,/g, '') : MOTS_NOMBRES[m[1].toLowerCase()];
    out.push(n + ' ' + uniteDe(m[2]));
  }
  return out;
}

/* ---- CE QUE LE SERVEUR LIT AU MOMENT DU POST ----
 * Rien n est mis en cache : un chiffre vivant est lu dans la seconde ou le
 * texte s ecrit. `deps` vient de server.js (planifie) : `game` et la colonie ;
 * les paris et les championnats sont requis directement, comme avant. Un
 * chiffre trop petit pour servir (une poignee de personnages) n est pas dit. */
const MONDE_VIVANTS_MIN = 25;          /* sous ce nombre de personnages vivants, le chiffre dessert (« Deux cartes, trente-neuf joueurs », server.js:9836 sur main d592de0) */
const NOMS_SPORT = { foot: 'soccer', tennis: 'tennis', nba: 'NBA', nfl: 'NFL', nhl: 'NHL', mlb: 'MLB', cricket: 'cricket' };
const pluriel = (n, un, plusieurs) => n + ' ' + (n === 1 ? un : plusieurs);
let DEPS = null;
function instantane(deps, t) {
  const d = deps || DEPS || {};
  const v = { bet: { faits: [] }, world: { faits: [] }, casino: { faits: [] }, wallet: { faits: [] }, ai: { faits: [] }, cinema: { faits: [] } };
  try {
    const l = require('./paris').ouverts(t || Date.now());
    const parSport = {}; const comps = new Set();
    for (const m of l) { parSport[m.sport] = (parSport[m.sport] || 0) + 1; comps.add(m.competition); }
    const sports = Object.keys(parSport);
    /* Accorde au singulier (seconde relecture du 11/10 : « 1 matches … across 1 sports ») ; sous deux
       matchs ouverts, rien : un seul match ne fait pas une offre. */
    if (l.length >= 2) v.bet.faits.push(`${l.length} matches are open right now on SWOGE Bet across ${pluriel(sports.length, 'sport', 'sports')} (${sports.map((k) => NOMS_SPORT[k] || k).join(', ')}) and ${pluriel(comps.size, 'competition', 'competitions')}.`);
    const marche = l.filter((m) => m.prixMarche).length;
    if (marche) v.bet.faits.push(`${marche} of the matches open on SWOGE Bet right now ${marche === 1 ? 'is' : 'are'} priced off the betting market.`);
  } catch (e) { /* pas de calendrier : rien de vivant sur les matchs */ }
  try {
    const pl = require('./prix_ligues');
    const s = pl.ligues();
    const foot = [...s].filter((k) => k.startsWith('soccer_') && !(pl.estCoupe && pl.estCoupe(k)));
    v.bet.sixGrands = pl.LIGUES_DEFAUT.every((k) => s.has(k));
    v.bet.dixSept = v.bet.sixGrands && foot.length === 17 && SECONDAIRES.every((k) => s.has(k));
    if (foot.length) v.bet.faits.push(`${pluriel(foot.length, 'soccer league', 'soccer leagues')} on SWOGE Bet ${foot.length === 1 ? 'is' : 'are'} priced off the betting market right now.`);
  } catch (e) { /* liste illisible : aucun fait de prix au marche */ }
  v.bet.auto = String(process.env.PARIS_AUTO || '1') !== '0';           /* la meme lecture que paris_import.js:1730 */
  try {
    if (d.game && typeof d.game.classementMonde === 'function') {
      const n = Number((d.game.classementMonde(null, 1) || {}).vivants);
      if (n >= MONDE_VIVANTS_MIN) v.world.faits.push(`${fmt(n)} characters are alive on the SWOGE World leaderboard right now.`);
    }
  } catch (e) { /* jeu illisible */ }
  try {
    if (d.game && typeof d.game.boulierPotStr === 'function') {
      const pot = Math.floor(Number(d.game.boulierPotStr()));
      if (pot > 0) v.casino.faits.push(`The Boulier progressive jackpot in the SWOGE casino stands at ${fmt(pot)} $SWOGE right now.`);
    }
  } catch (e) { /* cagnotte illisible */ }
  try {
    if (d.colonie && typeof d.colonie.vue === 'function') {
      const c = d.colonie.vue() || {};
      const lus = Number(c.compteurs && c.compteurs.scoutVu);
      /* Avant charge(), vue() rend un etat neuf a zero (ai_colonie.js) : rien n est dit. */
      if (c.tours > 0 && lus > 0) {
        /* « Active agents » : le libelle de la page pour roster.length (swoge_ai.html:982, swoge_terminal.js:387).
           Aucun « 0 of them born » : sans naissance, on ne dit que le nombre d agents. */
        const r = c.roster || [];
        const nes = r.filter((a) => a.role === 'specialiste').length;
        if (r.length) v.ai.faits.push(`${r.length} agents are active in the SWOGE AI colony right now${nes ? ', ' + nes + ' of them born from it' : ''}.`);
        /* Des LECTURES, pas des jetons distincts : scoutVu compte chaque examen du Scout (ai_colonie.js:1004-1011,
           10160), et un jeton est reexamine. La page dit « token readings since » (swoge_terminal.js:93). */
        const depuis = c.depuis ? new Date(c.depuis).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
        v.ai.faits.push(`The SWOGE AI colony has made ${fmt(lus)} token readings${depuis ? ' since ' + depuis : ''}.`);
      }
    }
  } catch (e) { /* colonie illisible */ }
  return v;
}

/* Le fait vedette d un produit : celui qui n a jamais ete mis en avant, dans
   l ordre du catalogue, sinon celui qui l a ete il y a le plus longtemps. */
function faitDu(p, partis, vp) {
  const dispo = p.faits.filter((f) => !f.condition || f.condition(vp || {}));
  const dernier = (id) => { const e = partis.find((x) => x.produit === p.cle && x.fait === id); return e ? (e.quand || ' ') : ''; };
  return dispo.slice().sort((a, b) => dernier(a.id).localeCompare(dernier(b.id)))[0] || p.faits[0];
}

/** Les nouveautes qui peuvent partir a `t`, la plus prioritaire d abord. */
function nouveautesDues(liste, partis, t, v, exclu) {
  const c = [];
  for (const n of liste) {
    const d = Date.parse(n.date + 'T00:00:00Z');
    if (!(d <= t) || t - d >= NOUVEAUTE_FRAICHE_JOURS * 864e5) continue;
    if (n.produit === exclu) continue;
    if (n.condition && !n.condition(v[n.produit] || {})) continue;
    const sorties = (n.deja || []).map((x) => Date.parse(x)).concat(partis.filter((e) => e.nouveaute === n.id).map((e) => Date.parse(e.quand || 0)));
    if (sorties.length >= NOUVEAUTE_SORTIES_MAX) continue;
    if (sorties.length && t - Math.max(...sorties) < NOUVEAUTE_RETOUR_JOURS * 864e5) continue;
    c.push({ n, d, retour: sorties.length > 0 });
  }
  /* Jamais tweetee avant un retour ; puis la plus recente ; puis l ordre de la liste. */
  return c.sort((a, b) => (a.retour - b.retour) || (b.d - a.d) || (liste.indexOf(a.n) - liste.indexOf(b.n)));
}

/**
 * Le sujet d un creneau : `{ produit, nouveaute?, retour?, rang?, fait }`, ce
 * que le journal garde. Le creneau precedent est le dernier post PARTI ; un post
 * programme ou une annonce n a pas de produit et ne bloque rien.
 * `o.nouveautes` et `o.vivant` servent aux essais.
 */
function choixSujet(cle, journal, t, o) {
  const opt = o || {};
  const liste = opt.nouveautes || NOUVEAUTES;
  const v = opt.vivant || instantane(null, t);
  const partis = dernieres(journal, 100000);
  const prec = partis[0] || {};
  const precProduit = prec.produit || null;
  if (!partis.slice(0, NOUVEAUTE_UN_SUR - 1).some((e) => e.nouveaute)) {
    const due = nouveautesDues(liste, partis, t, v, precProduit)[0];
    if (due) return { produit: due.n.produit, nouveaute: due.n.id, retour: due.retour || undefined, fait: due.n.id };
  }
  const dernierRang = (partis.find((e) => Number.isInteger(e.rang)) || {}).rang;
  let i = Number.isInteger(dernierRang) ? (dernierRang + 1) % ROTATION.length : 0;
  /* Une nouveaute du meme produit vient de passer : le suivant de la rotation prend la place
     (ROTATION n a jamais deux fois le meme d affilee, un pas suffit). */
  if (ROTATION[i] === precProduit) i = (i + 1) % ROTATION.length;
  const p = produitDe(ROTATION[i]);
  return { produit: p.cle, rang: i, fait: faitDu(p, partis, v[p.cle]).id };
}

/** Ce que le modele recoit pour ecrire : le nom, le fait vedette, deux voisins, le vivant. */
function sujetDe(entree, v, liste) {
  const p = produitDe(entree.produit) || PRODUITS[0];
  const vp = (v && v[p.cle]) || {};
  let n = entree.nouveaute ? (liste || NOUVEAUTES).find((x) => x.id === entree.nouveaute) || null : null;
  if (n && n.condition && !n.condition(vp)) n = null;     /* la lecture a change entre deux essais : on revient au produit */
  const dispo = p.faits.filter((f) => !f.condition || f.condition(vp));
  const fait = n ? null : (dispo.find((f) => f.id === entree.fait) || dispo[0] || p.faits[0]);
  const nom = (n ? n.nom : fait.nom) || p.nom;
  /* Les voisins : meme volet ET meme `groupe` (le launchpad sur Solana n a pas les regles des pools
     de Robinhood Chain, et inversement). */
  const groupe = (x) => (x && x.groupe) || (x && x.nom) || p.nom;
  const g = groupe(n || fait);
  const voisins = dispo.filter((f) => f !== fait && groupe(f) === g);
  const k = fait ? Math.max(0, voisins.findIndex((f) => p.faits.indexOf(f) > p.faits.indexOf(fait))) : 0;
  const autres = voisins.slice(k).concat(voisins.slice(0, k)).slice(0, 2).map((f) => f.texte);
  /* Les reserves, dans l ordre de preference. Une nouveaute : son texte (« ICYMI: » en rappel). Un
     produit : ses reserves, puis le fait vedette, ses voisins et ses autres faits vrais du moment
     (chacun nomme deja le produit) — de quoi ne pas reposter un texte identique (X refuse un doublon,
     le creneau tomberait apres avoir paye son image ; voir `reserveDe`). 215 signes au plus, la place
     de $SWOGE et #RobinhoodChain. */
  const reserves = n ? [(entree.retour ? 'ICYMI: ' : '') + n.texte]
    : p.reserves.concat([fait.texte], autres, dispo.map((f) => f.texte)).filter((t, i, l) => t.length <= 215 && l.indexOf(t) === i);
  return { produit: p.cle, nom, motsCles: p.motsCles, interdits: p.interdits, lien: LIENS_VOLETS[nom] || p.lien, lead: n ? n.texte : fait.texte, autres,
           vivants: (vp.faits || []).slice(), nouveaute: n ? n.id : null, retour: !!(n && entree.retour), date: n ? n.date : null, reserves };
}

/**
 * Le texte tient-il ses promesses ? Il nomme son produit, ne porte aucun mot
 * interdit, et chaque nombre qu il ecrit est dans les faits qu on lui a donnes.
 * Sinon on poste une reserve vraie : un tweet public ne s invente rien.
 */
function verifieTexte(texte, s) {
  const t = String(texte || '');
  if (!s.motsCles.test(t)) return { ok: false, raison: 'ne nomme pas ' + s.nom };
  /* Un texte peut citer un AUTRE produit (« your SWOGE Bet balance plays in the SWOGE casino ») :
     les interdits de chaque produit qu il nomme s appliquent aussi (relecture du 11/10 : « SWOGE Bet
     also lets you play the SWOGE World cinema » passait). */
  const autres = PRODUITS.filter((p) => p.interdits !== s.interdits && p.motsCles.test(t)).map((p) => p.interdits);
  for (const r of MOTS_INTERDITS.concat(s.interdits || [], ...autres)) if (r.test(t)) return { ok: false, raison: 'mot interdit ' + String(r) };
  const donnes = [s.lead].concat(s.autres || [], s.vivants || []).join(' ');
  const permis = new Set(nombres(donnes));
  const inventes = nombres(t).filter((x) => !permis.has(x));
  if (inventes.length) return { ok: false, raison: 'nombre absent des faits : ' + inventes.join(', ') };
  const pairesPermises = new Set(comptes(donnes));
  const malComptes = comptes(t).filter((x) => !pairesPermises.has(x));
  if (malComptes.length) return { ok: false, raison: 'compte absent des faits : ' + malComptes.join(', ') };
  const absolusPermis = new Set(absolus(donnes));
  const affirmes = absolus(t).filter((x) => !absolusPermis.has(x));
  if (affirmes.length) return { ok: false, raison: 'affirmation absente des faits : ' + affirmes.join(', ') };
  return { ok: true };
}
/* « $SWOGE Bet » est un faux nom (le ticker colle au produit) : on rend le nom
   juste, et `nettoie` remet le cashtag a part si la rotation le demande. */
function corrigeNoms(brut) {
  return String(brut || '').replace(/\$SWOGE(?=\s(?:Bet|World|Wallet|AI|Agents|Blackjack|Spin|Smash|Bonanza|Kennel|Poker|Games|Security|casino|launchpad)\b)/g, 'SWOGE');
}

/* L image d un creneau produit : la scene du produit la moins recemment postee
   (les jamais postees d abord, departagees par la cle du creneau). */
function sceneProduit(p, cle, journal) {
  const partis = journal ? dernieres(journal, 100000) : [];
  const sc = p.scenes.map(sceneDeNom).filter(Boolean);
  const derniere = (nom) => { const e = partis.find((x) => x.scene === nom); return e ? (e.quand || ' ') : ''; };
  const depart = hache('scene:' + cle) % sc.length;
  const tour = sc.slice(depart).concat(sc.slice(0, depart));
  return tour.slice().sort((a, b) => derniere(a.nom).localeCompare(derniere(b.nom)))[0];
}

// ------------------------------------------------------------ les faits du jour

/** Ce qui est vrai AUJOURD HUI sur le site, en garde-fou des annonces : un fait par produit, plus le vivant des paris. */
function faitsDuJour(t) {
  const v = instantane(null, t || Date.now());
  const faits = v.bet.faits.slice();
  for (const p of PRODUITS) faits.push(p.faits.find((f) => !f.condition).texte);
  faits.push('$SWOGE lives on Robinhood Chain (chain 4663), the new chain from Robinhood');
  const n = env().heures.length;
  faits.push(`An AI agent writes, illustrates and posts on this X account by itself, ${n === 4 ? 'four' : n} times a day`);
  return faits;
}

// ------------------------------------------------------------ le texte

/* ---- L ANGLE NE CHOISIT PLUS QUE LE TON (11/10/2026) ----
 * Le sujet est choisi avant (un produit, une nouveaute) ; l angle dit
 * seulement COMMENT en parler. Deux posts d affilee jamais sur le meme ton.
 * `chiffre` : seulement si le fait vedette porte un nombre. `nouveaute` /
 * `retour` : reserves aux creneaux de nouveaute (premiere sortie / rappel). */
const ANGLES = [
  { a: 'hype: two or three punchy lines of momentum around this one product', ton: 'hype' },
  { a: 'humor: a self-aware joke about the very buff dog using this product', ton: 'humour' },
  { a: 'the number: lead with ONE number from the facts, written exactly as given, and make it land', ton: 'chiffre', chiffre: true },
  { a: 'how-to: say in one or two short steps how to use it, plain and concrete', ton: 'mode' },
  { a: 'one-liner: a single sharp line about it that could be a caption', ton: 'ligne' },
  { a: 'the flex: say with swagger why this one thing is built different', ton: 'flex' },
  { a: 'community: talk to the pack (we/us) about this one thing we built', ton: 'communaute' },
  { a: 'new: it just shipped; say what is new and why it matters to a player, in plain words', ton: 'new', nouveaute: true },
  { a: 'reminder: it shipped recently and was already posted once; in-case-you-missed-it energy, never "new today"', ton: 'rappel', retour: true },
];
const TONS_PRODUIT = ANGLES.filter((a) => !a.nouveaute && !a.retour);
/** Le ton d un creneau : fixe pour une nouveaute, sinon tire par la cle, jamais celui du post precedent. */
function angleDuCreneau(cle, sujet, journal) {
  if (sujet.nouveaute) return ANGLES.find((a) => (sujet.retour ? a.retour : a.nouveaute)).a;
  const dernier = (dernieres(journal, 1)[0] || {}).angle;
  const permis = TONS_PRODUIT.filter((a) => a.a !== dernier && (!a.chiffre || /\d/.test(sujet.lead)));
  return permis[hache('ton:' + cle) % permis.length].a;
}
const SYSTEME = `You write posts on X for SWOGE ($SWOGE), a community-run memecoin (CTO) on Robinhood Chain whose mascot is a very buff Shiba Inu. SWOGE ships real products, and EVERY post is about one of them.
Audience: American crypto Twitter. Write in natural US English, with the humor and slang of US crypto X where it fits (never forced). In US English "football" means the NFL: say "soccer" or name the league.
The request names ONE PRODUCT (or one NEW UPDATE of a product) and gives its LEAD FACT. The post is about that one thing: name it exactly as written on the PRODUCT line, never with a "$" in front of it, and build the post on the lead fact. You may add one of the other facts given, nothing else: no feature, number, date, price, user count, ranking or comparison that is not in the request. The TONE line only sets the voice. When the request gives an ANNOUNCEMENT instead, the post is about that announcement.
Voice: bullish, playful, confident and fun, never desperate, never rude, never repetitive.
Hard rules: English. Maximum 240 characters, and shorter is usually better. The request tells you, in its TICKER and HASHTAG lines, whether this post carries "$SWOGE" and "#RobinhoodChain": follow them exactly, and weave them in naturally rather than tacking them on. No other hashtag. 1 to 3 emojis. No links and no web addresses or domain names (nothing like "name.dog" or "name.fun"). Every number you write must appear in the request, written the same way, in digits or in words; never invent a number. No promises of returns or winnings (no "win", "earn", "profit", "payday", "cash in", "double your"), no "guaranteed", no price targets, no "beat the house" or "beat the bookies", no "best odds" or "better than". Never write an absolute or comparative word (every, all, any, only, first, best, free, unlimited, forever, than, safe) or a "no X" claim unless the facts in the request use that very word; never count something ("N sports", "N players") unless a fact counts it the same way; never write a speed ("instantly", "in seconds"), an audit, a license or a competitor's name. SWOGE Bet has NO live or in-play betting, no betting during a match, no cash-out, no domestic cups and no Europa or Conference League (the Champions League is offered): never suggest any of them. Do NOT reuse the opening words, the structure or the jokes of the previous posts you are shown. Mention today's image only if it lands naturally.
Output only the post text, nothing else.`;

/* ---- UN SECOND REGARD, AVANT DE POSTER (seconde relecture du 11/10) ----
 * Les listes refusent des MOTS ; une affirmation inventee n a pas toujours de mot a refuser. Mesure du
 * 11/10 sur 103 textes faux ecrits a la main, APRES les listes et le controle des mots qui affirment :
 * 44 passaient (« player props are here », « the vault is insured », « SWOGE World: play on mobile »,
 * « extra time counts », « hold BTC and SOL »…) ; apres les motifs ajoutes ensuite, 2 (« extra time
 * counts on SWOGE Bet », un sens inverse ; « hold BTC and SOL »). Les 346 textes faux connus (ceux de la
 * relecture et ceux-la) sont dans essais/x_post/faux.json, et x_post.test.js exige que les listes les
 * refusent tous ; 56 textes vrais du ton attendu (essais/x_post/vrais.json) doivent passer. Le
 * texte qui a passe tout le reste est donc relu par un second appel au modele : il recoit les MEMES
 * faits que l auteur et ne dit oui que si chaque affirmation y est. Tout ce qui n est pas un oui franc
 * (non, reponse illisible, HTTP en erreur, delai) poste la reserve : un tweet vrai de moins inventif
 * plutot qu un tweet faux. Le cout : un appel de plus par creneau, quelques centaines de jetons.
 * `X_JUGE=0` l eteint (les listes restent). Le taux de refus du juge sur de vrais textes n est pas
 * mesure (aucun appel paye ici) : le lire dans le journal (`refus` commence par « juge »). */
const SYSTEME_JUGE = `You check a post before it goes out on a public X account, with no human review. You receive FACTS, the only things known to be true about the product, and the POST.
Answer ok:true only if every claim in the POST is stated by the FACTS or follows directly from them. Tone, jokes, slang, emojis, the "$SWOGE" cashtag, the "#RobinhoodChain" hashtag and hype words that state nothing ("built different", "LFG", "the pack") are fine.
Answer ok:false if the POST states or implies anything the FACTS do not say, or says it more broadly than the FACTS: a feature, a market, a sport, a chain, a platform, a speed, a number or a count, a comparison, "every", "all", "only" or "first", a promise of gains, something still to come, a guarantee, safety or security, or anything that contradicts the FACTS. When unsure, answer ok:false.
Reply with JSON only: {"ok": true or false, "claim": "the first unsupported claim, or empty"}`;
/** Le second regard : `{ ok: true }` seulement sur un oui franc ; leve si l appel echoue. */
async function jugeTexte(texte, s, f) {
  if (process.env.X_JUGE === '0') return { ok: true, saute: 'desactive' };
  const e = env();
  const faits = [s.lead].concat(s.autres || [], s.vivants || []);
  const r = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': e.anthropic, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: e.modeleJuge, max_tokens: 150, system: SYSTEME_JUGE,
      messages: [{ role: 'user', content: `PRODUCT: ${s.nom}\nFACTS:\n- ${faits.join('\n- ')}\n\nPOST:\n${texte}` }] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const brut = ((j.content || []).find((b) => b.type === 'text') || {}).text || '';
  const m = brut.match(/\{[\s\S]*\}/);
  let v = null;
  try { v = m ? JSON.parse(m[0]) : null; } catch (err) { v = null; }
  if (!v || v.ok !== true) return { ok: false, raison: 'juge : ' + String((v && v.claim) || 'pas de oui franc').replace(/\s+/g, ' ').slice(0, 120) };
  return { ok: true };
}

/* Si le modele ne repond pas (ou se trompe), on poste quand meme — avec une
   phrase de reserve, vraie, plutot que de rater le creneau. Depuis le 11/10,
   chaque produit a les siennes ; RESERVE les rassemble pour un post sans
   produit (une annonce sans texte de secours). */
const RESERVE = PRODUITS.reduce((l, p) => l.concat(p.reserves), []);

/* ---- JAMAIS DEUX FOIS LE MEME TEXTE (relecture du 11/10) ----
 * X refuse un post identique a un post deja fait : le creneau echoue trois fois et
 * il est abandonne, apres avoir paye son image. Avec deux reserves par produit
 * tirees par la cle, la simulation de 30 jours ou chaque texte est refuse donnait
 * 64 doublons exacts sur 120 creneaux, le premier des le 14/10. La reserve est donc
 * la premiere de la liste qui n a JAMAIS ete postee (comparee sans $, #, lien ni
 * espaces : le cashtag et le hashtag changent d un creneau a l autre) ; si toutes
 * l ont ete, celle postee il y a le plus longtemps. `postes` : les textes partis,
 * du plus recent au plus ancien (tache). */
const empreinte = (s) => String(s || '').replace(/https?:\/\/\S+/g, '').trim()
  .replace(/(\s+(\$SWOGE|#RobinhoodChain))+$/i, '')                 /* les etiquettes que nettoie ajoute en fin */
  .replace(/#RobinhoodChain\b/gi, 'Robinhood Chain').replace(/[$#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
function reserveDe(liste, postes, cle) {
  const l = (liste || []).filter(Boolean);
  if (!l.length) return '';
  const p = (postes || []).map(empreinte);
  const age = (r) => { const e = empreinte(r); const i = p.findIndex((x) => x.includes(e)); return i < 0 ? Infinity : i; };
  const jamais = l.filter((r) => age(r) === Infinity);
  if (jamais.length) return jamais[0];
  return l.slice().sort((a, b) => age(b) - age(a) || (hache('reserve:' + cle + a) - hache('reserve:' + cle + b)))[0];
}

/** L'angle, retrouve par son libelle : le journal n'en garde que le texte. */
function angleDe(a) {
  if (a && typeof a === 'object' && a.a) return a;
  const x = ANGLES.find((y) => y.a === a);
  return x || { a: a || ANGLES[0].a };
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

/** La demande d un creneau produit : le nom, le genre (produit, nouveaute, rappel), le ton, le fait vedette, les voisins, le vivant.
 *  AUCUNE date en chiffres (relecture du 11/10) : la demande donnait « shipped on 2026-10-08 » et la
 *  date du jour, le modele les citait (« New since Oct 8 »), et verifieTexte refusait ce 8 absent des
 *  faits — une reserve de plus, sans rien gagner. Le jour de la semaine suffit au ton. */
function demandeProduit(s, ang, tags, o, jour) {
  const genre = s.nouveaute
    ? (s.retour ? 'REMINDER of an update shipped recently and already posted once: never say "new today", never write its date'
                : 'NEW UPDATE, shipped in the last few days (do not write its date)')
    : 'one of our products';
  return [`Day: ${jour}`, `PRODUCT: ${s.nom} (name it exactly like this, once)`, `KIND: ${genre}`, `TONE: ${ang.a}`,
    `TICKER: ${tags.ticker ? 'include "$SWOGE" exactly once' : 'do NOT write "$SWOGE"'}`,
    `HASHTAG: ${tags.hashtag ? 'include "#RobinhoodChain" exactly once' : 'no hashtag at all'}`,
    `LEAD FACT (the post is built on this one): ${s.lead}`]
    .concat(s.autres.length ? [`Other true facts about it (use one at most, or none):\n- ${s.autres.join('\n- ')}`] : [])
    .concat(s.vivants.length ? [`Live right now (read seconds ago; quote exactly or not at all):\n- ${s.vivants.join('\n- ')}`] : [])
    .concat([`Today's image: SWOGE ${o.scene.prompt}`])
    .concat((o.precedents || []).length ? [`Previous posts (do not repeat their openings, structure or jokes):\n- ${o.precedents.join('\n- ')}`] : []);
}

/**
 * `o.scene` : la scene de l image ; `o.sujetProduit` : le produit ou la
 * nouveaute du creneau (sujetDe) ; `o.sujet` : un sujet impose (un post
 * special, une annonce) ; `o.angle` : le ton ; `o.precedents` : les derniers
 * textes, pour ne pas les repeter.
 * Un creneau produit ne poste le texte du modele que s il passe verifieTexte ;
 * sinon il poste une reserve du produit, vraie, et le dit dans `refus`.
 */
async function ecritTexte(faits, o, prendre) {
  const e = env();
  const f = prendre || fetch;
  const t = o.maintenant || Date.now();
  const jour = jourDe(t);
  const tags = etiquettes(o.cle, e.heures);
  const s = o.sujetProduit || null;
  /* X_LIEN : un creneau produit mene a la page de SON produit, pas a l accueil. */
  const lien = o.lien !== undefined ? o.lien : (e.lien && s ? s.lien : e.lien);
  const reserve = (motif) => {
    const l = s ? s.reserves : RESERVE;
    const r = { texte: nettoie(o.reserve || reserveDe(l, o.postes, o.cle || jour), lien, tags), via: 'reserve' };
    if (motif) r.refus = motif;
    return r;
  };
  if (e.anthropic) {
    try {
      const ang = angleDe(o.angle);
      const semaine = new Date(t).toLocaleDateString('en-US', { weekday: 'long', timeZone: e.fuseau });
      const demande = (s ? demandeProduit(s, ang, tags, o, semaine)
        : [`Date: ${jour}`, `TONE: ${ang.a}`,
           `TICKER: ${tags.ticker ? 'include "$SWOGE" exactly once' : 'do NOT write "$SWOGE"'}`,
           `HASHTAG: ${tags.hashtag ? 'include "#RobinhoodChain" exactly once' : 'no hashtag at all'}`]
          .concat(o.sujet ? [`Today's announcement (this is the subject of the post): ${o.sujet}`] : [])
          .concat([`Today's image: SWOGE ${o.scene.prompt}`, `Facts:\n- ${faits.join('\n- ')}`])
          .concat((o.precedents || []).length ? [`Previous posts (do not repeat their openings, structure or jokes):\n- ${o.precedents.join('\n- ')}`] : []))
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
      if (!brut.trim()) throw new Error('reponse vide');
      if (!s) return { texte: nettoie(brut, lien, tags), via: 'modele' };
      /* Verifie SANS le lien (une adresse n est pas un fait), poste avec. */
      const v = verifieTexte(nettoie(corrigeNoms(brut), false, tags), s);
      /* Un texte deja poste, mot pour mot : X le refuserait comme doublon (voir reserveDe). */
      const deja = v.ok && (o.postes || []).some((x) => empreinte(x) === empreinte(nettoie(corrigeNoms(brut), false, tags)));
      if (v.ok && !deja) {
        /* Le second regard, sur le texte tel qu il partira (sans le lien). Une panne du juge poste la
           reserve, jamais le texte non relu. */
        let jg;
        try { jg = await jugeTexte(nettoie(corrigeNoms(brut), false, tags), s, f); } catch (err) { jg = { ok: false, raison: 'juge injoignable (' + String(err.message || err).slice(0, 60) + ')' }; }
        if (jg.ok) return { texte: nettoie(corrigeNoms(brut), lien, tags), via: 'modele' };
        console.error('[x] texte du modele refuse au second regard (' + jg.raison + '), reserve du produit');
        return reserve(jg.raison);
      }
      const raison = deja ? 'texte deja poste' : v.raison;
      console.error('[x] texte du modele refuse (' + raison + '), reserve du produit');
      return reserve(raison);
    } catch (err) {
      console.error('[x] texte : le modele n a pas repondu (' + (err.message || err) + '), phrase de reserve');
    }
  }
  return reserve(null);
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
  /* `produit`, `nouveaute`, `fait` (11/10/2026) : le sujet du creneau ; null sur les entrees d avant, sur une annonce et sur un post programme. */
  return { cle, scene: e.scene, angle: e.angle || null, texte: e.texte, id: e.id || null, essais: e.essais || 0, erreur: e.erreur || null,
           produit: e.produit || null, nouveaute: e.nouveaute || null, fait: e.fait || null, refus: e.refus || null,
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
           recents: dernieres(j, 6).map((x) => ({ cle: x.cle, scene: x.scene, produit: x.produit || null, nouveaute: x.nouveaute || null,
                                                  quand: x.quand, url: `https://x.com/${e.compte}/status/${x.id}` })) };
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
    /* ---- LE SUJET D ABORD (11/10/2026) ----
     * Un creneau ordinaire choisit son produit ou sa nouveaute, et le garde
     * dans le journal : une reprise apres un refus de X parle du meme. Une
     * entree d avant ce changement (sans `produit`) en recoit un ici. */
    let vivant = null;
    const lis = () => vivant || (vivant = instantane(o.deps, t));
    let sujet = null;
    if (!o.special) {
      if (!entree.produit) {
        const c = choixSujet(cle, journal, t, { vivant: lis(), nouveautes: o.nouveautes });
        entree.produit = c.produit; entree.fait = c.fait;
        if (c.nouveaute) { entree.nouveaute = c.nouveaute; if (c.retour) entree.retour = true; }
        if (Number.isInteger(c.rang)) entree.rang = c.rang;
      }
      sujet = sujetDe(entree, lis(), o.nouveautes);
    }
    const scene = o.special && o.special.prompt ? { nom: o.special.nom, prompt: o.special.prompt }
                : entree.scene ? (sceneDeNom(entree.scene) || sceneSuivante(cle, journal))
                : sujet ? sceneProduit(produitDe(sujet.produit), cle, journal)
                : sceneSuivante(cle, journal);
    entree.scene = scene.nom;
    /* Un angle d avant le 11/10 (« teaser: hint at what is coming next », « pure hype … nothing else »)
       n est plus un ton : donne comme TONE a un creneau produit, il pousserait le modele vers ce qui
       n est pas sorti. Tant que le texte n est pas ecrit, il est remplace par un ton d aujourd hui
       (gratuit : l image, deja payee, et sa scene sont gardees). */
    if (sujet && !entree.texte && entree.angle && !ANGLES.some((a) => a.a === entree.angle)) delete entree.angle;
    if (!entree.angle) entree.angle = sujet ? angleDuCreneau(cle, sujet, journal) : TONS_PRODUIT[hache(cle) % TONS_PRODUIT.length].a;
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
      const r = await ecritTexte(sujet ? [] : faitsDuJour(t), { scene, cle, maintenant: t, angle: entree.angle,
                                                    sujet: o.special && o.special.sujet, sujetProduit: sujet,
                                                    precedents: dernieres(journal, 5).map((x) => x.texte),
                                                    postes: dernieres(journal, 100000).map((x) => x.texte) }, o.prendre);
      entree.texte = r.texte; entree.via = r.via;
      if (r.refus) entree.refus = r.refus;
      journal.jours[cle] = entree; ecritJournal(journal);
    }
    const mediaId = await televerse(png, o.prendre);
    const id = await publie(entree.texte, mediaId, o.prendre);
    entree.id = id; entree.quand = new Date(t).toISOString(); delete entree.erreur;
    journal.jours[cle] = entree; ecritJournal(journal);
    purgeImages();
    console.log(`[x] poste ${cle} · ${entree.nouveaute ? 'nouveaute ' + entree.nouveaute : 'produit ' + (entree.produit || '-')} · scene ${scene.nom} · https://x.com/${e.compte}/status/${id}`);
    if (o.signale) {
      try { o.signale({ cle, texte: entree.texte, id, image: e.domaine ? `https://${e.domaine}/x/image/${nomImage(cle)}.png` : null, url: `https://x.com/${e.compte}/status/${id}` }); }
      catch (x) { /* le Telegram ne fait pas rater le post */ }
    }
    return { etat: 'poste', cle, id, texte: entree.texte, scene: scene.nom, angle: entree.angle,
             produit: entree.produit || null, nouveaute: entree.nouveaute || null, via: entree.via || null };
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
   *   - LP LOCKED FOREVER (ajoute le 05/10, verifie dans la SOURCE du contrat, exact_match Sourcify : SwogeFunV4Weth.sol).
   *     GoPlus affiche « lp_holder 0xe3fB… a 100 %, is_locked 0 » : FAUX NEGATIF — 0xe3fB4f97… EST notre contrat launchpad ETH
   *     (lance_v4.js, LAUNCHPADS.eth, frais 0,0001 ETH), pas un portefeuille. Il detient le NFT de position V3 (lpTokenId) et :
   *     owner = address(0) des la construction (aucun owner jamais) ; AUCUN decreaseLiquidity ; AUCUN transfert sortant du NFT ;
   *     la seule fonction qui touche la position, collectFees(), est ouverte a tous et ne recolte que les FRAIS (moitie createur /
   *     moitie tresor en WETH, cote jeton brule a DEAD), jamais le principal. La LP ne peut donc JAMAIS sortir : « LP locked
   *     forever » est demontrable, pas marketing. (05/10 : le proprietaire a dit « c est impossible » que GoPlus voie le LP non
   *     verrouille — il avait raison, c est une limite de lecture V3 de GoPlus.)
   * Image : prompt dedie, passe par genereImageVerifiee → le controle pattes-de-chien (verifiePattes) s applique tout seul. */
  { nom: 'launchpad-cheap', a: Date.parse('2026-10-06T16:00:00Z'), lien: 'https://swoleeswoge.dog/launchpad.html',
    sujet: 'Launching a token on the SWOGE launchpad is cheap (0.0001 ETH or 10,000 $SWOGE burned), fast, and safe: the LP is locked forever inside the launchpad contract, ownership is renounced, 0% tax, not a honeypot, and the pool shows up on DexScreener.',
    texte: 'Launch your token on SWOGE 🐕\n\n'
      + 'Cheap: 0.0001 ETH or 10,000 $SWOGE burned. No hidden cut.\n'
      + 'Safe: LP locked forever in the launchpad, ownership renounced, 0% tax, not a honeypot.\n'
      + 'Live on DexScreener. 🚀',
    prompt: 'pressing a big glowing green launch button on a sleek futuristic mission-control console at night; behind him a small rocket shaped like a dog bone blasts off, '
      + 'trailing bright green light; holographic screens show a candlestick chart spiking and a large green checkmark security shield; confident grin, cinematic neon lighting' },
  /* 05/10/2026 : « un post pour dire qu en moins de 48 h on a mieux que ca, et prevois de poster bientot » (le proprietaire,
   * apres avoir montre AgencyPad sur Solana : $17M cap, PumpSwap/Pump.fun, une rangee d agents IA par jeton). Ce qu on affirme
   * est verifiable et vrai de NOTRE produit — aucun chiffre invente, aucune comparaison de capitalisation (on n en a pas encore) :
   *   - « built on Robinhood Chain in under 48h » : le portage du modele AgencyPad (un agent par jeton : persona, post autonome,
   *     garde-fous, tableau de bord createur) a ete fait le 05/10, en bien moins de 48 h (branches + essais verts, ce dossier).
   *   - « every SWOGE token gets its own AI agent that posts » : agent_jeton + agent_esprit + agent_x, un agent par adresse de jeton,
   *     qui poste sur son mur et sur X une fois relie ; AGENT_HORLOGE=1 est allume en prod.
   *   - « the creator owns & controls it from their wallet » : attach_createur / toggle_createur / x/* signes, verifies contre le
   *     createur on-chain (instant(token).creator) — aucune cle admin, le createur regle/pause/delie depuis son portefeuille.
   *   - « LP locked forever. 0% tax. » : deja demontre (SwogeFunV4Weth : owner address(0), aucun retrait de LP, collectFees frais
   *     seulement ; GoPlus 4663 : honeypot 0, buy/sell tax 0). On ne compare PAS les volumes/holders : on n en a pas, on ne ment pas.
   * Poste SEUL a 12:00 ET (16:00 UTC), entre deux creneaux quotidiens, pour ne pas doubler le tweet de 12:30 ET.
   * Image : prompt dedie, pattes-de-chien verifiees par genereImageVerifiee. */
  { nom: 'agents-48h', a: Date.parse('2026-10-05T16:00:00Z'), lien: 'https://swoleeswoge.dog/launchpad.html',
    sujet: 'AgencyPad-style AI agents for launched tokens, ported to Robinhood Chain in under 48 hours: every token launched on the SWOGE launchpad gets its own autonomous AI agent that posts, and the creator fully owns and controls it from their wallet (configure, pause, link its X account) with no admin key; LP is locked forever and there is 0% tax.',
    texte: 'They shipped it on Solana. We built the same thing on Robinhood Chain in under 48h 🐕\n\n'
      + 'Every SWOGE token gets its own AI agent that posts — and the creator owns & controls it from their wallet.\n\n'
      + 'LP locked forever. 0% tax. 🚀',
    prompt: 'crossing a glowing neon finish line well ahead of a rival racer at night, carrying a small rocket shaped like a dog bone over his shoulder; a giant holographic countdown '
      + 'clock reading 48:00 ticking near zero behind him; trailing bright AI chat speech bubbles and green candlestick charts; confident grin, cinematic neon lighting' },
  /* 05/10/2026, ~19 h UTC : « programme un post qui EXPLIQUE ce que fait l agent » (le proprietaire).
   * UN seul tweet + image (ce canal ne fait pas de thread). Chaque capacite citee est reelle et branchee :
   *   - « posts on X + Telegram when something real happens on-chain » : agent_esprit + evenementAgent
   *     (prix h1, pression acheteuse, paliers de holders) -> posteAgent -> agent_x + agent_tg (poste + epingle).
   *     AGENT_HORLOGE=1 en prod.
   *   - « replies to your holders » : outil read_mentions + repond, passe par le pare-feu, dedup par la memoire.
   *   - « scans the token for red flags » : outil scan_token (GoPlus 4663 via aiColonie.scanJeton).
   *   - « simulates a sell (can I even exit?) » : outil can_i_sell (aiColonie.epreuveDeSortie, aller-retour devise).
   *   - « remembers what it said » : agent_memoire (anti-repetition). « learns from its own engagement » :
   *     agent_mesure (impressions/likes des posts X, note « ce qui marche » dans la memoire).
   *   - « you own and control it from your wallet » : attach/toggle/x/tg signes, verifies contre le createur on-chain.
   *   - « Solana + Robinhood Chain » : launchpad V4 (Robinhood) + solana_pump (Pump.fun). Non custodial : la page signe.
   * On NE dit PAS que le rachat brule du vrai (il est papier/inerte, 8c), ni aucun chiffre de cap/holders (on n en a pas).
   * Image : prompt dedie, pattes-de-chien verifiees par genereImageVerifiee. */
  { nom: 'agent-explique', a: Date.parse('2026-10-05T19:40:00Z'), lien: 'https://swoleeswoge.dog/launchpad.html',
    sujet: 'Every token launched on the SWOGE launchpad gets its own autonomous AI agent: it posts on X and Telegram when a real on-chain event happens (price move, buy pressure, holder milestone), replies to holders, scans the token for security red flags (GoPlus), simulates a sell before trusting a pump (can I exit?), remembers what it said (no repetition) and learns from its own X engagement; the creator fully owns and controls it from their wallet (persona, pause, link X/Telegram). Solana (Pump.fun) and Robinhood Chain. Non-custodial.',
    texte: 'Every token you launch on SWOGE gets its own AI agent 🧠\n\n'
      + 'It posts on X + Telegram when something real happens on-chain, replies to your holders, scans the token for red flags, and simulates a sell ("can I even exit?") before trusting a pump.\n\n'
      + 'It remembers what it said and learns from its own engagement, so it gets sharper over time.\n\n'
      + 'You own and control it from your wallet. Solana + Robinhood Chain. Non-custodial. 🐕🚀',
    prompt: 'gently placing a small glowing blue AI brain into a cute coin-shaped robot that springs to life on his workbench; behind him a wall of holographic screens shows an X feed, a Telegram chat, a green candlestick chart and a glowing green security shield, all in neon; warm confident grin, cinematic lighting at night' },
  /* 08/10/2026 : « fais un tweet auto pour expliquer qu on peut jouer avec le swogebet meme au casino » (le proprietaire).
   * Chaque affirmation verifiee dans le code pousse sur main le meme jour :
   *   - les jeux cites prennent { jeton: 'swogebet' } cote serveur (game.js : spin Smash, volcanoSpin, plinkoDrop, crash
   *     parier, casinoDeal/hilo/mines, blackjack) et la page charge coffre.js : crash, plinko, swoge_blackjack, swoge_bonanza,
   *     swoge_casino (Hold'em, Three Card, Hi-Lo, Mines), swoge_chenil, swoge_dod, swoge_smash, swoge_spin, et nexus (la table
   *     de blackjack de SWOGE World). Tous lies depuis games.html, d ou le lien.
   *   - « Stake from: Bet $SWOGEBET » : les libelles exacts du selecteur (coffre.js : « Stake from », « Bet $SWOGEBET »).
   *     Il n apparait qu a qui a un solde $SWOGEBET — d ou « before you play », sans promettre qu il est toujours visible.
   *   - « Wins land in the same token » : _payeGain paie dans le jeton fige a l ouverture de la manche
   *     (casino_deux_coffres.test.js, conservation 218 controles).
   * On NE cite PAS le Boulier ni le Coin Pusher (cagnottes partagees, restes $SWOGE seulement), ni jackpot ni classement
   * (restes $SWOGE, comme le sport). 269 caracteres avec le lien (<= 280, essai). Poste SEUL a 15:00 ET (19:00 UTC), entre
   * les creneaux de 12:30 et 17:00. Lien : 0,20 $ au lieu de 0,015 $, c est une annonce, elle doit mener aux jeux.
   * Image : prompt dedie, pattes-de-chien verifiees par genereImageVerifiee. */
  { nom: 'casino-swogebet', a: Date.parse('2026-10-08T19:00:00Z'), lien: 'https://swoleeswoge.dog/games.html',
    sujet: 'The $SWOGEBET balance from the sports-betting vault can now be staked in the SWOGE casino: Smash, Spin, Plinko, Crash, Mines, Blackjack, Hold\'em, Three Card, Hi-Lo, Kennel, Dead Swoge, Bonanza and the SWOGE World blackjack table. Players pick "Stake from: Vault $SWOGE or Bet $SWOGEBET" before playing, and wins are paid back in the same token.',
    texte: 'Your $SWOGEBET isn\'t just for sports anymore 🎰🐕\n\n'
      + 'Play it on Smash, Spin, Plinko, Crash, Mines, Blackjack, Hold\'em and more — even the SWOGE World table.\n\n'
      + 'Tap "Stake from: Bet $SWOGEBET" before you play. Wins land in the same token.',
    prompt: 'sliding two stacks of casino chips onto a glowing green felt table at night, one stack gold, the other stack bright green; a football resting on the table edge; '
      + 'behind him a neon-lit casino with a plinko board, a slot machine and a rising crash chart glowing on a big screen; confident grin, cinematic neon lighting' },
  /* 11/10/2026 : « fais un tweet X pour dire que c est un gem cache, tweet auto » (le proprietaire, capture du graphique
   * SWOGE/WETH 4 h a l appui). Lecture DexScreener le meme jour a 16:08 UTC (paire 0x2Dc0…8456, Uniswap, Robinhood Chain) :
   * cap 48 709 $, +33 % sur 6 h, +26 % sur 24 h, liquidite 18,2 K$. AUCUN de ces chiffres n est ecrit : ils seraient faux
   * a l heure du post, et un post qui annonce un cours ou une hausse promet un rendement. Rien sur le graphique non plus
   * (« higher lows » peut etre faux deux heures plus tard). Ce qu on affirme est verifiable :
   *   - « community-run » : la presentation du projet (SYSTEME : « a community-run memecoin (CTO) »).
   *   - les six noms cites viennent de cinq entrees de PRODUITS, en ligne : SWOGE Bet (le carnet de paris), le casino,
   *     SWOGE World, SWOGE Wallet et son launchpad, SWOGE AI (les agents). Le cinema n y est pas, faute de place.
   *   - « under the radar » / « most of CT hasn't found it yet » : une opinion, assumee comme telle, pas un chiffre.
   * Sans lien (0,015 $) : le post vante le jeton, pas une page. Poste SEUL a 14:00 ET (18:00 UTC), entre les creneaux de
   * 12:30 et 17:00. Image : prompt dedie, pattes-de-chien verifiees par genereImageVerifiee. */
  { nom: 'hidden-gem', a: Date.parse('2026-10-11T18:00:00Z'),
    sujet: 'SWOGE ($SWOGE) is a community-run memecoin on Robinhood Chain that already ships real, live products: a sportsbook (SWOGE Bet), a casino, SWOGE World, a wallet with a token launchpad, and AI agents. It is still under the radar.',
    texte: 'Hidden gem on Robinhood Chain 💎🐕\n\n'
      + '$SWOGE is community-run and already ships real products: a sportsbook, a casino, SWOGE World, a wallet, a launchpad and AI agents.\n\n'
      + 'Still under the radar. Most of CT hasn\'t found it yet. #RobinhoodChain',
    prompt: 'kneeling in a dark rocky cave at night, brushing dust off a huge glowing green gemstone half-buried in the ground; the gem lights up his face and the cave walls; '
      + 'a small lantern beside him, tiny sparkles floating in the air; amazed confident grin, cinematic lighting' },
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

/** Dans le serveur : un regard toutes les cinq minutes, le journal decide.
 *  `deps` (11/10/2026) : `{ game, colonie }` du serveur, pour les chiffres vivants
 *  des produits (instantane) ; sans eux, ces chiffres ne sont simplement pas dits. */
function planifie(signale, deps) {
  if (deps) DEPS = deps;
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
                   heureLocale, creneauDu, jourDe, litJournal, dernieres, DOSSIER_IMAGES, RESERVE,
                   /* chaque post parle d un produit (11/10/2026) */
                   PRODUITS, NOUVEAUTES, ROTATION, MOTS_INTERDITS, SCENES_PRODUITS, SECONDAIRES, VERIFIE, TONS_PRODUIT, MONDE_VIVANTS_MIN,
                   NOUVEAUTE_FRAICHE_JOURS, NOUVEAUTE_RETOUR_JOURS, NOUVEAUTE_SORTIES_MAX, NOUVEAUTE_UN_SUR, choixSujet, sujetDe, verifieTexte, nombres, instantane,
                   sceneProduit, sceneDeNom, angleDuCreneau, produitDe, corrigeNoms, nouveautesDues,
                   /* relecture du 11/10 */
                   LIENS_VOLETS, MOTS_NOMBRES, reserveDe, empreinte,
                   /* seconde relecture du 11/10 */
                   absolus, comptes, UNITES, SYSTEME, SYSTEME_JUGE, jugeTexte };

// ------------------------------------------------------------ en ligne de commande

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    if (a.includes('--essai')) {
      /* Image + texte, RIEN n est poste : pour voir a quoi ca ressemble. Coute l image. */
      if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY absente'); process.exit(1); }
      const t = Date.now(); const j = litJournal(); const cle = 'essai#' + t;
      /* Le sujet que le prochain creneau prendrait, sans rien ecrire au journal. */
      const v = instantane(null, t);
      const c = choixSujet(cle, j, t, { vivant: v });
      const sujet = sujetDe(c, v);
      const scene = sceneProduit(produitDe(sujet.produit), cle, j);
      console.log('sujet :', sujet.nouveaute ? 'nouveaute ' + sujet.nouveaute : 'produit ' + sujet.produit, '· scene :', scene.nom);
      const g = await genereImage(promptImage(scene, cle));
      const i = a.indexOf('--essai');
      const sortie = path.resolve(a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : '_x_essai.png');
      fs.writeFileSync(sortie, g.png);
      console.log('image :', sortie, '·', g.jetons, 'jetons');
      const r = await ecritTexte([], { scene, cle, maintenant: t, angle: angleDuCreneau(cle, sujet, j), sujetProduit: sujet, precedents: dernieres(j, 5).map((x) => x.texte) });
      console.log('texte (' + r.via + (r.refus ? ', refus : ' + r.refus : '') + ') :\n' + r.texte);
      return;
    }
    if (a.includes('--sujets')) {
      /* Les huit prochains sujets, d apres le journal du volume : rien n est genere, rien n est paye, rien n est ecrit. */
      const t0 = Date.now(); const e = env(); const j = litJournal(); const v = instantane(null, t0);
      for (let k = 0, q = 0; k < 8 && q < 40; q++) {
        const tk = t0 + q * 3 * 3600e3; const cr = creneauDu(tk, e.heures, e.fuseau);
        if (!cr || j.jours[cr.cle]) continue;
        const c = choixSujet(cr.cle, j, tk, { vivant: v }); const s = sujetDe(c, v);
        console.log(`${cr.cle}  ${c.nouveaute ? 'NOUVEAUTE ' + c.nouveaute : 'produit ' + c.produit + ' (rang ' + c.rang + ')'}  ·  ${s.lead.slice(0, 90)}`);
        j.jours[cr.cle] = Object.assign({ id: 'simule', quand: new Date(tk).toISOString() }, c); k++;
      }
      return;
    }
    if (a.includes('--publie')) {
      reprend();
      const r = await tache({ force: true });
      console.log(JSON.stringify(r, null, 1));
      process.exit(r.etat === 'poste' || r.etat === 'deja' ? 0 : 1);
    }
    console.log('usage : --essai [fichier.png]  (image + texte, sans poster) | --sujets  (les huit prochains sujets, gratuit) | --publie  (poste le creneau en cours)');
    console.log('cles :', enabled() ? 'toutes presentes' : 'il manque ' + manque().join(', '));
    console.log('creneaux :', env().heures.join(', '), env().fuseau);
  })().catch((e) => { console.error(e.message || e); process.exit(1); });
}
