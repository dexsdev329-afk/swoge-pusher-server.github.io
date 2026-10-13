'use strict';
/* ==================================================================
 * PLANCHES DE SPRITES ISO — LES CLIPS xAI, PROPRIETAIRE SEULEMENT
 * ==================================================================
 *
 * Demande du proprietaire (12/10/2026) : nos propres planches animees, vue
 * isometrique 2.5D (4 vraies directions SE/SW/NW/NE, jamais un miroir),
 * actions idle, walk, attack (+ run et jump pour la page de deplacement).
 * Methode retenue (plan du 12/10) : une pose composee par NOUS (bande 5:2,
 * 4 vues sur fond de couleur cle), un clip Grok Imagine par action dont la
 * premiere ET la derniere image sont cette pose (boucle epinglee), puis la
 * finition et les controles chiffres (outils/planches/).
 *
 * Ce module ne fait que des appels PAYES par le compte xAI du proprietaire :
 *   - AUCUN debit de $SWOGE, aucun compteurs.note ;
 *   - les demandes ne viennent PAS de la requete : elles sont lues dans
 *     SITE_URL/img/nexus/monstres/iso/poses/demandes.json (relu et publie
 *     dans le depot du site), champ par champ dans une liste fermee ; la pose
 *     est telechargee du meme endroit et son sha256 doit correspondre ;
 *     les consignes sont dans la table CONSIGNES ci-dessous, en anglais,
 *     ecrites par nous — aucun texte libre ;
 *   - PLAFOND DUR (PLANCHES_PLAFOND_USD, 7,5 $ par defaut = les 10 $ du pilote
 *     moins les 2,50 $ des poses OpenAI) verifie AVANT chaque appel : la somme
 *     des couts reels journalises + les reserves des appels en vol + la reserve
 *     de cet appel. Un lot dont le pire cas ne tient pas est refuse entier ;
 *   - une ligne « envoi » (avec sa reserve) est ecrite AVANT l'appel : un
 *     redemarrage pendant la requete laisse la reserve comptee (cout inconnu =
 *     cout plein) ; « sent » (request_id) a l'acceptation ; la ligne finale porte
 *     le cout REEL (usage.cost_in_usd_ticks / 1e10) ;
 *   - un appel qui coute plus que sa reserve ARRETE tout (fichier ARRET) :
 *     nos chiffres sont faux, on relit avant de payer encore ;
 *   - les clips sont telecharges en https depuis x.ai seulement (80 Mo au plus,
 *     derniere_image.js) et servis au SEUL proprietaire qui a lance le lot.
 *
 * Prix lus le 12/10/2026 sur docs.x.ai/developers/pricing (verifies en direct
 * par le juge du plan) : grok-imagine-video-1.5 = 0,080 $/s, 1.5-lite =
 * 0,020 $/s, sans remise en Batch. Seul 1.5 accepte last_frame.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const AlerteSolde = require('./alerte_solde');

const PRIX = { 'grok-imagine-video-1.5': 0.08, 'grok-imagine-video-1.5-lite': 0.02 };
const EPINGLE = new Set(['grok-imagine-video-1.5']);          /* last_frame accepte */
const MARGE = 1.25;                                           /* reserve = prix x duree x 1,25 */
const ACTIONS = ['idle', 'walk', 'run', 'attack', 'jump'];
const DIRS = ['se', 'sw', 'nw', 'ne'];
const CLES = { magenta: 'magenta (#FF00FF)', vert: 'pure green (#00FF00)', bleu: 'pure blue (#0000FF)' };
const NOM = /^[a-z_]{1,32}$/;
const LOT = /^[a-z0-9_-]{1,40}$/;
const ID = /^[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;
const POSE_MAX = 6 * 1024 * 1024;
const OCTETS_MAX = 80 * 1024 * 1024;                          /* derniere_image.js */
const HOTES = [/(^|\.)x\.ai$/i];
const PAR_LOT = 24;                                           /* 3 monstres x 5 actions + reprises */

/* Les consignes, en anglais (c'est ce qu'xAI lit), ecrites par nous. La pose
   est epinglee au debut et a la fin : la consigne ne decrit que le mouvement. */
const COMMUN = {
  bande: (cle) => 'Four views of the same game character stand side by side, one in each quarter of the frame, on a flat solid ' + cle
    + ' background. Fixed camera: no zoom, no pan, no cut. Each figure stays inside its own quarter, keeps its size, its ground line and the direction it faces. All four move in sync. No floor, no shadow, no text, no new objects.',
  d: (cle) => 'One game character, centered, on a flat solid ' + cle
    + ' background. Fixed camera: no zoom, no pan, no cut. The character keeps its size, its ground line and the direction it faces. No floor, no shadow, no text, no new objects.',
};
const MOUVEMENT = {
  idle: ['breathe and shift their weight a little in a calm idle loop, feet planted.', 'breathes and shifts its weight a little in a calm idle loop, feet planted.'],
  walk: ['walk in place, like on a treadmill: a clear walking cycle, legs stepping and arms swinging, feet coming back to the same spot, no forward travel.',
         'walks in place, like on a treadmill: a clear walking cycle, legs stepping and arms swinging, feet coming back to the same spot, no forward travel.'],
  run: ['run in place, like on a treadmill: a clear running cycle with knees high and arms pumping, no forward travel.',
        'runs in place, like on a treadmill: a clear running cycle with knees high and arms pumping, no forward travel.'],
  attack: ['perform one attack with their weapon: wind-up, strike, then back to the starting pose.', 'performs one attack with its weapon: wind-up, strike, then back to the starting pose.'],
  jump: ['crouch, jump straight up, land on the same spot, then stand back in the starting pose.', 'crouches, jumps straight up, lands on the same spot, then stands back in the starting pose.'],
};
function consigne(action, mode, cle) {
  return COMMUN[mode](CLES[cle || 'magenta']) + (mode === 'd' ? ' The character ' + MOUVEMENT[action][1] : ' They ' + MOUVEMENT[action][0]);
}

const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const arrondi = (x, n) => Math.round(x * Math.pow(10, n)) / Math.pow(10, n);
const reserveDe = (modele, duree) => arrondi(PRIX[modele] * duree * MARGE, 4);

/* Le message d'une erreur du fournisseur, court et sans la cle. */
function erreurPropre(e) {
  let m = String(e && e.message || e || 'unknown error');
  const cle = (process.env.XAI_API_KEY || process.env.GROK_API_KEY || '').trim();
  if (cle) m = m.split(cle).join('[key]');
  return m.replace(/xai-[A-Za-z0-9_-]{6,}/g, '[key]').replace(/[\u0000-\u001f]/g, ' ').slice(0, 200);
}

/** Une demande du fichier du site, verifiee champ par champ (liste fermee). */
function valideDemande(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'not an object';
  const permis = new Set(['monstre', 'action', 'mode', 'dir', 'modele', 'duree', 'sha256', 'cle']);
  for (const k of Object.keys(d)) if (!permis.has(k)) return 'unknown field ' + String(k).slice(0, 20);
  if (!NOM.test(String(d.monstre || ''))) return 'monstre';
  if (!ACTIONS.includes(d.action)) return 'action';
  if (!['bande', 'd'].includes(d.mode)) return 'mode';
  if (d.mode === 'd' ? !DIRS.includes(d.dir) : d.dir != null) return 'dir';
  if (!PRIX[d.modele]) return 'modele';
  if (!Number.isInteger(d.duree) || d.duree < 1 || d.duree > 4) return 'duree';
  if (!SHA.test(String(d.sha256 || ''))) return 'sha256';
  if (d.cle != null && !CLES[d.cle]) return 'cle';
  return null;
}

function cree({ dossier, fournisseur, journal, site, maintenant, pollMs, maxMs, plafondUsd, charge, telecharge, hoteOk, finition }) {
  const temps = () => (maintenant ? maintenant() : Date.now());
  const POLL = pollMs != null ? Math.max(1, Number(pollMs)) : Math.max(200, Number(process.env.STUDIO_VIDEO_POLL_MS || 5000));
  const MAX = maxMs != null ? Number(maxMs) : 15 * 60 * 1000;
  const PLAFOND = (() => { const x = Number(plafondUsd != null ? plafondUsd : process.env.PLANCHES_PLAFOND_USD || 7.5); return Number.isFinite(x) && x >= 0 ? x : 7.5; })();
  const SITE = String(site || '').replace(/\/+$/, '');
  const chargeSite = charge || ((u) => fetch(u, { signal: AbortSignal.timeout(30000) }));
  const chercheVideo = telecharge || ((u) => fetch(u, { signal: AbortSignal.timeout(120000) }));
  const hote = hoteOk || ((h) => HOTES.some((re) => re.test(h)));
  const lance1 = finition || finitionEnfant;
  const ARRET = path.join(dossier, 'ARRET');
  fs.mkdirSync(dossier, { recursive: true });

  /* ---- le journal : la seule verite sur l'argent ---- */
  const ecrit = (l) => {
    try { fs.mkdirSync(path.dirname(journal), { recursive: true }); fs.appendFileSync(journal, JSON.stringify(l) + '\n'); }
    catch (e) { console.error('[planches] journal : ' + e.message); }
  };
  /* par clip (cle = lot:idx) : la derniere ligne fait foi */
  function etatClips() {
    const m = new Map();
    for (const l of jsonl(journal)) if (l.type === 'clip' && ID.test(String(l.lot || ''))) m.set(l.lot + ':' + l.idx, Object.assign({}, m.get(l.lot + ':' + l.idx) || {}, l));
    return m;
  }
  /** Ce qui est depense ou engage : couts reels + reserves des appels sans fin connue. */
  function depense() {
    let s = 0;
    for (const c of etatClips().values()) {
      if (c.statut === 'envoi' || c.statut === 'sent') s += Number(c.reserve) || 0;
      else s += Number.isFinite(Number(c.coutUsd)) ? Number(c.coutUsd) : (Number(c.reserve) || 0);
    }
    return arrondi(s, 4);
  }
  const arrete = () => { try { return fs.readFileSync(ARRET, 'utf8'); } catch (e) { return null; } };

  /* ---- les lots : un manifeste par lot sur le volume ---- */
  const fManif = (id) => path.join(dossier, id + '.json');
  const litManif = (id) => { try { return JSON.parse(fs.readFileSync(fManif(id), 'utf8')); } catch (e) { return null; } };
  const ecritManif = (m) => { fs.writeFileSync(fManif(m.id) + '.tmp', JSON.stringify(m)); fs.renameSync(fManif(m.id) + '.tmp', fManif(m.id)); };
  let EN_COURS = null;      /* le lot qui tourne (un seul a la fois) */

  async function litSite(rel, max) {
    const r = await chargeSite(SITE + '/img/nexus/monstres/iso/poses/' + rel);
    if (!r || !r.ok) throw new Error('site ' + (r ? r.status : '?') + ' for ' + rel);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > max) throw new Error(rel + ' is over ' + Math.round(max / 1048576) + ' MB');
    return b;
  }

  async function demandes() {
    const b = await litSite('demandes.json', 256 * 1024);
    const j = JSON.parse(b.toString('utf8'));
    if (!j || typeof j !== 'object' || !j.lots || typeof j.lots !== 'object') throw new Error('demandes.json: no "lots"');
    return j.lots;
  }

  /** Le pire cas de chaque lot publie (ce que la page montre avant « Run »). */
  async function lots() {
    try {
      const L = await demandes(), out = [];
      for (const [nom, liste] of Object.entries(L)) {
        if (!LOT.test(nom) || !Array.isArray(liste)) continue;
        const bad = liste.map(valideDemande).find(Boolean);
        out.push({ nom, clips: liste.length, reserveUsd: bad ? null : arrondi(liste.reduce((s, d) => s + reserveDe(d.modele, d.duree), 0), 4),
                   secondes: liste.reduce((s, d) => s + (Number(d.duree) || 0), 0), invalide: bad || null,
                   detail: bad ? [] : liste.map((d) => ({ monstre: d.monstre, action: d.action, mode: d.mode, dir: d.dir || null, modele: d.modele, duree: d.duree })) });
      }
      return { ok: true, lots: out };
    } catch (e) { return { ok: false, raison: 'could not read demandes.json on the site (' + String(e.message).slice(0, 80) + ')', lots: [] }; }
  }

  /* ---- le suivi d'un clip accepte ---- */
  async function fin(m, idx, statut, v) {
    const c = m.clips[idx];
    const brut = v && v.usage ? v.usage.cost_in_usd_ticks : null;
    const ticks = brut == null ? NaN : Number(brut);
    let coutUsd = Number.isFinite(ticks) && ticks >= 0 ? arrondi(ticks / 1e10, 6) : null;
    const sansCout = coutUsd == null;
    /* pas d'usage : le cout retenu est la reserve (plan du 12/10) */
    if (sansCout && statut !== 'refuse') coutUsd = c.reserve;
    let fichier = null, erreur = v && v.erreur ? String(v.erreur).slice(0, 200) : null;
    if (statut === 'done') {
      try { fichier = await rapatrie(v && v.video && v.video.url); }
      catch (e) { statut = 'failed'; erreur = 'download: ' + String(e.message).slice(0, 120); }
    }
    Object.assign(c, { statut, coutUsd, sansCout, fichier, erreur, ms: temps() - c.t });
    ecrit({ type: 'clip', lot: m.id, idx, t: temps(), statut, coutUsd, sansCout, ms: c.ms, fichier, erreur });
    if (coutUsd != null && coutUsd > c.reserve + 1e-9) {
      /* nos chiffres sont faux : plus aucun appel tant qu'un humain n'a pas relu */
      try { fs.writeFileSync(ARRET, 'clip ' + m.id + ':' + idx + ' cost ' + coutUsd + ' $ > reserve ' + c.reserve + ' $ at ' + new Date(temps()).toISOString() + '\n'); } catch (e) {}
    }
    ecritManif(m);
    if (m.clips.every((x) => !['envoi', 'sent', 'attente', 'fin'].includes(x.statut))) await termine(m);
  }

  async function rapatrie(url) {
    let u;
    try { u = new URL(String(url || '')); } catch (e) { throw new Error('no video URL'); }
    if (u.protocol !== 'https:' || !hote(u.hostname)) throw new Error('refused host ' + u.hostname);
    const r = await chercheVideo(u.toString());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = Buffer.from(await r.arrayBuffer());
    if (!b.length || b.length > OCTETS_MAX) throw new Error('size ' + b.length);
    const nom = crypto.randomBytes(24).toString('hex') + '.mp4';
    fs.writeFileSync(path.join(dossier, nom), b);
    return nom;
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
      try { await avance(m, idx); } catch (e) { console.error('[planches] suivi : ' + (e && e.message)); }
      if (m.clips[idx].statut === 'sent') setTimeout(tour, POLL).unref();
    };
    setTimeout(tour, POLL).unref();
  }

  /* ---- la finition : une planche par monstre dont des clips sont arrives ---- */
  async function termine(m) {
    if (m.statut === 'fini' || m.statut === 'finition') return;
    m.statut = 'finition'; ecritManif(m);
    const parMonstre = {};
    m.clips.forEach((c) => { if (c.statut === 'done' && c.fichier) (parMonstre[c.monstre] = parMonstre[c.monstre] || []).push(c); });
    m.planches = [];
    for (const [monstre, cs] of Object.entries(parMonstre)) {
      /* la derniere prise de chaque (action, mode, dir) — une reprise remplace la precedente */
      const garde = new Map(); for (const c of cs) garde.set(c.action + ':' + c.mode + ':' + (c.dir || ''), c);
      const sortie = path.join(dossier, 'lot_' + m.id);
      try {
        const fiche = await lance1({ nom: monstre, pose: m.poses[monstre] ? path.join(dossier, m.poses[monstre]) : null, sortie,
          clips: [...garde.values()].map((c) => ({ action: c.action, mode: c.mode, dir: c.dir, fichier: path.join(dossier, c.fichier),
                                                  pose: c.mode === 'd' ? path.join(dossier, m.poses[monstre + '_' + c.dir]) : null })),
          coutUsd: arrondi(cs.reduce((s, c) => s + (Number(c.coutUsd) || 0), 0), 4) });
        m.planches.push({ monstre, verdict: fiche.qc.verdict, echecs: fiche.qc.echecs.slice(0, 40), fiche: monstre + '.json',
                          fichiers: [monstre + '.json'].concat(Object.values(fiche.actions).map((a) => a.f)) });
      } catch (e) { m.planches.push({ monstre, erreur: String(e.message || e).slice(0, 200) }); }
    }
    m.statut = 'fini'; m.fin = temps(); ecritManif(m);
    if (EN_COURS === m.id) EN_COURS = null;
  }

  /* ---- au demarrage : reprendre les clips acceptes avant un redemarrage ---- */
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
      if (j && !['envoi', 'sent'].includes(j.statut)) { Object.assign(c, { statut: j.statut, coutUsd: j.coutUsd, fichier: j.fichier }); return; }
      if (c.rid && (!j || j.statut === 'sent')) { c.statut = 'sent'; c.repris = true; vivant = true; suit(m, idx); return; }
      /* « envoi » sans reponse : le cout est inconnu, la reserve reste comptee */
      if (j && j.statut === 'envoi') { c.statut = 'inconnu'; return; }
      if (c.statut === 'attente') c.statut = 'annule';
    });
    ecritManif(m);
    if (vivant) EN_COURS = m.id; else termine(m).catch((e) => console.error('[planches] ' + e.message));
  }

  /**
   * Lance le lot `lot` de demandes.json pour `addr` (l'adresse de la SESSION).
   * Controles dans l'ordre : nom, arret, un lot a la fois, fournisseur allume,
   * demandes du site, poses (sha256), PLAFOND sur le pire cas du lot ; puis,
   * avant CHAQUE appel, le plafond encore.
   */
  async function lance({ addr, lot }) {
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    if (!LOT.test(String(lot || ''))) return { ok: false, code: 400, raison: 'pick a batch name from demandes.json' };
    const a = arrete();
    if (a) return { ok: false, code: 423, raison: 'stopped: a clip cost more than its reserve — read the journal before paying again (' + a.trim().slice(0, 120) + ')' };
    if (EN_COURS) return { ok: false, code: 429, raison: 'one batch at a time — wait for the current one' };
    if (!fournisseur || !fournisseur.actif()) return { ok: false, code: 503, raison: 'video generation is not switched on (XAI_API_KEY)' };
    let L;
    try { L = await demandes(); } catch (e) { return { ok: false, code: 502, raison: 'could not read demandes.json on the site' }; }
    const liste = L[lot];
    if (!Array.isArray(liste) || !liste.length || liste.length > PAR_LOT) return { ok: false, code: 404, raison: 'no batch "' + lot + '" (1 to ' + PAR_LOT + ' clips) in demandes.json' };
    for (let i = 0; i < liste.length; i++) { const bad = valideDemande(liste[i]); if (bad) return { ok: false, code: 400, raison: 'clip ' + (i + 1) + ': bad ' + bad }; }
    /* les poses, du site, verifiees au sha256 avant tout appel */
    const poses = {}, nomsPose = {};
    for (const d of liste) {
      const fichier = d.monstre + (d.mode === 'd' ? '_' + d.dir : '') + '.png';
      if (!poses[fichier]) {
        let b;
        try { b = await litSite(fichier, POSE_MAX); } catch (e) { return { ok: false, code: 502, raison: 'could not read the pose ' + fichier + ' on the site' }; }
        if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) return { ok: false, code: 400, raison: fichier + ' is not a PNG' };
        poses[fichier] = { b, sha: crypto.createHash('sha256').update(b).digest('hex') };
      }
      if (poses[fichier].sha !== d.sha256) return { ok: false, code: 409, raison: 'sha256 of ' + fichier + ' does not match demandes.json' };
    }
    const pire = arrondi(liste.reduce((s, d) => s + reserveDe(d.modele, d.duree), 0), 4), deja = depense();
    if (deja + pire > PLAFOND + 1e-9) {
      return { ok: false, code: 402, raison: 'this batch could cost up to ' + pire.toFixed(2) + ' $ and only ' + Math.max(0, PLAFOND - deja).toFixed(2) + ' $ are left of the ' + PLAFOND.toFixed(2) + ' $ cap', pireUsd: pire, depenseUsd: deja, plafondUsd: PLAFOND };
    }
    /* le lot existe AVANT le premier appel : un second « Run » le trouve en cours */
    const m = { id: crypto.randomBytes(12).toString('hex'), t: temps(), addr, lot, statut: 'lance', pireUsd: pire, poses: {}, clips: [] };
    EN_COURS = m.id;
    for (const [fichier, p] of Object.entries(poses)) {
      const nom = crypto.randomBytes(24).toString('hex') + '.png';
      fs.writeFileSync(path.join(dossier, nom), p.b);
      m.poses[fichier.replace(/\.png$/, '')] = nom;
    }
    m.clips = liste.map((d) => ({ monstre: d.monstre, action: d.action, mode: d.mode, dir: d.dir || null, modele: d.modele, duree: d.duree,
                                  cle: d.cle || 'magenta', reserve: reserveDe(d.modele, d.duree), statut: 'attente' }));
    ecritManif(m);
    let lances = 0, refus = null;
    for (let idx = 0; idx < liste.length; idx++) {
      const c = m.clips[idx], d = liste[idx];
      if (arrete()) { refus = 'stopped'; break; }
      /* le plafond, encore, juste avant l'appel (reserves en vol comprises) */
      if (depense() + c.reserve > PLAFOND + 1e-9) { refus = 'cap'; break; }
      const pose = poses[d.monstre + (d.mode === 'd' ? '_' + d.dir : '') + '.png'];
      const url = 'data:image/png;base64,' + pose.b.toString('base64');
      c.t = temps(); c.statut = 'envoi';
      ecrit({ type: 'clip', lot: m.id, idx, t: c.t, addr, statut: 'envoi', reserve: c.reserve, monstre: c.monstre, action: c.action, mode: c.mode, dir: c.dir, modele: c.modele, duree: c.duree });
      try {
        c.rid = await fournisseur.lanceVideo({ api: c.modele, prompt: consigne(c.action, c.mode, c.cle), duree: c.duree, resolution: '720p',
          format: c.mode === 'd' ? '1:1' : '5:2', image: url, lastFrame: EPINGLE.has(c.modele) ? url : null, audio: false });
        if (!c.rid) throw new Error('no request_id');
        AlerteSolde.succes('xai');
      } catch (e) {
        AlerteSolde.erreur('xai', e);
        /* refuse par xAI (pas de request_id, donc pas de travail facture) : 0 $, on n'envoie pas la suite */
        c.statut = 'refuse'; c.coutUsd = 0; c.erreur = erreurPropre(e);
        ecrit({ type: 'clip', lot: m.id, idx, t: temps(), statut: 'refuse', coutUsd: 0, erreur: c.erreur });
        refus = 'xai'; break;
      }
      c.statut = 'sent'; lances++;
      ecrit({ type: 'clip', lot: m.id, idx, t: temps(), statut: 'sent', rid: String(c.rid) });
      ecritManif(m);
      suit(m, idx);
    }
    for (const c of m.clips) if (c.statut === 'attente') c.statut = 'annule';
    ecritManif(m);
    if (!lances) { EN_COURS = null; m.statut = 'fini'; ecritManif(m); }
    const r = { ok: lances > 0, id: m.id, lances, total: liste.length, pireUsd: pire };
    if (refus) r.raison = refus === 'cap' ? 'stopped before the cap' : refus === 'stopped' ? 'stopped (ARRET)' : 'xAI refused a clip: ' + m.clips.find((c) => c.erreur).erreur;
    if (!lances) r.code = refus === 'cap' ? 402 : 502;
    return r;
  }

  /* ce que la page lit d'un lot */
  function vueLot(m) {
    return { id: m.id, t: m.t, lot: m.lot, statut: m.statut, pireUsd: m.pireUsd,
             coutUsd: arrondi(m.clips.reduce((s, c) => s + (Number(c.coutUsd) || 0), 0), 4),
             clips: m.clips.map((c) => ({ monstre: c.monstre, action: c.action, mode: c.mode, dir: c.dir, modele: c.modele, duree: c.duree,
                                          statut: c.statut, coutUsd: c.coutUsd == null ? null : c.coutUsd, reserve: c.reserve, secondes: c.ms ? arrondi(c.ms / 1000, 1) : null,
                                          fichier: c.fichier || null, erreur: c.erreur || null })),
             planches: m.planches || [] };
  }
  function lotsDe(addr) {
    const l = [];
    for (const f of fs.readdirSync(dossier)) { const mm = /^([0-9a-f]{24})\.json$/.exec(f); if (!mm) continue; const m = litManif(mm[1]); if (m && m.addr === addr) l.push(m); }
    return l.sort((a, b) => b.t - a.t).slice(0, 20);
  }

  async function vue(addr) {
    const dep = depense();
    return { plafondUsd: PLAFOND, depenseUsd: dep, resteUsd: arrondi(Math.max(0, PLAFOND - dep), 4), arret: arrete(), prix: PRIX, marge: MARGE,
             enCours: EN_COURS, demandes: await lots(), lots: lotsDe(addr).map(vueLot) };
  }

  function etat(id, addr) {
    if (!ID.test(String(id || ''))) return { ok: false, code: 404, raison: 'unknown batch' };
    const m = litManif(id);
    if (!m || m.addr !== addr) return { ok: false, code: 404, raison: 'unknown batch' };
    return Object.assign({ ok: true }, vueLot(m));
  }

  /** Un fichier d'un lot (clip, planche, fiche), pour le proprietaire qui l'a lance seulement. */
  function fichier(id, rel, addr) {
    if (!ID.test(String(id || ''))) return null;
    const m = litManif(id);
    if (!m || m.addr !== addr) return null;
    const r = String(rel || '');
    let f = null;
    if (/^[0-9a-f]{48}\.mp4$/.test(r) && m.clips.some((c) => c.fichier === r)) f = path.join(dossier, r);
    else if ((m.planches || []).some((p) => (p.fichiers || []).includes(r)) && /^(?:[a-z_0-9]{1,32}\/)?[a-z_0-9]{1,32}\.(?:webp|png|json)$/.test(r)) f = path.join(dossier, 'lot_' + m.id, r);
    if (!f) return null;
    const type = /\.mp4$/.test(r) ? 'video/mp4' : /\.webp$/.test(r) ? 'image/webp' : /\.png$/.test(r) ? 'image/png' : 'application/json';
    try { return { octets: fs.readFileSync(f), type }; } catch (e) { return null; }
  }

  return { lance, vue, etat, fichier, depense, lots, avance, PLAFOND, enCours: () => EN_COURS };
}

/* La finition dans un processus a part : le calcul d'image ne bloque jamais la
   boucle du serveur de jeu (10 etats par seconde). 10 min au plus. */
function finitionEnfant({ nom, pose, sortie, clips, coutUsd }) {
  const args = [path.join(__dirname, 'outils', 'planches', 'finis.js'), '--nom', nom, '--sortie', sortie];
  if (pose) args.push('--pose', pose);   /* un lot tout en mode d n'a que les poses par direction */
  for (const c of clips) args.push('--clip', c.action + (c.mode === 'd' ? ':d:' + c.dir : '') + '=' + c.fichier + (c.pose ? ':' + c.pose : ''));
  if (coutUsd != null) args.push('--cout', String(coutUsd));
  return new Promise((res, rej) => execFile(process.execPath, args, { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
    const l = String(out || '').trim().split('\n').pop();
    try { return res(JSON.parse(l)); } catch (x) { return rej(new Error('finishing failed' + (e ? ': ' + String(e.message).slice(0, 120) : ''))); }
  }));
}

module.exports = { cree, valideDemande, consigne, reserveDe, PRIX, EPINGLE, MARGE, ACTIONS, DIRS, CONSIGNES: { COMMUN, MOUVEMENT }, finitionEnfant, erreurPropre };
