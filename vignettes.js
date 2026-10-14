'use strict';
/* ==================================================================
 * VIGNETTES ANIMEES DU STUDIO — CLIPS xAI LITE, PROPRIETAIRE SEULEMENT
 * ==================================================================
 *
 * Demande du proprietaire (14/10/2026) : « anime les images en video, ca fera
 * beaucoup plus propre » — les cartes de modeles de studio.html. Option
 * retenue par lui : la LITE, environ 1 $ en tout sur son compte xAI :
 * grok-imagine-video-1.5-lite, 480p, 2 a 3 s par carte, un clip par image.
 *
 * Module A PART de planches.js (et non une option de plus dans planches) :
 * planches valide une liste fermee propre aux sprites (monstre, action, mode,
 * dir, couleur cle, pose PNG, finition et controles de planche) ; plier ces
 * regles pour des vignettes aurait elargi la liste fermee d'un module qui
 * paie 7,50 $. Ici, un autre plafond, un autre journal, un autre ARRET ; les
 * PRIX, l'image d'entree, la marge et le nettoyage des erreurs viennent de
 * planches.js (une seule table de prix).
 *
 * Les memes regles d'argent que planches.js (relire son en-tete) :
 *   - aucune donnee de la requete : la liste est lue dans
 *     SITE_URL/img/site/studio/vignettes.json (publie avec le site), champ par
 *     champ dans une liste fermee ; l'image (un JPEG cadre 16:9 par
 *     outils/vignettes/entrees.js) est telechargee du meme site et son sha256
 *     doit correspondre ; modele, resolution et consigne sont des CONSTANTES
 *     d'ici, jamais lues dans le fichier ;
 *   - PLAFOND DUR (VIGNETTES_PLAFOND_USD, 1,25 $ par defaut et au plus ; la
 *     variable ne peut que le BAISSER), separe des 7,50 $ des planches, verifie
 *     sur le pire cas du lot puis AVANT chaque appel ; un lot a la fois, verrou
 *     pose avant la premiere attente ;
 *   - ligne « envoi » (reserve) ecrite et fsync AVANT l'appel, sinon pas
 *     d'appel ; « sent » (request_id) ; cout REEL (cost_in_usd_ticks / 1e10) ;
 *   - pas de reponse, 5xx, pas de request_id : « inconnu », reserve comptee,
 *     ARRET ; seul un 4xx recu vaut 0 $ ; un cout au-dela de sa reserve : ARRET ;
 *   - clips telecharges depuis x.ai seulement (telecharge_sur.js), servis au
 *     SEUL proprietaire qui a lance le lot.
 *
 * La finition (boucle aller-retour, H.264 + VP9 muets, outils/vignettes/finis.js)
 * suit chaque clip arrive, dans ffmpeg (un processus a part, Dockerfile) ;
 * si elle echoue, le clip brut reste telechargeable et se finit a la main.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AlerteSolde = require('./alerte_solde');
const { telechargeSur } = require('./telecharge_sur');
const { PRIX, IMAGE_USD, MARGE, erreurPropre } = require('./planches');
const { finis } = require('./outils/vignettes/finis');

const MODELE = 'grok-imagine-video-1.5-lite';                  /* choix du proprietaire, 14/10/2026 */
const RESOLUTION = '480p';                                    /* lite 480p : 0,02 $/s (fiche du modele relue le 13/10/2026) */
const FORMATS = ['16:9', '9:16', '1:1'];                      /* VideoAspectRatio de la spec xAI (26/09, studio_media.js FORMATS_VIDEO) */
const PLAFOND_MAX = 1.25;                                     /* « environ 1 $ » accorde ; VIGNETTES_PLAFOND_USD ne peut que baisser */
const DUREE_MAX = 4;
const PAR_LOT = 20;
/* La consigne, en anglais (ce qu'xAI lit), ecrite par nous, la meme pour toutes les
   cartes : un mouvement d'ambiance, sans rien ajouter ni recadrer. L'image est la
   premiere image du clip ; la fin n'est pas epinglee (lite) : la boucle se fait en
   aller-retour a la finition, d'ou « slow and small » (un grand geste aller-retour
   se verrait). */
