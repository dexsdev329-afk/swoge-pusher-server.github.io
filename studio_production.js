'use strict';
/* ==================================================================
 * SWOLEMIND — LES PRODUCTIONS VIDÉO : SÉRIE ET PUB
 * ==================================================================
 *
 * Demande du propriétaire, 26 septembre 2026 : « une mini-série avec SwoleMind,
 * que la voix et les personnages soient les mêmes à chaque scène » — puis
 * « plusieurs modes : série, ou pub pour faire une pub sur un produit ».
 *
 * Le moteur est celui d'xAI (guide reference-to-video relu ce jour-là) :
 * « grok-imagine-video-1.5 » accepte jusqu'à TROIS images de référence
 * (personnes, objets, vêtements — sans figer la première image), que le prompt
 * nomme <IMAGE_1>…<IMAGE_3>, et jusqu'à TROIS voix du catalogue, nommées
 * <AUDIO_0>…<AUDIO_2>, avec dialogue parlé. Une scène dure 15 s au plus.
 *
 * Ce module ne parle à personne : il VALIDE une production (ses personnages ou
 * son produit, leurs images, leurs voix), et CONSTRUIT le prompt et les
 * références de chaque scène. Les mêmes références partent à chaque scène :
 * c'est ce qui garde les mêmes visages et les mêmes voix. L'argent (réserve,
 * coût réel, tout rendu si la scène échoue) est celui des vidéos
 * (`studio_media.lanceVideo`). Les productions vivent dans un fichier par
 * adresse (DATA_DIR/productions/<adresse>.json), jamais dans state.json.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODES = ['serie', 'pub'];
const PERSONNAGES_MAX = 3;
const SCENES_MAX = 60;
const PRODUCTIONS_MAX = 30;
const TEXTE_MAX = 1200;
const NOM_MAX = 40;

/* Les images des personnages et des produits : gardees tant que la production
   existe (pas les sept jours des images generees — studio_fichiers.js), sous un
   nom tire au hasard (24 octets), servies par leur nom : xAI doit pouvoir les lire.
   « swoge » designe l'image officielle de SWOGE, lue sur le site. */
const IMAGE_NOM = /^[0-9a-f]{48}\.(png|jpg|webp)$/;
const IMAGE_PREFIXE = '/studio/production/image/';
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const TYPE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const SWOGE = 'swoge';
const SWOGE_DESCRIPTION = 'a very muscular, bodybuilder-build shiba inu with furry dog paws with paw pads, never human hands or fingers — his outfit follows the scene';

const propre = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Une production propre, ou { erreur }. `image(x)` rend l'image rangée (une
 * adresse publique de fichier) ou null si elle n'est pas une image valable ;
 * `voixOk(v)` dit si la voix est au catalogue.
 */
function valide(p, { image, voixOk }) {
  if (!p || typeof p !== 'object') return { erreur: 'unreadable production' };
  const mode = MODES.includes(p.mode) ? p.mode : null;
  if (!mode) return { erreur: 'mode must be serie or pub' };
  const titre = propre(p.titre, 80);
  if (!titre) return { erreur: 'give it a title' };
  const style = propre(p.style, 200);
  const out = { mode, titre, style, format: ['16:9', '9:16', '1:1'].includes(p.format) ? p.format : (mode === 'pub' ? '9:16' : '16:9') };
  const ref = (x, quoi) => {
    if (x == null || x === '') return null;
    const r = image(x);
    if (!r) return { erreur: quoi + ': the image must be a PNG, JPEG or WebP under 6 MB' };
    return r;
  };
  if (mode === 'serie') {
    const ps = Array.isArray(p.personnages) ? p.personnages : [];
    if (!ps.length) return { erreur: 'a series needs at least one character' };
    if (ps.length > PERSONNAGES_MAX) return { erreur: 'at most ' + PERSONNAGES_MAX + ' characters (the video model keeps 3 references)' };
    out.personnages = [];
    for (const c of ps) {
      const nom = propre(c && c.nom, NOM_MAX);
      if (!nom) return { erreur: 'every character needs a name' };
      const img = ref(c.image, nom);
      if (img && img.erreur) return img;
      if (!img) return { erreur: nom + ': a reference image is needed to keep the same character' };
      const voix = c.voix ? String(c.voix).toLowerCase() : null;
      if (voix && !voixOk(voix)) return { erreur: nom + ': unknown voice' };
      out.personnages.push({ nom, image: img, voix, description: propre(c.description, 160) || (img === SWOGE ? SWOGE_DESCRIPTION : '') });
    }
    const noms = out.personnages.map((c) => c.nom.toLowerCase());
    if (new Set(noms).size !== noms.length) return { erreur: 'two characters have the same name' };
  } else {
    const pr = p.produit || {};
    const nom = propre(pr.nom, 60);
    if (!nom) return { erreur: 'an ad needs the product name' };
    const img = ref(pr.image, 'product');
    if (img && img.erreur) return img;
    if (!img) return { erreur: 'an ad needs a photo of the product' };
    const pres = ref(pr.presentateur, 'presenter');
    if (pres && pres.erreur) return pres;
    const decor = ref(pr.decor, 'setting');
    if (decor && decor.erreur) return decor;
    const voix = pr.voix ? String(pr.voix).toLowerCase() : null;
    if (voix && !voixOk(voix)) return { erreur: 'unknown voice' };
    out.produit = { nom, image: img, presentateur: pres || null, presentateurNom: propre(pr.presentateurNom, NOM_MAX) || null,
                    decor: decor || null, voix, slogan: propre(pr.slogan, 160), appel: propre(pr.appel, 120) };
  }
  return out;
}

