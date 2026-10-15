'use strict';
/* ==========================================================================
 * L'ELEMENT SWOGE CHEZ KLING (O1) — PROPRIETAIRE SEULEMENT (15 octobre 2026)
 *
 * Mesure du 15/10/2026 (clip « Chuckie », voir swoge_texte.js) : avec deux
 * refer_image (corps, visage), Kling a rendu un culturiste HUMAIN (peau nue,
 * mains humaines) avec une tete de shiba. La doc O1 offre un « element » : un
 * personnage decrit par une vue de face et 1 a 3 autres vues, cite dans le texte
 * (elements.md, video-omni.md, lus le 15/10/2026 ; les champs sont dans kling.js).
 *
 * ---- LES VUES (les « emplacements ») ----
 *   frontal  l'image de face de l'element : par defaut le meme « Swole Doge »
 *            (img/site/swoge_meme_ref.jpg, corps entier de face — choix du
 *            proprietaire le 15/10/2026), ou une image televersee ;
 *   visage   gros plan du visage : par defaut img/site/swoge_face_ref.jpg ;
 *   pied     corps entier de face, rendu 3D « video » (genere ou televerse) ;
 *   profil   vue de trois quarts (genere ou televerse).
 *   frontal → `frontal_image` ; visage, pied, profil (ceux qui sont choisis) →
 *   `refer_images` (la doc : « 1 to 3 additional reference images … that differ
 *   from the front » — un gros plan et d'autres angles).
 *
 * ---- « PREPARE SWOGE VIEWS » ----
 *   Kling Image O1 (/v1/images/omni-image, kling.js lanceImageOmni) DEPUIS LE
 *   MEME SEUL (<<<image_1>>>) : le visage de la video est plus orange, le
 *   proprietaire veut la fourrure creme-beige uniforme du meme. 0,028 $ l'image
 *   (pricing/base/image.md, « Kling Image O1 1K/2K »). Une passe = 1 image par
 *   vue demandee (2 au plus), une generation en vol par vue, IMAGES_JOUR_MAX
 *   images par jour UTC (8 = 0,224 $). 1K et non 2K (meme prix) : une image
 *   d'element doit tenir sous 10 Mo, et une 2K en PNG peut la depasser ; la
 *   video O1 sort en 720p/1080p. Les candidats ne servent a rien tant que le
 *   proprietaire ne les a pas choisis.
 *   Les resultats sont telecharges (hotes *.klingai.com seulement,
 *   telecharge_sur.js) et gardes : Kling efface les siens apres 30 jours.
 *
 * ---- L'ELEMENT ----
 *   Cree au clic, suivi par GET …/advanced-custom-elements/<task_id> jusqu'a
 *   « succeed » ; l'element_id est ECRIT dans DATA_DIR/swoge_element/etat.json
 *   (ecriture atomique) et survit au redemarrage. Recreer garde l'ancien en
 *   service jusqu'a ce que le nouveau soit pret, puis l'efface chez Kling.
 *   Effacer : POST /v1/general/delete-advanced-elements, puis plus rien n'est
 *   envoye avec l'element : les editions retombent sur les deux images.
 *   Tant qu'il n'existe pas, rien ne change : refer_image @image_1/@image_2.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const K = require('./kling');
const T = require('./swoge_texte');
const { telechargeSur } = require('./telecharge_sur');

const SLOTS = ['frontal', 'visage', 'pied', 'profil'];
const GENERES = ['pied', 'profil'];
/* les vues par defaut, sur le site */
const DEFAUTS = { frontal: T.REF_CORPS, visage: T.REF_VISAGE };
const IMAGES_JOUR_MAX = 8;
const CANDIDATS_MAX = 6;
const ID = /^[0-9a-f]{12}$/;
/* une image O1 : pas de mesure d'attente ; 15 min, le double d'une edition video courte observee */
const IMAGE_MAX_MS = 15 * 60e3;
/* un element : pas de mesure non plus ; 30 min */
const ELEMENT_MAX_MS = 30 * 60e3;
const NOM_ELEMENT = 'SWOGE';
const DESCRIPTION_ELEMENT = 'Swole Doge: 3D Shiba Inu, small Doge head, huge furry arms and chest, short legs, cream-beige fur';

