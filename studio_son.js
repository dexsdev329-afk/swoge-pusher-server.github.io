'use strict';
/* ==================================================================
 * SWOGE STUDIO — L'ONGLET VOICE : VOIX OFF ET MUSIQUE (ElevenLabs)
 * ==================================================================
 *
 * Demande du proprietaire, 16 octobre 2026 : `ELEVENLABS_API_KEY` est posee sur
 * Railway ; « allumer » la voix off du Studio et ajouter la musique. Le nom
 * `studio_voix.js` est deja pris (la transcription du vocal du chat) : ce
 * module est donc `studio_son.js`.
 *
 * ---- L'API, RELUE LE 16/10/2026 DANS LA DOCUMENTATION OFFICIELLE ----
 * Aucun appel reel n'a ete fait pour ecrire ce module ; tout ce qui suit vient
 * des pages citees. Authentification : en-tete `xi-api-key` (exemples de code
 * de chaque page). Base : https://api.elevenlabs.io.
 *
 *  - Voix off : POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128,
 *    corps JSON { text, model_id, language_code? } ; la reponse est le fichier.
 *    https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 *    `language_code` (ISO 639-1) : « Not supported for multilingual_v2 models »
 *    sur cette page ; documente pour v3 sur la page des modeles.
 *  - Modeles : https://elevenlabs.io/docs/overview/models
 *      eleven_v3          5 000 caracteres par requete, 70+ langues, language_code documente ;
 *      eleven_flash_v2_5 40 000 caracteres par requete, 32 langues, language_code NON documente.
 *    (eleven_v4 n'est annonce que « via the Text to Dialogue API » : pas pris.)
 *  - Voix : GET /v2/voices?category=premade&page_size=100 — `category` accepte
 *    premade | cloned | generated | professional ; chaque voix porte voice_id,
 *    name, category, preview_url, labels, description.
 *    https://elevenlabs.io/docs/api-reference/voices/search
 *    Seules les voix `premade` (les voix de la bibliotheque d'ElevenLabs) sont
 *    gardees, filtrees une seconde fois ICI sur `category === 'premade'` : la
 *    liste est fermee et tenue par le serveur, une voix hors liste est refusee.
 *  - Musique : POST /v1/music, corps JSON { prompt, music_length_ms (3000 a
 *    600000), model_id (music_v1 | music_v2 | music_v2_5), force_instrumental } ;
 *    sans output_format, « auto » rend du MP3 (mp3_44100_128 en v1,
 *    mp3_48000_192 en v2). https://elevenlabs.io/docs/api-reference/music/compose
 *    La page produit dit « maximum duration of 5 minutes » :
 *    https://elevenlabs.io/docs/capabilities/music — on reste tres en dessous.
 *  - Regles de contenu de la musique : « mentioning a band or musician by name
 *    or using copyrighted lyrics » rend une erreur `bad_prompt`, lue dans
 *    `detail.status`, avec `detail.data.prompt_suggestion`.
 *    https://elevenlabs.io/docs/cookbooks/music/quickstart
 *    On refuse ICI un prompt qui nomme clairement un artiste connu (liste
 *    fermee ARTISTES, et « in the style of / sounds like <Nom Propre> ») ; le
 *    reste, le fournisseur le refuse — sans facturer.
 *  - PAS DE CLONAGE : aucun appel a /v1/voices/add, aucun televersement de
 *    voix, aucun endpoint d'Instant/Professional Voice Cloning dans ce module.
 *    C'est la regle affichee aux joueurs.
 *
 * ---- LE PRIX (grille relue le 16/10/2026, https://elevenlabs.io/pricing/api) ----
 *   Texte en voix : 0,08 $ / 1 000 caracteres (v4, v3, Multilingual v2),
 *                   0,04 $ / 1 000 caracteres (Flash / Turbo), « same on every tier ».
 *   Musique : 0,150 $ par minute, sur chaque palier.
 *   La grille ne dit ni comment les caracteres sont comptes, ni si la musique
 *   est facturee a la seconde ou a la minute entamee : NON VERIFIE sans appel
 *   reel. On compte les caracteres en unites UTF-16 (>= le nombre de caracteres
 *   visibles : jamais sous le cout) et la musique au prorata de la seconde.
 *   Prix au joueur = cout de liste × STUDIO_MARGE (1,5 par defaut, la marge de
 *   tout le Studio), plancher 0,001 $, arrondi au 1/10 000 de dollar superieur
 *   (la meme regle que studio_media.pourUsd). Le prix est CONNU avant l'appel
 *   (caracteres comptes ici, duree choisie) : la reserve est ce prix, la facture
 *   aussi ; un echec rend tout.
 *
 * ---- LA REGLE D'ARGENT (celle de credits.js) ----
 *   1. `confirmeUsd` (le prix montre sur le bouton) est recompare au prix
 *      recalcule ici : un ecart = 409, rien de reserve ;
 *   2. le plafond du jour (cout fournisseur engage par jour UTC,
 *      STUDIO_SON_PLAFOND_JOUR_USD) et le debit par wallet sont verifies AVANT
 *      la reserve ;
 *   3. RESERVE du prix sur le credit en dollars de l'adresse de SESSION ;
 *   4. l'appel ; un refus d'ElevenLabs, une panne, un fichier illisible :
 *      la reserve est RENDUE entiere et le plafond du jour aussi ;
 *   5. sinon le fichier est range (48 h, lisible par cette adresse seule) et la
 *      reserve est REGLEE au prix.
 *   Une reserve ouverte pendant un redemarrage est rendue au demarrage par
 *   credits.js (reserve ordinaire, non durable : l'appel ne se reprend pas).
 *
 * ---- LES VARIABLES ----
 *   ELEVENLABS_API_KEY            la cle ; sans elle le service est eteint ;
 *   STUDIO_SON_PLAFOND_JOUR_USD   cout ElevenLabs engage par jour UTC (5 $ ; 0 ferme) ;
 *   STUDIO_SON_PAR_MINUTE         generations par wallet et par minute (4) ;
 *   STUDIO_SON_TEXTE_MAX          caracteres d'une voix off (2 500, borne 5 000) ;
 *   STUDIO_SON_MUSIQUE_MODELE     music_v1 | music_v2 | music_v2_5 (music_v2_5) ;
 *   STUDIO_MARGE                  la marge du Studio (1,5).
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://api.elevenlabs.io';
const SORTIE_VOIX = 'mp3_44100_128';
/* Les deux modeles proposes : qualite et rapide. */
const MODELES_VOIX = [
  { id: 'qualite', nom: 'Quality', api: 'eleven_v3', parMilleUsd: 0.08, maxCaracteres: 5000, langue: true },
  { id: 'rapide', nom: 'Fast', api: 'eleven_flash_v2_5', parMilleUsd: 0.04, maxCaracteres: 40000, langue: false },
];
/* Les langues proposees pour eleven_v3 (ISO 639-1, page des modeles) ; « auto » = rien d'envoye. */
const LANGUES = [
  { id: 'auto', nom: 'Auto' }, { id: 'en', nom: 'English' }, { id: 'fr', nom: 'French' }, { id: 'es', nom: 'Spanish' },
  { id: 'de', nom: 'German' }, { id: 'it', nom: 'Italian' }, { id: 'pt', nom: 'Portuguese' }, { id: 'nl', nom: 'Dutch' },
  { id: 'pl', nom: 'Polish' }, { id: 'tr', nom: 'Turkish' }, { id: 'ja', nom: 'Japanese' }, { id: 'ko', nom: 'Korean' },
  { id: 'zh', nom: 'Chinese' }, { id: 'hi', nom: 'Hindi' }, { id: 'ar', nom: 'Arabic' },
];
const MUSIQUE_PAR_MINUTE_USD = 0.15;
const MODELES_MUSIQUE = ['music_v1', 'music_v2', 'music_v2_5'];
/* Les durees offertes : de 10 s a 2 min (l'API va de 3 s a 10 min). */
const DUREES_MUSIQUE = [10, 30, 60, 120];
const PROMPT_MAX = 600;
const VOIX_MAX = 60;
const GARDE_MS = 48 * 3600 * 1000;
const VOIX_TTL_MS = 6 * 3600 * 1000;
const VOIX_ECHEC_MS = 60 * 1000;
const DELAI_VOIX_MS = 90 * 1000;
const DELAI_MUSIQUE_MS = 4 * 60 * 1000;
const MIN_USD = 0.001;