const CONSIGNE = 'Subtle ambient loop of this exact picture. The camera does not move: no zoom, no pan, no cut. '
  + 'Only slow, small motion: characters breathe gently and blink, hair, fur and fabric sway a little, lights shimmer and glow softly. '
  + 'Keep the framing, the composition, every object and every color exactly as they are. No new objects, no new characters, no text, no captions, no logos.';
const CARTE = /^[a-z0-9]{1,16}(?::[a-z0-9]{1,16})?$|^[a-z0-9-]{1,32}$/;
const IMAGE = /^studio\/vignettes\/[a-z0-9-]{1,32}\.jpg$/;
const SOURCE = /^(?:[a-z0-9_-]{1,32}\/)?[a-z0-9_-]{1,48}\.webp$/;
const POS = /^\d{1,3}% \d{1,3}%$/;
const LOT = /^[a-z0-9_-]{1,40}$/;
const ID = /^[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;
const IMAGE_MAX = 2 * 1024 * 1024;
const OCTETS_MAX = 80 * 1024 * 1024;
const HOTES = [/(^|\.)x\.ai$/i];

const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const arrondi = (x, n) => Math.round(x * Math.pow(10, n)) / Math.pow(10, n);
/* une image d'entree (pas de last_frame en lite) */
const reserveDe = (duree) => arrondi((PRIX[MODELE][RESOLUTION] * duree + IMAGE_USD) * MARGE, 4);
const nomFini = (carte) => String(carte).replace(/:/g, '-') + '.mp4';

/** Une entree de vignettes.json, verifiee champ par champ (liste fermee). */
function valideEntree(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'not an object';
  const permis = new Set(['carte', 'source', 'pos', 'image', 'sha256', 'format', 'duree']);
  for (const k of Object.keys(d)) if (!permis.has(k)) return 'unknown field ' + String(k).slice(0, 20);
  if (!CARTE.test(String(d.carte || ''))) return 'carte';
  if (d.source != null && !SOURCE.test(String(d.source))) return 'source';
  if (d.pos != null && !POS.test(String(d.pos))) return 'pos';
  if (!IMAGE.test(String(d.image || ''))) return 'image';
  if (!SHA.test(String(d.sha256 || ''))) return 'sha256';
  if (!FORMATS.includes(d.format)) return 'format';
  if (!Number.isInteger(d.duree) || d.duree < 1 || d.duree > DUREE_MAX) return 'duree';
  return null;
}

function cree({ dossier, fournisseur, journal, site, maintenant, pollMs, maxMs, plafondUsd, charge, telecharge, hoteOk, finition }) {
  const temps = () => (maintenant ? maintenant() : Date.now());
  const POLL = pollMs != null ? Math.max(1, Number(pollMs)) : Math.max(200, Number(process.env.STUDIO_VIDEO_POLL_MS || 5000));
  const MAX = maxMs != null ? Number(maxMs) : 15 * 60 * 1000;
  const PLAFOND = (() => { const x = Number(plafondUsd != null ? plafondUsd : process.env.VIGNETTES_PLAFOND_USD || PLAFOND_MAX); return Number.isFinite(x) && x >= 0 ? Math.min(x, PLAFOND_MAX) : PLAFOND_MAX; })();
  const SITE = String(site || '').replace(/\/+$/, '');
  const chargeSite = charge || ((u) => fetch(u, { signal: AbortSignal.timeout(30000) }));
  const chercheVideo = telecharge || ((u, o) => fetch(u, Object.assign({}, o, { signal: AbortSignal.timeout(120000) })));
  const hote = hoteOk || ((h) => HOTES.some((re) => re.test(h)));
  const finit = finition || finis;
  const ARRET = path.join(dossier, 'ARRET');
  fs.mkdirSync(dossier, { recursive: true });

  /* le journal : `strict` = la ligne DOIT etre sur le disque (fsync) avant l'appel */
  const ecrit = (l, strict) => {
    try {
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      const fd = fs.openSync(journal, 'a');
      try { fs.writeSync(fd, JSON.stringify(l) + '\n'); if (strict) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) {
      console.error('[vignettes] journal : ' + e.message);
      if (strict) throw e;
    }
  };
  function etatClips() {
    const m = new Map();
    for (const l of jsonl(journal)) if (l.type === 'clip' && ID.test(String(l.lot || ''))) m.set(l.lot + ':' + l.idx, Object.assign({}, m.get(l.lot + ':' + l.idx) || {}, l));
    return m;
  }
  /** couts reels + reserves des appels sans fin connue */
  function depense() {
    let s = 0;
    for (const c of etatClips().values()) {
      if (c.statut === 'envoi' || c.statut === 'sent') s += Number(c.reserve) || 0;
      else s += Number.isFinite(Number(c.coutUsd)) ? Number(c.coutUsd) : (Number(c.reserve) || 0);
    }
    return arrondi(s, 4);
  }
  const arrete = () => { try { return fs.readFileSync(ARRET, 'utf8'); } catch (e) { return null; } };

  const fManif = (id) => path.join(dossier, id + '.json');
  const litManif = (id) => { try { return JSON.parse(fs.readFileSync(fManif(id), 'utf8')); } catch (e) { return null; } };
  const ecritManif = (m) => { fs.writeFileSync(fManif(m.id) + '.tmp', JSON.stringify(m)); fs.renameSync(fManif(m.id) + '.tmp', fManif(m.id)); };
  let EN_COURS = null;

  async function litSite(rel, max) {
    const r = await chargeSite(SITE + '/img/site/' + rel);
    if (!r || !r.ok) throw new Error('site ' + (r ? r.status : '?') + ' for ' + rel);
    const annonce = r.headers && typeof r.headers.get === 'function' ? Number(r.headers.get('content-length')) : NaN;
    if (Number.isFinite(annonce) && annonce > max) throw new Error(rel + ' is too large');
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > max) throw new Error(rel + ' is too large');
    return b;
  }
  async function liste() {
    const j = JSON.parse((await litSite('studio/vignettes.json', 256 * 1024)).toString('utf8'));
    if (!j || typeof j !== 'object' || !j.lots || typeof j.lots !== 'object') throw new Error('vignettes.json: no "lots"');
    return j.lots;
  }
  /** le pire cas de chaque lot publie (ce que la page montre avant « Run ») */
  async function lots() {
    try {
      const L = await liste(), out = [];
      for (const [nom, l] of Object.entries(L)) {
        if (!LOT.test(nom) || !Array.isArray(l)) continue;
        const bad = l.map(valideEntree).find(Boolean);
        out.push({ nom, clips: l.length, secondes: l.reduce((s, d) => s + (Number(d && d.duree) || 0), 0), invalide: bad || null,
                   reserveUsd: bad ? null : arrondi(l.reduce((s, d) => s + reserveDe(d.duree), 0), 4),
                   detail: bad ? [] : l.map((d) => ({ carte: d.carte, duree: d.duree, format: d.format, image: d.image })) });
      }
      return { ok: true, lots: out };
    } catch (e) { return { ok: false, raison: 'could not read vignettes.json on the site (' + String(e.message).slice(0, 80) + ')', lots: [] }; }
  }

  async function rapatrie(url) {
    const b = await telechargeSur(url, { fetch: chercheVideo, hoteOk: hote, max: OCTETS_MAX });
    if (!b.length) throw new Error('size 0');
    const nom = crypto.randomBytes(24).toString('hex') + '.mp4';
    fs.writeFileSync(path.join(dossier, nom), b);
    return nom;
  }
  const finiDans = (m) => path.join(dossier, 'lot_' + m.id);
  async function fin(m, idx, statut, v) {
    const c = m.clips[idx];
    const brut = v && v.usage ? v.usage.cost_in_usd_ticks : null;
    const ticks = brut == null ? NaN : Number(brut);
    let coutUsd = Number.isFinite(ticks) && ticks >= 0 ? arrondi(ticks / 1e10, 6) : null;
    const sansCout = coutUsd == null;
    if (sansCout) coutUsd = c.reserve;                         /* pas d'usage : la reserve */
    let fichier = null, erreur = v && v.erreur ? String(v.erreur).slice(0, 200) : null;
    if (statut === 'done') {
      try { fichier = await rapatrie(v && v.video && v.video.url); }
      catch (e) { statut = 'failed'; erreur = 'download: ' + String(e.message).slice(0, 120); }
    }
    /* le clip reste « fin » (en cours) jusqu'a sa finition : le lot ne se dit pas fini avant */
    Object.assign(c, { coutUsd, sansCout, fichier, erreur, ms: temps() - c.t });
    ecrit({ type: 'clip', lot: m.id, idx, t: temps(), statut, coutUsd, sansCout, ms: c.ms, fichier, erreur });
    if (coutUsd != null && coutUsd > c.reserve + 1e-9) {
      try { fs.writeFileSync(ARRET, 'clip ' + m.id + ':' + idx + ' cost ' + coutUsd + ' $ > reserve ' + c.reserve + ' $ at ' + new Date(temps()).toISOString() + '\n'); } catch (e) {}
    }
    if (fichier) await finitClip(m, c);
    c.statut = statut;
    ecritManif(m);
    termineSiFini(m);
  }
  /* gratuit : la boucle aller-retour du clip brut ; un echec laisse le brut. Un ffmpeg
     a la fois (16 clips qui arrivent ensemble ne prennent pas 16 coeurs au jeu). */
  let fileFinition = Promise.resolve();
  function finitClip(m, c) {
    const p = fileFinition.then(() => finitClip1(m, c));
    fileFinition = p.catch(() => {});
    return p;
  }
  async function finitClip1(m, c) {
    try {
      fs.mkdirSync(finiDans(m), { recursive: true });
      const webm = nomFini(c.carte).replace(/\.mp4$/, '.webm');
      const r = await finit({ entree: path.join(dossier, c.fichier), sortie: path.join(finiDans(m), nomFini(c.carte)), sortieWebm: path.join(finiDans(m), webm) });
      c.fini = nomFini(c.carte); c.finiOctets = r && r.octets || null; c.erreurFinition = null;
      c.finiWebm = r && r.webm ? webm : null; c.webmOctets = r && r.webm || null; c.erreurWebm = r && r.erreurWebm || null;
    } catch (e) { c.fini = null; c.finiWebm = null; c.erreurFinition = String(e.message || e).slice(0, 160); }
  }
  function termineSiFini(m) {
    if (m.clips.some((x) => ['envoi', 'sent', 'attente', 'fin'].includes(x.statut))) return;
    m.statut = 'fini'; m.fin = temps(); ecritManif(m);
    if (EN_COURS === m.id) EN_COURS = null;
  }
  async function avance(m, idx) {
    const c = m.clips[idx];
    if (c.statut !== 'sent') return;
    let v = null;
    try { v = await fournisseur.litVideo(c.rid); } catch (e) { v = null; }
    if (c.statut !== 'sent') return;
    if (v && v.status === 'done') { c.statut = 'fin'; await fin(m, idx, 'done', v); }
    else if (v && (v.status === 'failed' || v.status === 'expired')) { c.statut = 'fin'; await fin(m, idx, 'failed', v); }
    else if (temps() - c.t > MAX) { c.statut = 'fin'; await fin(m, idx, 'timeout', v); }
  }
  function suit(m, idx) {
    const tour = async () => {
      try { await avance(m, idx); } catch (e) { console.error('[vignettes] suivi : ' + (e && e.message)); }
      if (m.clips[idx].statut === 'sent') setTimeout(tour, POLL).unref();
    };
    setTimeout(tour, POLL).unref();
  }

  /* au demarrage : reprendre les clips acceptes avant un redemarrage */
  for (const f of fs.readdirSync(dossier)) {
    const mm = /^([0-9a-f]{24})\.json$/.exec(f);
    if (!mm) continue;
    const m = litManif(mm[1]);
    if (!m || m.statut === 'fini') continue;
    const etat = etatClips();
    let vivant = false;
    m.clips.forEach((c, idx) => {
      const j = etat.get(m.id + ':' + idx);
      if (j && j.rid) c.rid = j.rid;
      if (j && !['envoi', 'sent'].includes(j.statut)) { Object.assign(c, { statut: j.statut, coutUsd: j.coutUsd, fichier: j.fichier || null }); return; }
      if (c.rid && (!j || j.statut === 'sent')) { c.statut = 'sent'; vivant = true; suit(m, idx); return; }
      if (j && j.statut === 'envoi') { c.statut = 'inconnu'; c.coutUsd = c.reserve; return; }   /* cout inconnu = reserve */
      if (c.statut === 'attente' || c.statut === 'fin') c.statut = 'annule';
    });
    ecritManif(m);
    if (vivant) EN_COURS = m.id;
    else {
      /* un redemarrage pendant une finition : la refaire sur les bruts deja la (0 $) */
      (async () => { for (const c of m.clips) if (c.statut === 'done' && c.fichier && !c.fini) await finitClip(m, c); termineSiFini(m); })()
        .catch((e) => console.error('[vignettes] ' + e.message));
    }
  }

  /** Lance le lot `lot` de vignettes.json pour `addr` (l'adresse de la SESSION). */
  async function lance({ addr, lot }) {
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    if (!LOT.test(String(lot || ''))) return { ok: false, code: 400, raison: 'pick a batch name from vignettes.json' };
    const a = arrete();
    if (a) return { ok: false, code: 423, raison: 'stopped: a clip cost more than its reserve, or its cost is unknown — read the journal before paying again (' + a.trim().slice(0, 120) + ')' };
    if (EN_COURS) return { ok: false, code: 429, raison: 'one batch at a time — wait for the current one' };
    const verrou = 'reserve-' + crypto.randomBytes(6).toString('hex');
    EN_COURS = verrou;                                        /* SYNCHRONE, avant tout await */
    try { return await lanceVerrouille({ addr, lot }); }
    finally { if (EN_COURS === verrou) EN_COURS = null; }
  }

  async function lanceVerrouille({ addr, lot }) {
    if (!fournisseur || !fournisseur.actif()) return { ok: false, code: 503, raison: 'video generation is not switched on (XAI_API_KEY)' };
    let L;
    try { L = await liste(); } catch (e) { return { ok: false, code: 502, raison: 'could not read vignettes.json on the site' }; }
    const l = L[lot];
    if (!Array.isArray(l) || !l.length || l.length > PAR_LOT) return { ok: false, code: 404, raison: 'no batch "' + lot + '" (1 to ' + PAR_LOT + ' clips) in vignettes.json' };
    for (let i = 0; i < l.length; i++) { const bad = valideEntree(l[i]); if (bad) return { ok: false, code: 400, raison: 'clip ' + (i + 1) + ': bad ' + bad }; }
    if (new Set(l.map((d) => d.carte)).size !== l.length) return { ok: false, code: 400, raison: 'the same card twice in one batch' };
    /* les images, du site, verifiees au sha256 (et JPEG) avant tout appel */
    const images = {};
    for (const d of l) {
      if (!images[d.image]) {
        let b;
        try { b = await litSite(d.image, IMAGE_MAX); } catch (e) { return { ok: false, code: 502, raison: 'could not read ' + d.image + ' on the site' }; }
        if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return { ok: false, code: 400, raison: d.image + ' is not a JPEG' };
        images[d.image] = { b, sha: crypto.createHash('sha256').update(b).digest('hex') };
      }
      if (images[d.image].sha !== d.sha256) return { ok: false, code: 409, raison: 'sha256 of ' + d.image + ' does not match vignettes.json' };
    }
    const pire = arrondi(l.reduce((s, d) => s + reserveDe(d.duree), 0), 4), deja = depense();
    if (deja + pire > PLAFOND + 1e-9) {
      return { ok: false, code: 402, raison: 'this batch could cost up to ' + pire.toFixed(4) + ' $ and only ' + Math.max(0, PLAFOND - deja).toFixed(4) + ' $ are left of the ' + PLAFOND.toFixed(2) + ' $ cap', pireUsd: pire, depenseUsd: deja, plafondUsd: PLAFOND };
    }
    const m = { id: crypto.randomBytes(12).toString('hex'), t: temps(), addr, lot, statut: 'lance', pireUsd: pire,
                clips: l.map((d) => ({ carte: d.carte, image: d.image, format: d.format, duree: d.duree, modele: MODELE, resolution: RESOLUTION, reserve: reserveDe(d.duree), statut: 'attente' })) };
    EN_COURS = m.id;
    ecritManif(m);
    let lances = 0, refus = null;
    for (let idx = 0; idx < l.length; idx++) {
      const c = m.clips[idx];
      if (arrete()) { refus = 'stopped'; break; }
      if (depense() + c.reserve > PLAFOND + 1e-9) { refus = 'cap'; break; }
      c.t = temps(); c.statut = 'envoi';
      try {
        ecrit({ type: 'clip', lot: m.id, idx, t: c.t, addr, statut: 'envoi', reserve: c.reserve, carte: c.carte, modele: MODELE, duree: c.duree, resolution: RESOLUTION, format: c.format }, true);
      } catch (e) {
        c.statut = 'annule'; c.erreur = 'journal: ' + String(e.code || e.message).slice(0, 60);
        refus = 'journal'; break;
      }
      try {
        c.rid = await fournisseur.lanceVideo({ api: MODELE, prompt: CONSIGNE, duree: c.duree, resolution: RESOLUTION, format: c.format,
          image: 'data:image/jpeg;base64,' + images[c.image].b.toString('base64'), audio: false });
        if (!c.rid) throw new Error('no request_id');
        AlerteSolde.succes('xai');
      } catch (e) {
        AlerteSolde.erreur('xai', e);
        const st = Number(e && e.statut);
        if (st >= 400 && st < 500) {
          c.statut = 'refuse'; c.coutUsd = 0; c.erreur = erreurPropre(e);
          ecrit({ type: 'clip', lot: m.id, idx, t: temps(), statut: 'refuse', coutUsd: 0, erreur: c.erreur });
          refus = 'xai';
        } else {
          c.statut = 'inconnu'; c.coutUsd = c.reserve; c.sansCout = true; c.erreur = erreurPropre(e);
          ecrit({ type: 'clip', lot: m.id, idx, t: temps(), statut: 'inconnu', coutUsd: c.reserve, sansCout: true, erreur: c.erreur });
          try { fs.writeFileSync(ARRET, 'clip ' + m.id + ':' + idx + ' no answer from xAI (' + c.erreur.slice(0, 80) + ') — it may have been billed (' + c.reserve + ' $ counted); check the xAI billing, then delete this file. ' + new Date(temps()).toISOString() + '\n'); } catch (x) { /* rien */ }
          refus = 'inconnu';
        }
        break;
      }
      c.statut = 'sent'; lances++;
      ecrit({ type: 'clip', lot: m.id, idx, t: temps(), statut: 'sent', rid: String(c.rid) });
      ecritManif(m);
      suit(m, idx);
    }
    for (const c of m.clips) if (c.statut === 'attente') c.statut = 'annule';
    ecritManif(m);
    if (!lances) { m.statut = 'fini'; ecritManif(m); EN_COURS = null; }
    else termineSiFini(m);       /* les clips lances ont pu finir pendant l'appel suivant, refuse */
    const r = { ok: lances > 0, id: m.id, lances, total: l.length, pireUsd: pire };
    const fautif = m.clips.find((c) => c.statut === 'refuse' || c.statut === 'inconnu' || (c.statut === 'annule' && c.erreur));
    if (refus) r.raison = refus === 'cap' ? 'stopped before the cap' : refus === 'stopped' ? 'stopped (ARRET)'
      : refus === 'journal' ? 'the cost journal could not be written: nothing more was sent'
      : refus === 'inconnu' ? 'no answer from xAI for a clip (' + (fautif ? fautif.erreur : '?') + '): its reserve is counted as spent and everything is stopped until the xAI billing is checked'
      : 'xAI refused a clip: ' + (fautif ? fautif.erreur : '?');
    if (!lances) r.code = refus === 'cap' ? 402 : refus === 'journal' ? 500 : 502;
    return r;
  }

  function vueLot(m) {
    return { id: m.id, t: m.t, lot: m.lot, statut: m.statut, pireUsd: m.pireUsd,
             coutUsd: arrondi(m.clips.reduce((s, c) => s + (Number(c.coutUsd) || 0), 0), 4),
             clips: m.clips.map((c) => ({ carte: c.carte, duree: c.duree, format: c.format, modele: c.modele, resolution: c.resolution, statut: c.statut,
                                          coutUsd: c.coutUsd == null ? null : c.coutUsd, reserve: c.reserve, secondes: c.ms ? arrondi(c.ms / 1000, 1) : null,
                                          fichier: c.fichier || null, fini: c.fini || null, finiOctets: c.finiOctets || null,
                                          finiWebm: c.finiWebm || null, webmOctets: c.webmOctets || null,
                                          erreur: c.erreur || null, erreurFinition: c.erreurFinition || c.erreurWebm || null })) };
  }
  function lotsDe(addr) {
    const l = [];
    for (const f of fs.readdirSync(dossier)) { const mm = /^([0-9a-f]{24})\.json$/.exec(f); if (!mm) continue; const m = litManif(mm[1]); if (m && m.addr === addr) l.push(m); }
    return l.sort((a, b) => b.t - a.t).slice(0, 20);
  }
  async function vue(addr) {
    const dep = depense();
    return { plafondUsd: PLAFOND, depenseUsd: dep, resteUsd: arrondi(Math.max(0, PLAFOND - dep), 4), arret: arrete(),
             modele: MODELE, resolution: RESOLUTION, prixSeconde: PRIX[MODELE][RESOLUTION], imageUsd: IMAGE_USD, marge: MARGE,
             enCours: EN_COURS, vignettes: await lots(), lots: lotsDe(addr).map(vueLot) };
  }
  function etat(id, addr) {
    if (!ID.test(String(id || ''))) return { ok: false, code: 404, raison: 'unknown batch' };
    const m = litManif(id);
    if (!m || m.addr !== addr) return { ok: false, code: 404, raison: 'unknown batch' };
    return Object.assign({ ok: true }, vueLot(m));
  }
  /** un clip (brut ou fini) d'un lot, pour le proprietaire qui l'a lance seulement */
  function fichier(id, rel, addr) {
    if (!ID.test(String(id || ''))) return null;
    const m = litManif(id);
    if (!m || m.addr !== addr) return null;
    const r = String(rel || '');
    let f = null;
    if (/^[0-9a-f]{48}\.mp4$/.test(r) && m.clips.some((c) => c.fichier === r)) f = path.join(dossier, r);
    else if (/^[a-z0-9-]{1,40}\.(?:mp4|webm)$/.test(r) && m.clips.some((c) => c.fini === r || c.finiWebm === r)) f = path.join(finiDans(m), r);
    if (!f) return null;
    try { return { octets: fs.readFileSync(f), type: /\.webm$/.test(r) ? 'video/webm' : 'video/mp4' }; } catch (e) { return null; }
  }

  return { lance, vue, etat, fichier, depense, lots, avance, PLAFOND, enCours: () => EN_COURS };
}

module.exports = { cree, valideEntree, reserveDe, nomFini, CONSIGNE, MODELE, RESOLUTION, FORMATS, PLAFOND_MAX };