const COMMUN = 'Keep its exact proportions and colours: a small Doge head on a thick tall neck, an enormous muscular upper body with huge arms, '
  + 'short thin legs, thick fluffy cream-beige fur everywhere in one uniform colour, no bare skin anywhere. '
  + 'Furry dog paws with dark pads and small dark claws on the hands and feet. Plain black gym shorts. '
  + 'The round friendly Doge face: cream-white cheeks, small dark eyes, black nose, slight smile. '
  + 'Video-realistic 3D render, soft even studio light, plain light neutral background, nothing else in the picture, no text.';
const TEXTES_VUES = {
  pied: 'A full-body front view of the exact character of <<<image_1>>>: the Swole Doge, standing upright and facing the camera, '
    + 'the WHOLE body visible from the ears to the feet, legs and feet included. ' + COMMUN,
  profil: 'A three-quarter side view of the exact character of <<<image_1>>>: the Swole Doge, standing, body turned about 45 degrees to its left, '
    + 'the WHOLE body visible from the ears to the feet, legs and feet included. ' + COMMUN,
};

const jourDe = (t) => new Date(t).toISOString().slice(0, 10);
const propre = (m) => String(m || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 240);

/**
 * deps : { dossier, kling, site (URL du site, sans / final), journal?(o), maintenant?,
 *          fetchCdn?, hoteOk?, httpPermis?, pollMs? }
 */