/* Des artistes connus, nommes clairement : refuses avant tout appel. Liste courte et
   volontairement evidente ; ElevenLabs refuse le reste (bad_prompt, gratuit). */
const ARTISTES = ['taylor swift', 'drake', 'beyonce', 'beyoncé', 'rihanna', 'adele', 'ed sheeran', 'billie eilish', 'the weeknd', 'kanye west',
  'kanye', 'ye', 'eminem', 'kendrick lamar', 'travis scott', 'post malone', 'ariana grande', 'justin bieber', 'bruno mars', 'lady gaga',
  'katy perry', 'dua lipa', 'harry styles', 'olivia rodrigo', 'bad bunny', 'shakira', 'jay-z', 'jay z', 'nicki minaj', 'cardi b',
  'snoop dogg', 'dr. dre', 'dr dre', '50 cent', 'tupac', '2pac', 'notorious b.i.g', 'biggie', 'michael jackson', 'madonna', 'prince',
  'elvis presley', 'elvis', 'the beatles', 'beatles', 'rolling stones', 'queen', 'freddie mercury', 'led zeppelin', 'pink floyd', 'nirvana',
  'metallica', 'ac/dc', 'acdc', 'coldplay', 'imagine dragons', 'linkin park', 'daft punk', 'david guetta', 'calvin harris', 'avicii',
  'skrillex', 'marshmello', 'tiesto', 'tiësto', 'martin garrix', 'deadmau5', 'hans zimmer', 'john williams', 'bts', 'blackpink',
  'frank sinatra', 'bob marley', 'bob dylan', 'david bowie', 'whitney houston', 'mariah carey', 'celine dion', 'céline dion', 'stromae',
  'aya nakamura', 'jul', 'pnl', 'booba', 'ninho', 'johnny hallyday', 'edith piaf', 'édith piaf', 'sza', 'doja cat', 'lil wayne',
  'lil nas x', 'future', 'metro boomin', 'travis barker', 'green day', 'arctic monkeys', 'radiohead', 'u2', 'abba', 'bee gees',
  'stevie wonder', 'aretha franklin', 'ray charles', 'louis armstrong', 'miles davis', 'mozart', 'beethoven', 'bach', 'chopin', 'vivaldi'];