/* ---- LA CAMERA ET LA SUITE (27 septembre 2026) ----
 * Mesure sur deux videos du proprietaire, le meme jour. Scene 1 : SWOGE
 * repris (visage, costume) mais camera presque fixe. Scene 2, « fais la
 * suite » : le costume rouge garde, le VISAGE perdu (un autre chien), et une
 * demi-douzaine de chiens inventes autour de la table. Cause : le prompt
 * disait « seuls les personnages NOMMES apparaissent » ; « fais la suite » ne
 * nomme personne, donc le modele ignorait que SWOGE etait dans la scene, et
 * rien ne lui disait ce que racontait la precedente.
 *   - personne n'est nomme : toute la distribution est dans la scene ;
 *   - chaque personnage garde son visage DANS CHAQUE PLAN, et les figurants ne
 *     lui ressemblent pas ;
 *   - la scene precedente est rappelee (meme decor, memes tenues) ;
 *   - un mouvement de camera cinematique est demande, choisi ou automatique. */
const CAMERAS = {
  auto: 'Cinematic camera: one smooth, motivated camera move (slow push-in, tracking or orbit), shallow depth of field, film lighting.',
  pushin: 'Camera: slow dolly push-in toward the main character, shallow depth of field.',
  tracking: 'Camera: smooth tracking shot that follows the action at the characters\' height.',
  orbit: 'Camera: slow orbit around the main character, keeping them centred.',
  crane: 'Camera: crane shot that rises to reveal the whole scene.',
  handheld: 'Camera: energetic handheld action camera, quick but readable.',
  static: 'Camera: locked-off static shot, the action moves inside the frame.',
};
const nomme = (texte, nom) => { const n = String(nom || '').trim(); if (!n) return false;
  return new RegExp('(^|[^\\p{L}\\p{N}])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}\\p{N}])', 'iu').test(texte); };

/**
 * Le prompt et les références d'une scène. Les références partent dans le même
 * ORDRE à chaque scène : <IMAGE_n> et <AUDIO_n> désignent toujours la même chose.
 * opts : { camera: une cle de CAMERAS, precedente: le texte de la scene d'avant }
 */