function cree(deps) {
  const dossier = deps.dossier;
  const kling = deps.kling;
  const site = String(deps.site || '').replace(/\/+$/, '');
  const temps = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const hoteOk = deps.hoteOk || require('./kling_entier').hotesPermis(process.env.KLING_CDN_HOTES);
  const note = (o) => { try { if (deps.journal) deps.journal(Object.assign({ swogeElement: true }, o)); } catch (e) { /* jamais bloquant */ } };
  const ETAT = path.join(dossier, 'etat.json');
  let E = null;
  let minuteur = null, tourEnCours = null;

  const neuf = () => ({ vues: [], choix: { frontal: 'site', visage: 'site', pied: null, profil: null }, element: null, aEffacer: [], jour: { jour: null, images: 0 } });
  function ecrit() {
    try {
      fs.mkdirSync(dossier, { recursive: true });
      const tmp = ETAT + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(E));
      fs.renameSync(tmp, ETAT);
    } catch (e) { console.error('[swoge-element] etat non ecrit : ' + e.message); }
  }
  function relit() {
    E = neuf();
    try { E = Object.assign(neuf(), JSON.parse(fs.readFileSync(ETAT, 'utf8'))); } catch (e) { /* premier demarrage */ }
    let change = false;
    /* une generation ou une creation coupee ENTRE l'envoi et l'ecriture de l'id : on ne sait
       pas si Kling l'a faite (elle est peut-etre facturee) — dit, jamais refaite en silence */
    for (const v of E.vues) if (v.statut === 'en_cours' && !v.tache) { v.statut = 'echec'; v.message = 'interrupted by a server restart before Kling answered — generate again'; change = true; }
    if (E.element && E.element.statut === 'creation' && !E.element.tache) {
      const msg = 'interrupted by a server restart before Kling answered — check your Kling element list, then create again';
      if (E.element.precedent) E.element = Object.assign({}, E.element.precedent, { message: 'the new element was ' + msg });
      else E.element = { statut: 'echec', message: msg, t: E.element.t };
      change = true;
    }
    if (change) ecrit();
  }

  const fic = (nom) => path.join(dossier, nom);
  const vueDe = (id) => E.vues.find((v) => v.id === id) || null;

  /** L'element en service : son id (chaine) ou null — c'est TOUT ce que les editions lisent. */
  function elementPret() {
    const el = E && E.element;
    if (!el) return null;
    if (el.statut === 'pret' && el.elementId) return String(el.elementId);
    if (el.statut === 'creation' && el.precedent && el.precedent.elementId) return String(el.precedent.elementId);
    return null;
  }

  /* ---- les vues ---- */
  function compteJour(n) {
    const j = jourDe(temps());
    if (E.jour.jour !== j) E.jour = { jour: j, images: 0 };
    if (n) E.jour.images += n;
    return E.jour.images;
  }
  function range(slot) {
    /* au plus CANDIDATS_MAX par vue : les plus vieux NON choisis partent (et leur fichier) */
    const l = E.vues.filter((v) => v.slot === slot).sort((a, b) => a.t - b.t);
    while (l.length > CANDIDATS_MAX) {
      const k = l.findIndex((v) => E.choix[slot] !== v.id && v.statut !== 'en_cours');
      if (k < 0) break;
      const [v] = l.splice(k, 1);
      if (v.fichier) try { fs.unlinkSync(fic(v.fichier)); } catch (e) { /* deja parti */ }
      E.vues = E.vues.filter((x) => x !== v);
    }
  }

  /**
   * « Prepare SWOGE views » : une image par vue demandee (pied, profil), depuis le meme.
   * Rend { ok, lancees: [vue…] } ou un refus ; rien ne part au-dela du plafond du jour.
   */
  async function prepare(q) {
    q = q || {};
    const demandees = (Array.isArray(q.vues) && q.vues.length ? q.vues : GENERES).map(String);
    if (demandees.some((s) => !GENERES.includes(s)) || new Set(demandees).size !== demandees.length) return { ok: false, code: 400, raison: 'views to prepare: ' + GENERES.join(', ') };
    if (!kling.actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    for (const s of demandees) if (E.vues.some((v) => v.slot === s && v.statut === 'en_cours' && v.source === 'kling')) return { ok: false, code: 409, raison: 'a ' + s + ' view is already being made — wait for it' };
    if (compteJour(0) + demandees.length > IMAGES_JOUR_MAX) return { ok: false, code: 429, raison: 'daily cap reached: ' + IMAGES_JOUR_MAX + ' pictures per day (UTC), ' + compteJour(0) + ' made today' };
    const lancees = [], refus = [];
    for (const slot of demandees) {
      const v = { id: crypto.randomBytes(6).toString('hex'), slot, source: 'kling', statut: 'en_cours', tache: null, t: temps(), fichier: null };
      E.vues.push(v); compteJour(1); ecrit();   /* compte AVANT l'appel : un refus de Kling ne rend pas l'image du jour */
      const r = await kling.lanceImageOmni({ prompt: TEXTES_VUES[slot], images: [site + DEFAUTS.frontal], format: '2:3', resolution: '1k' });
      if (!r || !r.ok) { v.statut = 'echec'; v.message = propre((r && r.raison) || 'Kling refused'); refus.push(v.message); ecrit(); continue; }
      v.tache = r.id; v.estimationUsd = r.estimationUsd; ecrit();
      note({ vue: slot, tache: r.id, estimationUsd: r.estimationUsd });
      lancees.push(publique(v));
      range(slot);
    }
    ecrit();
    if (!lancees.length) return { ok: false, code: 502, raison: refus[0] || 'Kling refused' };
    return { ok: true, lancees, refus };
  }

  /** Une image du proprietaire pour une vue (Buffer JPEG/PNG, bornes d'un element). */
  function televerse(slot, octets) {
    if (!SLOTS.includes(String(slot))) return { ok: false, code: 400, raison: 'unknown view (' + SLOTS.join(', ') + ')' };
    const r = K.referenceElement(octets);
    if (!r.ok) return { ok: false, code: 400, raison: r.raison };
    const v = { id: crypto.randomBytes(6).toString('hex'), slot: String(slot), source: 'upload', statut: 'pret', t: temps(),
                format: r.format, largeur: r.largeur, hauteur: r.hauteur };
    v.fichier = v.id + (r.format === 'png' ? '.png' : '.jpg');
    try { fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(fic(v.fichier), octets); }
    catch (e) { return { ok: false, code: 500, raison: 'the server could not store the picture' }; }
    E.vues.push(v); range(v.slot); ecrit();
    note({ vue: v.slot, televerse: true, format: r.format, cotes: r.largeur + 'x' + r.hauteur });
    return { ok: true, vue: publique(v) };
  }

  /** Choisit la vue d'un emplacement : un id pret, « site » (frontal, visage) ou null (aucune). */
  function choisit(slot, id) {
    if (!SLOTS.includes(String(slot))) return { ok: false, code: 400, raison: 'unknown view (' + SLOTS.join(', ') + ')' };
    if (id === 'site') { if (!DEFAUTS[slot]) return { ok: false, code: 400, raison: 'no default picture for this view' }; }
    else if (id === null || id === '') { if (slot === 'frontal') return { ok: false, code: 400, raison: 'the element needs a frontal picture' }; id = null; }
    else { const v = vueDe(String(id)); if (!v || v.slot !== slot || v.statut !== 'pret') return { ok: false, code: 400, raison: 'pick a ready picture of this view' }; }
    E.choix[slot] = id; ecrit();
    return { ok: true };
  }

  /* L'image d'un emplacement telle que Kling l'attend : URL https du site, ou base64 nu. */
  function imageDe(slot) {
    const c = E.choix[slot];
    if (!c) return null;
    if (c === 'site') return { kling: site + DEFAUTS[slot], decrit: 'site:' + DEFAUTS[slot] };
    const v = vueDe(c);
    if (!v || v.statut !== 'pret' || !v.fichier) return { erreur: slot + ': the chosen picture is gone — pick another' };
    let b;
    try { b = fs.readFileSync(fic(v.fichier)); } catch (e) { return { erreur: slot + ': the chosen picture is gone — pick another' }; }
    const r = K.referenceElement(b);
    if (!r.ok) return { erreur: slot + ': ' + r.raison };
    return { kling: r.base64, decrit: v.source + ':' + v.id };
  }

  /** Cree (ou recree) l'element depuis les vues choisies. */
  async function creeElement() {
    if (E.element && E.element.statut === 'creation') return { ok: false, code: 409, raison: 'an element is already being created — wait for it' };
    if (!kling.actif()) return { ok: false, code: 503, raison: 'Kling is not set up (KLING_API_KEY)' };
    const frontal = imageDe('frontal');
    if (!frontal) return { ok: false, code: 400, raison: 'the element needs a frontal picture' };
    if (frontal.erreur) return { ok: false, code: 400, raison: frontal.erreur };
    const autres = [];
    for (const s of ['visage', 'pied', 'profil']) {
      const im = imageDe(s);
      if (!im) continue;
      if (im.erreur) return { ok: false, code: 400, raison: im.erreur };
      autres.push(Object.assign({ slot: s }, im));
    }
    if (autres.length < K.ELEMENT_AUTRES.min) return { ok: false, code: 400, raison: 'pick at least one picture besides the frontal one (face, full body or side view)' };
    const precedent = E.element && E.element.statut === 'pret' && E.element.elementId ? E.element : (E.element && E.element.precedent) || null;
    const externe = crypto.randomBytes(12).toString('hex');
    const images = { frontal: frontal.decrit, autres: autres.map((a) => a.slot + '=' + a.decrit) };
    E.element = { statut: 'creation', tache: null, externe, t: temps(), images, precedent: precedent ? { statut: 'pret', elementId: precedent.elementId, t: precedent.t, tFin: precedent.tFin, images: precedent.images } : null };
    ecrit();   /* l'identifiant externe est sur le disque AVANT l'appel */
    const r = await kling.creeElement({ nom: NOM_ELEMENT, description: DESCRIPTION_ELEMENT, frontal: frontal.kling, autres: autres.map((a) => a.kling), externe });
    if (!r || !r.ok) {
      const m = propre((r && r.raison) || 'Kling refused');
      E.element = precedent ? Object.assign({}, E.element.precedent, { message: 'the new element was refused: ' + m }) : { statut: 'echec', message: m, t: temps(), images };
      ecrit();
      note({ element: 'refuse', message: m });
      return { ok: false, code: (r && r.code) || 502, raison: m };
    }
    E.element.tache = r.tache; ecrit();
    note({ element: 'creation', tache: r.tache, images });
    return { ok: true, element: vueElement() };
  }

  /** Efface l'element chez Kling, puis ici : les editions retombent sur les deux images. */
  async function supprime() {
    const el = E.element;
    if (!el) return { ok: true, element: null };
    if (el.statut === 'creation') return { ok: false, code: 409, raison: 'an element is being created — wait for it before deleting' };
    if (el.elementId) {
      const r = await kling.supprimeElement(el.elementId);
      if (!r || !r.ok) return { ok: false, code: (r && r.code) || 502, raison: (r && r.raison) || 'Kling refused' };
      note({ element: 'efface', elementId: el.elementId });
    }
    E.element = null; ecrit();
    return { ok: true, element: null };
  }

  /* ---- le suivi ---- */
  async function suitVue(v) {
    const e = await kling.etatImageOmni(v.tache);
    if (!e || !e.ok) { if (temps() - v.t > IMAGE_MAX_MS) { v.statut = 'echec'; v.message = 'no answer from Kling after ' + Math.round(IMAGE_MAX_MS / 60e3) + ' min'; ecrit(); } return; }
    if (e.statut === 'failed') { v.statut = 'echec'; v.message = propre('Kling failed: ' + (e.message || 'no reason given')); ecrit(); return; }
    if (e.statut !== 'succeed' || !e.url) { if (temps() - v.t > IMAGE_MAX_MS) { v.statut = 'echec'; v.message = 'no answer from Kling after ' + Math.round(IMAGE_MAX_MS / 60e3) + ' min'; ecrit(); } return; }
    let b;
    try { b = await telechargeSur(e.url, { fetch: deps.fetchCdn, hoteOk, httpPermis: !!deps.httpPermis, max: 20 * 1024 * 1024, delaiMs: 60000 }); }
    catch (x) { v.statut = 'echec'; v.message = propre('download failed: ' + x.message); ecrit(); return; }
    const r = K.referenceElement(b);
    if (!r.ok) { v.statut = 'echec'; v.message = propre('not usable for an element: ' + r.raison); ecrit(); return; }
    v.fichier = v.id + (r.format === 'png' ? '.png' : '.jpg');
    fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(fic(v.fichier), b);
    v.statut = 'pret'; v.format = r.format; v.largeur = r.largeur; v.hauteur = r.hauteur; v.tFin = temps(); ecrit();
    note({ vue: v.slot, tache: v.tache, pret: true, cotes: r.largeur + 'x' + r.hauteur, secondes: Math.round((v.tFin - v.t) / 1000) });
  }
  async function suitElement() {
    const el = E.element;
    const e = await kling.etatElement(el.tache);
    if (E.element !== el) return;
    const delai = temps() - el.t > ELEMENT_MAX_MS;
    if (e && e.ok && e.statut === 'succeed' && e.elementId) {
      const ancien = el.precedent && el.precedent.elementId && el.precedent.elementId !== e.elementId ? el.precedent.elementId : null;
      E.element = { statut: 'pret', elementId: e.elementId, tache: el.tache, externe: el.externe, t: el.t, tFin: temps(), images: el.images, deduction: e.deduction || null };
      if (ancien) E.aEffacer.push(ancien);
      ecrit();
      note({ element: 'pret', elementId: e.elementId, deduction: e.deduction || null, secondes: Math.round((temps() - el.t) / 1000) });
      return;
    }
    let echec = null;
    if (e && e.ok && e.statut === 'failed') echec = 'Kling failed: ' + (e.message || 'no reason given');
    else if (e && e.ok && e.statut === 'succeed') echec = 'Kling answered "succeed" without an element_id — nothing to use';
    else if (delai) echec = 'no answer from Kling after ' + Math.round(ELEMENT_MAX_MS / 60e3) + ' min';
    if (!echec) return;
    echec = propre(echec);
    E.element = el.precedent ? Object.assign({}, el.precedent, { message: 'the new element failed: ' + echec }) : { statut: 'echec', message: echec, t: el.t, tFin: temps(), images: el.images, deduction: (e && e.deduction) || null };
    ecrit();
    note({ element: 'echec', message: echec });
  }
  async function tour() {
    if (tourEnCours) return tourEnCours;
    tourEnCours = (async () => {
      for (const v of E.vues.filter((x) => x.statut === 'en_cours' && x.tache)) { try { await suitVue(v); } catch (x) { console.error('[swoge-element] ' + x.message); } }
      if (E.element && E.element.statut === 'creation' && E.element.tache) { try { await suitElement(); } catch (x) { console.error('[swoge-element] ' + x.message); } }
      /* l'ancien element apres une recreation reussie : efface chez Kling, une fois */
      while (E.aEffacer.length) {
        const id = E.aEffacer[0];
        const r = await kling.supprimeElement(id).catch(() => null);
        if (!r || !r.ok) { note({ element: 'ancien-non-efface', elementId: id, message: r && r.raison }); break; }
        E.aEffacer.shift(); ecrit(); note({ element: 'ancien-efface', elementId: id });
      }
    })().finally(() => { tourEnCours = null; });
    return tourEnCours;
  }
  function demarre() {
    if (minuteur) return;
    minuteur = setInterval(() => { if (E.vues.some((v) => v.statut === 'en_cours') || (E.element && E.element.statut === 'creation') || E.aEffacer.length) tour().catch(() => {}); },
      deps.pollMs != null ? Math.max(1, Number(deps.pollMs)) : 10000);
    if (minuteur.unref) minuteur.unref();
  }
  function arrete() { if (minuteur) clearInterval(minuteur); minuteur = null; }

  /* ---- ce que la page lit ---- */
  const publique = (v) => ({ id: v.id, slot: v.slot, source: v.source, statut: v.statut, message: v.message || null, t: v.t,
    largeur: v.largeur || null, hauteur: v.hauteur || null, image: v.statut === 'pret' ? '/studio/kling/swoge/image/' + v.id : null });
  function vueElement() {
    const el = E.element;
    if (!el) return null;
    return { statut: el.statut, elementId: el.elementId || null, t: el.t || null, tFin: el.tFin || null, message: el.message || null, images: el.images || null,
             deduction: el.deduction || null, enService: elementPret(), precedent: el.precedent ? el.precedent.elementId : null };
  }
  function vue() {
    compteJour(0);
    return { actif: kling.actif(), element: vueElement(), enService: elementPret(), choix: Object.assign({}, E.choix),
      defauts: Object.assign({}, DEFAUTS), vues: E.vues.map(publique), slots: SLOTS, generes: GENERES,
      prixImageUsd: K.IMAGE_PRIX_USD, imagesJour: E.jour.images, imagesJourMax: IMAGES_JOUR_MAX, jeton: '@' + K.ELEMENT_JETON,
      cibles: T.CIBLES.filter((c) => !c.cache).map((c) => ({ id: c.id, nom: c.nom, qui: c.qui })) };
  }
  /** Le fichier d'une vue prete (proprietaire seulement, par la route). */
  function image(id) {
    const v = ID.test(String(id || '')) ? vueDe(String(id)) : null;
    if (!v || v.statut !== 'pret' || !v.fichier) return null;
    try { return { octets: fs.readFileSync(fic(v.fichier)), type: v.format === 'png' ? 'image/png' : 'image/jpeg' }; }
    catch (e) { return null; }
  }

  relit();
  return { prepare, televerse, choisit, creeElement, supprime, elementPret, tour, demarre, arrete, vue, image, etat: () => E };
}

module.exports = { cree, SLOTS, GENERES, DEFAUTS, IMAGES_JOUR_MAX, CANDIDATS_MAX, TEXTES_VUES, NOM_ELEMENT, DESCRIPTION_ELEMENT };