/* Les compositeurs classiques sont du domaine public, mais ElevenLabs ne publie pas
   d'exception : mieux vaut un refus clair et gratuit ici qu'un refus chez lui. */

const nombre = (v, def, min, max) => { const x = Number(v); return v != null && String(v).trim() !== '' && Number.isFinite(x) && x >= min && x <= max ? x : def; };
/** Les reglages, lus dans l'environnement (bornes : voir l'en-tete). */
function reglages(env) {
  env = env || process.env;
  const mm = String(env.STUDIO_SON_MUSIQUE_MODELE || '').trim();
  return {
    marge: nombre(env.STUDIO_MARGE, 1.5, 1, 10),
    plafondJourUsd: nombre(env.STUDIO_SON_PLAFOND_JOUR_USD, 5, 0, 1000),
    parMinute: Math.floor(nombre(env.STUDIO_SON_PAR_MINUTE, 4, 1, 60)),
    texteMax: Math.floor(nombre(env.STUDIO_SON_TEXTE_MAX, 2500, 50, 5000)),
    musiqueModele: MODELES_MUSIQUE.includes(mm) ? mm : 'music_v2_5',
  };
}

/** Le prix au joueur : cout de liste × marge, plancher 0,001 $, au 1/10 000 $ superieur. */
function prixClient(coutUsd, marge) {
  const f = Math.max(MIN_USD, Number(coutUsd) * Number(marge));
  return Math.ceil(Math.round(f * 1e8) / 1e4 - 1e-9) / 1e4;
}
/** Le nombre de caracteres facture : la longueur UTF-16 (jamais sous le compte visible). */
const caracteres = (t) => String(t || '').length;
function coutVoixUsd(texte, modele) { return caracteres(texte) / 1000 * modele.parMilleUsd; }
function coutMusiqueUsd(secondes) { return Number(secondes) / 60 * MUSIQUE_PAR_MINUTE_USD; }

/** Un texte sans caracteres de controle (les sauts de ligne restent), borde d'espaces ote. */
function nettoie(t) { return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim(); }
const sansAccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
/**
 * Le prompt nomme-t-il clairement un artiste connu ? Rend le nom, ou null.
 * Deux tests : la liste ARTISTES (mot entier, sans casse ni accent), puis une
 * reference explicite a quelqu'un : « in the style of / sounds like / cover of /
 * a song by / remix of » suivi d'un Nom Propre (majuscule).
 */