function scene(prod, texte, duree, opts) {
  opts = opts || {};
  const camera = CAMERAS[opts.camera] ? opts.camera : 'auto';
  const avant = propre(opts.precedente || '', 400);
  const t = propre(texte, TEXTE_MAX);
  if (!t && prod.mode === 'serie') return { erreur: 'describe the scene' };
  const references = [], voix = [];
  const idxVoix = (v) => { if (!v) return null; let i = voix.indexOf(v); if (i < 0) { voix.push(v); i = voix.length - 1; } return i; };
  let prompt;
  if (prod.mode === 'serie') {
    const roles = prod.personnages.map((c) => {
      references.push(c.image);
      const iv = idxVoix(c.voix);
      return c.nom + ' is the character in <IMAGE_' + references.length + '>' + (c.description ? ' (' + c.description + ')' : '')
        + (iv !== null ? ' and speaks with the voice from <AUDIO_' + iv + '>' : '');
    });
    const nommes = prod.personnages.filter((c) => nomme(t, c.nom));
    prompt = 'A scene from the series "' + prod.titre + '". Main characters — keep each one\'s face, fur or skin, body and build from its reference image in EVERY shot, never a different animal, breed or face; their clothes and poses follow the scene unless it says otherwise: '
      + roles.join('; ') + '.'
      + (avant ? ' This scene follows directly from the previous one: "' + avant + '" — same setting, lighting and outfits unless the scene says otherwise.' : '')
      + (opts.debut ? ' The video starts exactly on the given first frame (the last frame of the previous scene) and continues the action from there.' : '')
      + ' Scene: ' + t + (/[.!?"”]$/.test(t) ? '' : '.')
      + (nommes.length ? ' Only the main characters named in the scene appear.' : ' All the main characters above are in this scene.')
      + ' Any other people or animals are unnamed background extras and must not look like the main characters.'
      + ' A line in quotes is spoken aloud, in that character\'s voice.'
      + ' ' + CAMERAS[camera]
      + (prod.style ? ' Visual style: ' + prod.style + '.' : '');
  } else {
    const p = prod.produit;
    references.push(p.image);
    let rolePres = '';
    if (p.presentateur) {
      references.push(p.presentateur);
      const iv = idxVoix(p.voix);
      rolePres = ' The presenter' + (p.presentateurNom ? ', ' + p.presentateurNom + ',' : '') + ' is the character in <IMAGE_' + references.length + '> (keep their face and build) and presents the product'
        + (iv !== null ? ', speaking with the voice from <AUDIO_' + iv + '>' : '') + '.';
    } else if (p.voix) {
      rolePres = ' A voice-over with the voice from <AUDIO_' + idxVoix(p.voix) + '> presents the product.';
    }
    const decor = p.decor ? (references.push(p.decor), ' The setting is the place in <IMAGE_' + references.length + '>.') : '';
    prompt = 'A ' + (duree || 10) + '-second advertisement for "' + p.nom + '", the product in <IMAGE_1> — keep its exact shape, colours, label and logo, and show it clearly and often.'
      + rolePres + decor + (t ? ' ' + t : '')
      + (p.slogan ? ' The line "' + p.slogan + '" is said aloud.' : '')
      + (p.appel ? ' End on the product with the call to action: "' + p.appel + '".' : '')
      + ' ' + CAMERAS[camera]
      + (prod.style ? ' Visual style: ' + prod.style + '.' : '');
  }
  return { prompt: prompt.slice(0, 3900), references, voix, texte: t, camera };
}

/** Toutes les images qu'une production designe. */
function images(p) {
  if (!p) return [];
  if (p.mode === 'serie') return (p.personnages || []).map((c) => c.image);
  const q = p.produit || {};
  return [q.image, q.presentateur, q.decor].filter(Boolean);
}

/* ---- LES PRODUCTIONS D'UNE ADRESSE : un fichier chacune ---- */
function cree({ dossier, maintenant }) {
  const temps = () => (maintenant ? maintenant() : Date.now());
  const fichier = (addr) => path.join(dossier, String(addr).toLowerCase().replace(/[^0-9a-fx]/g, '') + '.json');
  const lis = (addr) => { try { return JSON.parse(fs.readFileSync(fichier(addr), 'utf8')); } catch (e) { return { productions: [] }; } };
  const ecris = (addr, d) => { fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(fichier(addr) + '.tmp', JSON.stringify(d)); fs.renameSync(fichier(addr) + '.tmp', fichier(addr)); };

  function liste(addr) { return lis(addr).productions; }
  function une(addr, id) { return lis(addr).productions.find((p) => p.id === id) || null; }
  /** Crée ou remplace une production déjà validée (ses scènes sont gardées). */
  function pose(addr, prod, id) {
    const d = lis(addr);
    const avant = id ? d.productions.find((p) => p.id === id) : null;
    if (id && !avant) return { ok: false, code: 404, raison: 'unknown production' };
    if (!avant && d.productions.length >= PRODUCTIONS_MAX) return { ok: false, code: 400, raison: 'at most ' + PRODUCTIONS_MAX + ' productions — delete one first' };
    const p = Object.assign({}, prod, { id: avant ? avant.id : crypto.randomBytes(8).toString('hex'), cree: avant ? avant.cree : temps(), maj: temps(), scenes: avant ? avant.scenes : [] });
    d.productions = [p].concat(d.productions.filter((x) => x.id !== p.id));
    ecris(addr, d);
    if (avant) oublieImages(addr, images(avant));
    return { ok: true, production: p };
  }
  function supprime(addr, id) {
    const d = lis(addr);
    const partie = d.productions.find((p) => p.id === id);
    if (!partie) return { ok: false, code: 404, raison: 'unknown production' };
    d.productions = d.productions.filter((p) => p.id !== id);
    ecris(addr, d);
    oublieImages(addr, images(partie));
    return { ok: true };
  }

  /* ---- les images ---- */
  const dossierImages = () => path.join(dossier, 'images');
  /** Range une image (data URL deja validee) ; rend son adresse chez nous, et la note a l'adresse. */
  function rangeImage(addr, dataUrl) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    fs.mkdirSync(dossierImages(), { recursive: true });
    const nom = crypto.randomBytes(24).toString('hex') + '.' + EXT[m[1]];
    fs.writeFileSync(path.join(dossierImages(), nom), Buffer.from(m[2], 'base64'));
    const d = lis(addr);
    d.images = (d.images || []).concat(IMAGE_PREFIXE + nom);
    ecris(addr, d);
    return IMAGE_PREFIXE + nom;
  }
  /** Une image deja rangee n'est reprise que par l'adresse qui l'a rangee. */
  const aMoi = (addr, u) => (lis(addr).images || []).includes(u);
  function litImage(nom) {
    if (!IMAGE_NOM.test(String(nom || ''))) return null;
    try { return { octets: fs.readFileSync(path.join(dossierImages(), nom)), type: TYPE[nom.split('.').pop()] }; }
    catch (e) { return null; }
  }
  /** Efface les images qu'aucune production de l'adresse ne designe plus. */
  function oublieImages(addr, candidates) {
    const d = lis(addr);
    const gardees = new Set(d.productions.flatMap(images));
    const parties = candidates.filter((u) => typeof u === 'string' && u.startsWith(IMAGE_PREFIXE) && !gardees.has(u));
    if (!parties.length) return 0;
    for (const u of parties) { try { fs.unlinkSync(path.join(dossierImages(), u.slice(IMAGE_PREFIXE.length))); } catch (e) { /* deja partie */ } }
    d.images = (d.images || []).filter((u) => !parties.includes(u));
    ecris(addr, d);
    return parties.length;
  }
  /** Ajoute (ou met à jour) une scène : { id, texte, job, statut, url, facture }. */
  function noteScene(addr, id, sc) {
    const d = lis(addr);
    const p = d.productions.find((x) => x.id === id);
    if (!p) return null;
    const i = p.scenes.findIndex((x) => x.id === sc.id);
    if (i >= 0) p.scenes[i] = Object.assign({}, p.scenes[i], sc); else { if (p.scenes.length >= SCENES_MAX) return null; p.scenes.push(sc); }
    p.maj = temps();
    ecris(addr, d);
    return p;
  }
  /**
   * L'outil `image` de `valide` pour cette adresse : une nouvelle image (data URL
   * valable) est rangee, une deja rangee n'est reprise que si elle est a elle,
   * « swoge » est l'image officielle. `imageOk(dataUrl)` dit si le data URL est
   * une image acceptable (studio_media).
   */
  const outilImage = (addr, imageOk) => (x) => {
    const s = String(x);
    if (s === SWOGE) return SWOGE;
    if (s.startsWith(IMAGE_PREFIXE)) return aMoi(addr, s) ? s : null;
    return imageOk(s) ? rangeImage(addr, s) : null;
  };

  /** Les images rangees qu'aucune production ne designe (une validation ratee en chemin). */
  const menage = (addr) => oublieImages(addr, lis(addr).images || []);

  return { liste, une, pose, supprime, noteScene, rangeImage, litImage, oublieImages, outilImage, menage };
}

module.exports = { valide, scene, cree, images, MODES, PERSONNAGES_MAX, SCENES_MAX, PRODUCTIONS_MAX, IMAGE_PREFIXE, IMAGE_NOM, SWOGE, CAMERAS };