/* Des mots a majuscule qui disent un genre, un lieu ou une epoque, pas quelqu'un. */
const PAS_UN_ARTISTE = new Set(['latin', 'bollywood', 'hollywood', 'japanese', 'celtic', 'irish', 'african', 'brazilian', 'arabic', 'indian', 'chinese',
  'french', 'spanish', 'italian', 'german', 'korean', 'disney', 'christmas', 'western', 'eastern', 'baroque', 'classical', 'motown', 'broadway',
  'jamaican', 'caribbean', 'nordic', 'viking', 'medieval', 'renaissance', 'gospel', 'jazz', 'blues', 'rock', 'pop', 'hip', 'house', 'techno', 'trap',
  'lo-fi', 'lofi', 'synthwave', 'k-pop', 'j-pop', 'edm', 'afrobeat', 'afrobeats', 'reggae', 'reggaeton', 'ska', 'funk', 'soul', 'disco', 'opera',
  'cuban', 'mexican', 'american', 'british', 'english', 'scottish', 'russian', 'greek', 'turkish', 'persian', 'egyptian', 'hawaiian', 'tibetan',
  'the', 'a', 'an', 'old', 'new', 'early', 'late', 'modern', 'retro', 'epic', 'dark', 'happy', 'sad', 'video', 'anime', 'cinematic', 'gregorian']);
function artisteNomme(prompt) {
  const p = String(prompt || '');
  const bas = ' ' + sansAccent(p.toLowerCase()).replace(/[^a-z0-9/.$&-]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  /* deux lectures : les points gardes (« dr. dre », « b.i.g ») et les points en espaces (« drake. ») */
  const lectures = [bas, bas.replace(/\./g, ' ').replace(/\s+/g, ' ')];
  for (const a of ARTISTES) {
    const k = sansAccent(a);
    const cles = [k, k.replace(/\./g, ' ').replace(/\s+/g, ' ').trim()];
    /* « ye », « jul », « queen », « prince », « future », « bach » sont aussi des mots :
       seulement derriere une reference explicite (« by », « sounds like », « style of ») —
       « like future bass » est un genre. */
    if (['ye', 'jul', 'queen', 'prince', 'future', 'bach'].includes(k)) {
      if (lectures.some((l) => new RegExp('\\b(by|sounds like|style of|cover of|remix of|inspired by)\\s+' + k + '\\b').test(l))) return a;
      continue;
    }
    if (lectures.some((l) => cles.some((c) => l.includes(' ' + c + ' ')))) return a;
  }
  const re = /\b(?:in the style of|sounds? like|sounding like|cover of|a song by|songs? by|track by|remix of)\s+((?:[A-Z][\w'.&-]*)(?:\s+[A-Z][\w'.&-]*){0,3})/g;
  let m;
  while ((m = re.exec(p))) {
    const premier = m[1].split(/\s+/)[0].toLowerCase();
    if (!PAS_UN_ARTISTE.has(premier)) return m[1];
  }
  return null;
}

/** Une voix de la bibliotheque, mise en forme pour la page (aucun champ prive). */
function voixDe(v) {
  if (!v || typeof v !== 'object' || v.category !== 'premade') return null;
  const id = String(v.voice_id || '');
  if (!/^[A-Za-z0-9]{8,40}$/.test(id)) return null;
  const l = v.labels && typeof v.labels === 'object' ? v.labels : {};
  const traits = ['accent', 'descriptive', 'description', 'gender', 'age', 'use_case', 'use case']
    .map((k) => l[k]).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().replace(/_/g, ' ').slice(0, 24));
  const apercu = typeof v.preview_url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v.preview_url) ? v.preview_url : null;
  return { id, nom: String(v.name || id).slice(0, 40), traits: Array.from(new Set(traits)).slice(0, 3), apercu };
}

/** Un MP3 ? En-tete ID3, ou un mot de synchronisation de trame (11 bits a 1). */
function estMp3(b) { return !!b && b.length > 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)); }

/**
 * deps : { dossier, cle() → la cle ou '', fetch?, base?, maintenant?, env?,
 *          paie: { reserve(addr, usd) → jeton|null, regle(addr, jeton, usd), solde(addr) → usd },
 *          journal?(o) }
 */
function cree(deps) {
  const R = () => reglages(deps.env);
  const maintenant = deps.maintenant || Date.now;
  const fetchF = deps.fetch || ((u, o) => globalThis.fetch(u, o));
  const base = String(deps.base || BASE).replace(/\/+$/, '');
  const cle = () => String((deps.cle ? deps.cle() : process.env.ELEVENLABS_API_KEY) || '').trim();
  const actif = () => !!cle();
  const journal = (o) => { try { if (deps.journal) deps.journal(o); } catch (e) { /* jamais bloquant */ } };
  const MESURE = { voix: 0, musiques: 0, refus: 0, echecs: 0, coutUsd: 0, factureUsd: 0, refusArtiste: 0 };
  const EN_VOL = new Set();
  const RYTHME = new Map();
  let VOIX = { liste: null, t: 0, ok: false, enCours: null };

  /* ---- le plafond du jour : cout ElevenLabs ENGAGE par jour UTC, garde sur le volume ---- */
  const fJour = deps.dossier ? path.join(deps.dossier, 'jour.json') : null;
  let J = { jour: '', usd: 0 };
  try { if (fJour) J = Object.assign(J, JSON.parse(fs.readFileSync(fJour, 'utf8'))); } catch (e) { /* premier jour */ }
  const jourUtc = () => new Date(maintenant()).toISOString().slice(0, 10);
  function jour() { const d = jourUtc(); if (J.jour !== d) J = { jour: d, usd: 0 }; return J; }
  function ecritJour() {
    if (!fJour) return;
    try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(fJour + '.tmp', JSON.stringify(J)); fs.renameSync(fJour + '.tmp', fJour); } catch (e) { /* jamais bloquant */ }
  }
  function engage(usd) { jour().usd = Math.round((J.usd + usd) * 1e6) / 1e6; ecritJour(); }
  function degage(usd) { jour().usd = Math.max(0, Math.round((J.usd - usd) * 1e6) / 1e6); ecritJour(); }

  function rythmeOk(addr, t) {
    const l = (RYTHME.get(addr) || []).filter((x) => t - x < 60000);
    if (l.length >= R().parMinute) { RYTHME.set(addr, l); return false; }
    l.push(t); RYTHME.set(addr, l); return true;
  }

  /* ---- les voix de la bibliotheque (premade), relues toutes les 6 h ---- */
  async function chargeVoix() {
    if (!actif()) return null;
    const t = maintenant();
    if (VOIX.liste && t - VOIX.t < (VOIX.ok ? VOIX_TTL_MS : VOIX_ECHEC_MS)) return VOIX.liste;
    if (!VOIX.liste && VOIX.t && t - VOIX.t < VOIX_ECHEC_MS) return null;
    if (VOIX.enCours) return VOIX.enCours;
    VOIX.enCours = (async () => {
      try {
        const r = await fetchF(base + '/v2/voices?category=premade&page_size=100', {
          method: 'GET', headers: { 'xi-api-key': cle(), accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('voices ' + r.status);
        const j = await r.json();
        const l = (Array.isArray(j && j.voices) ? j.voices : []).map(voixDe).filter(Boolean);
        const vus = new Set();
        const liste = l.filter((v) => (vus.has(v.id) ? false : vus.add(v.id))).sort((a, b) => a.nom.localeCompare(b.nom)).slice(0, VOIX_MAX);
        if (!liste.length) throw new Error('no premade voice');
        VOIX = { liste, t: maintenant(), ok: true, enCours: null };
      } catch (e) {
        console.error('[studio son] voices: ' + String(e && e.message || e).slice(0, 120));
        /* garde l'ancienne liste si on en a une ; relit dans une minute */
        VOIX = { liste: VOIX.liste, t: maintenant(), ok: false, enCours: null };
      }
      return VOIX.liste;
    })();
    return VOIX.enCours;
  }

  /* ---- ce que la page lit avant tout : prix, bornes, voix ---- */
  async function catalogue() {
    const r = R();
    const a = actif();
    const voix = a ? await chargeVoix() : null;
    const j = jour();
    const ferme = a && !(r.plafondJourUsd > 0);
    const plein = a && r.plafondJourUsd > 0 && j.usd >= r.plafondJourUsd - 1e-9;
    return {
      ok: true, actif: a, marge: r.marge,
      note: !a ? 'Voice and music are coming soon.' : ferme ? 'Voice and music are paused right now.' : plein ? 'Today\'s voice and music budget is used up — come back tomorrow (UTC).' : null,
      pause: !!(ferme || plein),
      payeur: 'credit',
      voix: { actif: a && !!(voix && voix.length), texteMax: r.texteMax,
        note: a && !(voix && voix.length) ? 'The voice list could not be loaded — try again in a minute.' : null,
        modeles: MODELES_VOIX.map((m) => ({ id: m.id, nom: m.nom, langue: m.langue, parMilleUsd: prixClient(m.parMilleUsd, r.marge),
          maxCaracteres: Math.min(m.maxCaracteres, r.texteMax) })),
        langues: LANGUES, voix: a && voix ? voix : [] },
      musique: { actif: a, promptMax: PROMPT_MAX, durees: DUREES_MUSIQUE,
        parMinuteUsd: prixClient(MUSIQUE_PAR_MINUTE_USD, r.marge),
        prixUsd: DUREES_MUSIQUE.reduce((o, s) => { o[s] = prixClient(coutMusiqueUsd(s), r.marge); return o; }, {}) },
      regles: { voixBibliotheque: true, clonage: false, artistes: false, gardeHeures: GARDE_MS / 3600000 },
    };
  }

  /* ---- les fichiers : 48 h, lisibles par l'adresse qui les a payes seule ---- */
  const dossierF = () => path.join(deps.dossier || '.', 'fichiers');
  const ID = /^[0-9a-f]{48}$/;
  function range(addr, octets, info) {
    fs.mkdirSync(dossierF(), { recursive: true });
    const id = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(path.join(dossierF(), id + '.mp3'), octets);
    const meta = Object.assign({ id, addr: String(addr).toLowerCase(), t: maintenant(), octets: octets.length }, info);
    fs.writeFileSync(path.join(dossierF(), id + '.json'), JSON.stringify(meta));
    return meta;
  }
  function meta(id) {
    if (!ID.test(String(id || ''))) return null;
    try { return JSON.parse(fs.readFileSync(path.join(dossierF(), id + '.json'), 'utf8')); } catch (e) { return null; }
  }
  /** Le fichier, pour SON adresse seulement, et pas plus vieux que 48 h ; null sinon. */
  function fichier(id, addr) {
    const m = meta(id);
    if (!m || !addr || m.addr !== String(addr).toLowerCase() || maintenant() - m.t > GARDE_MS) return null;
    const p = path.join(dossierF(), m.id + '.mp3');
    try { return { chemin: p, taille: fs.statSync(p).size, nom: 'swoge-' + (m.genre === 'musique' ? 'music' : 'voice') + '-' + m.id.slice(0, 8) + '.mp3' }; } catch (e) { return null; }
  }
  /** Ce que la page montre d'un resultat : jamais l'adresse, ni le texte entier. */
  const vue = (m) => ({ id: m.id, genre: m.genre === 'musique' ? 'music' : 'voice', t: m.t, expire: m.t + GARDE_MS, prixUsd: m.prixUsd,
    voix: m.voixNom || null, modele: m.modele || null, secondes: m.secondes || null, caracteres: m.caracteres || null,
    titre: String(m.titre || '').slice(0, 80), url: '/studio/son/fichier/' + m.id });
  /** Les resultats encore gardes de cette adresse, les plus recents d'abord. */
  function mes(addr) {
    const a = String(addr || '').toLowerCase();
    let l = [];
    try { l = fs.readdirSync(dossierF()).filter((f) => /^[0-9a-f]{48}\.json$/.test(f)).map((f) => meta(f.slice(0, 48))).filter(Boolean); } catch (e) { l = []; }
    return l.filter((m) => m.addr === a && maintenant() - m.t <= GARDE_MS).sort((x, y) => y.t - x.t).slice(0, 20).map(vue);
  }
  /** Efface ce qui a plus de 48 h. */
  function menage() {
    let n = 0;
    try {
      for (const f of fs.readdirSync(dossierF())) {
        const m = /^([0-9a-f]{48})\.json$/.exec(f); if (!m) continue;
        const x = meta(m[1]);
        if (!x || maintenant() - x.t > GARDE_MS) {
          for (const e of ['.json', '.mp3']) { try { fs.unlinkSync(path.join(dossierF(), m[1] + e)); } catch (er) { /* deja parti */ } }
          n++;
        }
      }
    } catch (e) { /* pas encore de dossier */ }
    return n;
  }

  /* ---- un appel a ElevenLabs : le fichier, ou une erreur classee ---- */
  async function appelle(chemin, corps, delaiMs) {
    let r;
    try {
      r = await fetchF(base + chemin, { method: 'POST', headers: { 'xi-api-key': cle(), 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify(corps), signal: AbortSignal.timeout(delaiMs) });
    } catch (e) { return { panne: true, detail: String(e && e.name === 'TimeoutError' ? 'timeout' : (e && e.message) || e).slice(0, 120) }; }
    if (!r.ok) {
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      const d = j && j.detail;
      const statut = d && typeof d === 'object' && !Array.isArray(d) ? String(d.status || '') : '';
      const suggestion = d && d.data && typeof d.data.prompt_suggestion === 'string' ? d.data.prompt_suggestion.slice(0, 400) : null;
      const message = d && typeof d === 'object' && !Array.isArray(d) && typeof d.message === 'string' ? d.message.slice(0, 200) : null;
      return { refus: r.status < 500, panne: r.status >= 500, http: r.status, statut, suggestion, message };
    }
    let b;
    try { b = Buffer.from(await r.arrayBuffer()); } catch (e) { return { panne: true, detail: 'unreadable audio' }; }
    if (!estMp3(b)) return { panne: true, detail: 'not an mp3' };
    return { octets: b };
  }

  /**
   * Le chemin commun : prix confirme, plafond, debit, reserve, appel, rangement, reglement.
   * o : { addr, genre, coutUsd, confirmeUsd, appel: async () → resultat d'appelle, info }
   */
  async function genere(o) {
    const r = R();
    const addr = o.addr;
    const prix = prixClient(o.coutUsd, r.marge);
    if (!(Math.abs(Number(o.confirmeUsd) - prix) < 0.00005)) return { ok: false, code: 409, raison: 'the price is now $' + prix.toFixed(4) + ' — check it and confirm again', prixUsd: prix };
    if (!(r.plafondJourUsd > 0)) return { ok: false, code: 503, raison: 'Voice and music are paused right now.' };
    if (jour().usd + o.coutUsd > r.plafondJourUsd + 1e-9) return { ok: false, code: 429, raison: 'Today\'s voice and music budget is used up — come back tomorrow (UTC). Nothing was charged.' };
    if (EN_VOL.has(addr)) return { ok: false, code: 429, raison: 'one generation at a time — wait for the current one' };
    if (!rythmeOk(addr, maintenant())) return { ok: false, code: 429, raison: 'too many generations — wait a minute' };
    const jeton = deps.paie.reserve(addr, prix);
    if (!jeton) {
      const s = deps.paie.solde ? deps.paie.solde(addr) : null;
      return { ok: false, code: 402, raison: 'your dollar credit is too low ($' + prix.toFixed(4) + ' needed' + (s != null ? ', you have $' + Number(s).toFixed(2) : '') + ') — top it up with a wallet signature', requisUsd: prix };
    }
    EN_VOL.add(addr);
    engage(o.coutUsd);
    journal({ sorte: 'envoi', genre: o.genre, addr, prixUsd: prix, coutUsd: o.coutUsd });
    let res;
    try { res = await o.appel(); } catch (e) { res = { panne: true, detail: String(e && e.message || e).slice(0, 120) }; }
    const rend = (raison) => {
      deps.paie.regle(addr, jeton, 0);
      degage(o.coutUsd);
      EN_VOL.delete(addr);
      journal({ sorte: 'rendu', genre: o.genre, addr, raison: String(raison || '').slice(0, 160) });
    };
    if (!res || !res.octets) {
      if (res && res.refus) {
        MESURE.refus++;
        rend('refus ' + res.http + ' ' + (res.statut || ''));
        const sug = res.suggestion;
        return { ok: false, code: 422, refus: true,
          raison: (res.statut === 'bad_prompt' || res.statut === 'bad_composition_plan'
            ? 'ElevenLabs refused this prompt (it may name an artist, a song or copyrighted lyrics). You were not charged.'
            : 'ElevenLabs refused this request' + (res.message ? ' (' + res.message + ')' : '') + '. You were not charged.'),
          suggestion: sug || null };
      }
      MESURE.echecs++;
      rend('panne ' + ((res && (res.http || res.detail)) || ''));
      return { ok: false, code: 502, raison: 'the voice provider failed — you were not charged' };
    }
    let m;
    try { m = range(addr, res.octets, Object.assign({ genre: o.genre, prixUsd: prix, coutUsd: o.coutUsd }, o.info)); }
    catch (e) { rend('rangement'); MESURE.echecs++; return { ok: false, code: 500, raison: 'the file could not be saved — you were not charged' }; }
    const solde = deps.paie.regle(addr, jeton, prix);
    EN_VOL.delete(addr);
    MESURE.coutUsd += o.coutUsd; MESURE.factureUsd += prix;
    if (o.genre === 'musique') MESURE.musiques++; else MESURE.voix++;
    journal({ sorte: 'livre', genre: o.genre, addr, prixUsd: prix, coutUsd: o.coutUsd, octets: res.octets.length, id: m.id });
    return Object.assign({ ok: true, payeur: 'credit', factureUsd: prix, creditUsd: solde == null ? null : Number(solde) }, vue(m));
  }

  /** Une voix off. q = { addr, texte, voix (voice_id de la liste), modele (qualite|rapide), langue, confirmeUsd } */
  async function voixOff(q) {
    const addr = q && q.addr;
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    if (!actif()) return { ok: false, code: 503, raison: 'Voice-over is coming soon.' };
    const r = R();
    const texte = nettoie(q.texte);
    const m = MODELES_VOIX.find((x) => x.id === q.modele) || MODELES_VOIX[0];
    if (!texte) return { ok: false, code: 400, raison: 'write the script to read' };
    const max = Math.min(m.maxCaracteres, r.texteMax);
    if (caracteres(texte) > max) return { ok: false, code: 400, raison: 'your script is ' + caracteres(texte) + ' characters — ' + max + ' at most' };
    const liste = await chargeVoix();
    if (!liste || !liste.length) return { ok: false, code: 503, raison: 'The voice list could not be loaded — try again in a minute. Nothing was charged.' };
    const v = liste.find((x) => x.id === String(q.voix || ''));
    if (!v) return { ok: false, code: 400, raison: 'pick one of the listed voices — only our built-in voices can be used, never a copy of someone\'s voice' };
    const langue = m.langue && q.langue && q.langue !== 'auto' ? LANGUES.find((x) => x.id === q.langue && x.id !== 'auto') : null;
    if (m.langue && q.langue && q.langue !== 'auto' && !langue) return { ok: false, code: 400, raison: 'unknown language' };
    const corps = { text: texte, model_id: m.api };
    if (langue) corps.language_code = langue.id;
    return genere({ addr, genre: 'voix', coutUsd: coutVoixUsd(texte, m), confirmeUsd: q.confirmeUsd,
      appel: () => appelle('/v1/text-to-speech/' + encodeURIComponent(v.id) + '?output_format=' + SORTIE_VOIX, corps, DELAI_VOIX_MS),
      info: { voixNom: v.nom, modele: m.id, caracteres: caracteres(texte), titre: texte.replace(/\s+/g, ' ').slice(0, 80) } });
  }

  /** Une musique. q = { addr, prompt, secondes, instrumental, confirmeUsd } */
  async function musique(q) {
    const addr = q && q.addr;
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    if (!actif()) return { ok: false, code: 503, raison: 'Music is coming soon.' };
    const prompt = nettoie(q.prompt).replace(/\s+/g, ' ');
    if (!prompt) return { ok: false, code: 400, raison: 'describe the music you want' };
    if (prompt.length > PROMPT_MAX) return { ok: false, code: 400, raison: 'your description is ' + prompt.length + ' characters — ' + PROMPT_MAX + ' at most' };
    const s = Number(q.secondes);
    if (!DUREES_MUSIQUE.includes(s)) return { ok: false, code: 400, raison: 'pick a length: ' + DUREES_MUSIQUE.map((x) => x + ' s').join(', ') };
    const a = artisteNomme(prompt);
    if (a) {
      MESURE.refusArtiste++;
      journal({ sorte: 'refus_artiste', genre: 'musique', addr });
      return { ok: false, code: 400, raison: 'Describe the genre, mood, tempo and instruments instead of naming an artist or a song ("' + String(a).slice(0, 40) + '"). Nothing was charged.' };
    }
    const corps = { prompt, music_length_ms: s * 1000, model_id: R().musiqueModele, force_instrumental: q.instrumental !== false };
    return genere({ addr, genre: 'musique', coutUsd: coutMusiqueUsd(s), confirmeUsd: q.confirmeUsd,
      appel: () => appelle('/v1/music', corps, DELAI_MUSIQUE_MS),
      info: { secondes: s, modele: corps.model_id, titre: prompt.slice(0, 80) } });
  }

  return { actif, catalogue, voixOff, musique, fichier, mes, menage, chargeVoix, MESURE, reglages: R,
    etat: () => ({ actif: actif(), jour: Object.assign({}, jour()), plafondJourUsd: R().plafondJourUsd, voix: VOIX.liste ? VOIX.liste.length : 0, mesure: Object.assign({}, MESURE) }) };
}

/**
 * Le paiement sur le credit en dollars (credits.js) : une reserve ORDINAIRE (credits.factu),
 * rendue au demarrage si le serveur s'arrete pendant l'appel.
 */
function paieCredit(credits, quoi) {
  return {
    reserve: (addr, usd) => {
      /* factu(...).reserve est async par contrat ; on prend la reserve brute, synchrone, par soldeChat. */
      const s = credits().soldeChat(quoi);
      const w = BigInt(Math.round(Number(usd) * 1e6)) * 10n ** 12n;
      return s.reserve(addr, w) ? { s, w } : null;
    },
    regle: (addr, j, usd) => j.s.regle(addr, j.w, BigInt(Math.round(Number(usd) * 1e6)) * 10n ** 12n),
    solde: (addr) => credits().soldeUsd(addr),
  };
}

module.exports = { cree, reglages, prixClient, paieCredit, artisteNomme, voixDe, estMp3, coutVoixUsd, coutMusiqueUsd, caracteres,
  MODELES_VOIX, LANGUES, DUREES_MUSIQUE, MUSIQUE_PAR_MINUTE_USD, PROMPT_MAX, GARDE_MS, ARTISTES, BASE };
