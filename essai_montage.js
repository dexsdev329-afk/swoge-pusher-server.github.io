'use strict';
/* ==================================================================
 * SWOLEMIND — L'ESSAI DE MONTAGE : UN CLIP RESTYLÉ PAR xAI, UNE MESURE
 * ==================================================================
 *
 * Demande du propriétaire, 26 septembre 2026 : « rajoute une route pour faire
 * seul, on essaie » — refaire un court extrait (un anime en prise de vues
 * réelle, ou l'inverse) avec l'édition vidéo de Grok Imagine, AVANT de bâtir
 * une chaîne « refaire une vidéo ». Convention du projet : mesurer avant de
 * bâtir. Cette route n'existe donc que pour la mesure, et chaque essai fini
 * laisse une ligne au journal (qualité à l'œil, coût réel, temps d'attente).
 *
 * Ce qui est VÉRIFIÉ (spécification OpenAPI d'xAI relue le 26 septembre 2026,
 * https://api.x.ai/api-docs/openapi.json, et la page « video editing » de
 * docs.x.ai lue le même jour) :
 *   - POST /v1/videos/edits {model, prompt, video: {url}} → {request_id}, la
 *     vidéo étant « une adresse publique ou un data-URL base64 », d'extension
 *     .mp4 et de codec mp4 (H.265, H.264, AV1) ;
 *   - GET /v1/videos/{id} comme pour une génération (studio_xai.litVideo) ;
 *   - la sortie garde la durée et le format de l'entrée, 720p au plus ;
 *   - l'entrée dure 8,7 s au plus (DUREE_MAX_S).
 * Ce qui NE l'est PAS : la doc ne montre que des retouches d'attributs
 * (« donner un collier d'argent à la femme ») ; un changement de style complet
 * anime ↔ prise réelle n'est pas démontré — c'est ce qu'on mesure ici. Aucun
 * prix d'édition n'est publié : le coût est lu dans `usage.cost_in_usd_ticks`
 * de chaque essai fini (1 $ = 10 000 000 000 ticks).
 *
 * Le clip n'est gardé que le temps qu'xAI le lise : il est ÉCRIT sous un nom
 * tiré au hasard (24 octets), servi par ce nom tant que l'essai est en cours,
 * puis EFFACÉ dès que l'essai finit, échoue ou dépasse le délai (c'est peut-être
 * l'extrait protégé de quelqu'un). Au démarrage, tout clip resté d'un essai
 * interrompu est effacé.
 *
 * Le journal porte DEUX lignes par essai accepté par xAI : `statut: 'sent'`
 * (avec le request_id d'xAI) dès l'acceptation, puis la ligne finale. Un
 * redémarrage pendant l'attente (chaque déploiement Railway depuis `main`, dans
 * une fenêtre de 15 min) ne perd donc plus l'essai : il reste compté dans le
 * plafond du jour et son suivi reprend, pour que son coût réel soit mesuré.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* 8,7 s : la longueur maximale d'une vidéo d'entrée selon la page « video
   editing » de docs.x.ai, lue le 26 septembre 2026. */
const DUREE_MAX_S = 8.7;
/* 25 Mo : un clip de 8,7 s en 1080p H.264 tient largement dessous ; en base64
   dans le corps JSON il en fait ~33,4, sous le plafond de 36 Mo de la route. */
const OCTETS_MAX = 25 * 1024 * 1024;
/* Par adresse du propriétaire et par jour UTC ; seuls les essais réellement
   envoyés à xAI comptent — y compris à travers un redémarrage (leur ligne
   'sent' au journal). Le plafond de dépense est donc PAR_JOUR × 8,7 s. */
const PAR_JOUR = (() => { const x = Number(process.env.ESSAI_MONTAGE_PAR_JOUR || 5); return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 5; })();
const API = 'grok-imagine-video';   /* le modele de l'exemple de la spec pour /v1/videos/edits */
const PROMPT_MAX = 1000;
const HISTO = 20;
const NOM = /^[0-9a-f]{48}\.mp4$/;
const ID = /^[0-9a-f]{24}$/;
const VIDEO_PREFIXE = '/studio/essai-montage/video/';

/* Les deux sens prets a l'emploi (en anglais : c'est ce qu'xAI lit). Les memes
   contraintes des deux cotes : on ne mesure que le changement de style. */
const MEMES = 'Keep exactly the same shots, framing, camera motion, timing, actions and composition.';
const SENS = {
  reel: 'Restyle this video as photorealistic live action with real human actors. ' + MEMES
    + ' Each character becomes a realistic human who matches their design: same hair, clothes and colours.',
  anime: 'Restyle this video as high-quality 2D anime. ' + MEMES
    + ' Each person becomes an anime character who matches their look: same hair, clothes and colours.',
};
const SENS_LISTE = ['reel', 'anime', 'libre'];

/* ---------------------------------------------------------------- MP4
 * La longueur se lit dans l'en-tete du fichier (ISO BMFF) : la boite `mvhd`
 * dans `moov` donne une echelle de temps et une duree. On parcourt l'arbre des
 * boites proprement (taille 32 bits, 64 bits quand elle vaut 1, jusqu'a la fin
 * du parent quand elle vaut 0) sans rien supposer de leur ordre : `moov` peut
 * venir apres `mdat`. */

/** Les boites filles entre `debut` et `fin`, ou null si l'arbre est casse. */
function enfants(buf, debut, fin) {
  const l = [];
  let o = debut;
  while (o + 8 <= fin) {
    let taille = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let entete = 8;
    if (taille === 1) {
      if (o + 16 > fin) return null;
      const grande = buf.readBigUInt64BE(o + 8);
      if (grande > BigInt(fin - o)) return null;
      taille = Number(grande); entete = 16;
    } else if (taille === 0) {
      taille = fin - o;
    }
    if (taille < entete || o + taille > fin) return null;
    l.push({ type, contenu: o + entete, fin: o + taille });
    o += taille;
  }
  return l;
}

/** Une boite pleine (version + drapeaux) : sa version, ou -1 si elle est vide. */
const version = (buf, b) => (b.contenu + 4 <= b.fin ? buf[b.contenu] : -1);

/**
 * La duree d'un MP4 en secondes, ou null : pas un MP4 (premiere boite autre que
 * `ftyp`), arbre casse, pas de `mvhd`, echelle nulle, ou duree illisible.
 * mvhd v0 : creation u32, modification u32, echelle u32, duree u32 ;
 * mvhd v1 : creation u64, modification u64, echelle u32, duree u64
 * (apres les 4 octets version + drapeaux).
 * Un `mvex` dans `moov` signe un MP4 FRAGMENTE : sa `mvhd` ne couvre alors que
 * les echantillons de `moov`, pas les fragments `moof` qui suivent
 * (ISO/IEC 14496-12 ; la longueur entiere est dans `mvex/mehd`, en echelle de
 * `mvhd`). Mesure du 26 septembre 2026 : un clip ffmpeg de 12,000 s (ffprobe)
 * en `-movflags frag_keyframe` porte mvhd = 1 s (-g 25) ou 10 s (keyint par
 * defaut) et aucun `mehd` ; lu par `mvhd`, il passait le plafond de 8,7 s et
 * faussait le cout par seconde jusqu'a ~9 fois. Donc, avec `mvex` : `mehd`,
 * sinon null, quoi que dise `mvhd`. Sans `mvex`, une duree `mvhd` nulle ou
 * « inconnue » (tous les bits a 1) rend null aussi — une longueur qu'on ne lit
 * pas ne passe pas le plafond.
 */
function dureeMp4(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const haut = enfants(buf, 0, buf.length);
  if (!haut || !haut.length || haut[0].type !== 'ftyp') return null;
  const moov = haut.find((b) => b.type === 'moov');
  if (!moov) return null;
  const dans = enfants(buf, moov.contenu, moov.fin);
  if (!dans) return null;
  const mvhd = dans.find((b) => b.type === 'mvhd');
  if (!mvhd) return null;
  const c = mvhd.contenu, v = version(buf, mvhd);
  let echelle, duree, inconnue;
  if (v === 0) {
    if (c + 20 > mvhd.fin) return null;
    echelle = buf.readUInt32BE(c + 12); duree = BigInt(buf.readUInt32BE(c + 16)); inconnue = duree === 0xFFFFFFFFn;
  } else if (v === 1) {
    if (c + 32 > mvhd.fin) return null;
    echelle = buf.readUInt32BE(c + 20); duree = buf.readBigUInt64BE(c + 24); inconnue = duree === 0xFFFFFFFFFFFFFFFFn;
  } else return null;
  if (!echelle) return null;
  const mvex = dans.find((b) => b.type === 'mvex');
  if (mvex) {
    /* fragmente : la duree de `mvhd` ne compte pas, seule celle de `mehd` */
    duree = 0n;
    const sous = enfants(buf, mvex.contenu, mvex.fin);
    const mehd = sous && sous.find((b) => b.type === 'mehd');
    if (mehd) {
      const vm = version(buf, mehd), cm = mehd.contenu;
      if (vm === 0 && cm + 8 <= mehd.fin) { duree = BigInt(buf.readUInt32BE(cm + 4)); inconnue = duree === 0xFFFFFFFFn; }
      else if (vm === 1 && cm + 12 <= mehd.fin) { duree = buf.readBigUInt64BE(cm + 4); inconnue = duree === 0xFFFFFFFFFFFFFFFFn; }
    }
  }
  if (duree === 0n || inconnue) return null;
  return Number(duree) / echelle;
}

/* ---------------------------------------------------------------- l'essai */

const jour = (t) => new Date(t).toISOString().slice(0, 10);
const arrondi = (x, n) => Math.round(x * Math.pow(10, n)) / Math.pow(10, n);

/* Le message d'une erreur du fournisseur, court et sans la cle. */
function erreurPropre(e) {
  let m = String(e && e.message || e || 'unknown error');
  const cle = (process.env.XAI_API_KEY || process.env.GROK_API_KEY || '').trim();
  if (cle) m = m.split(cle).join('[key]');
  return m.replace(/xai-[A-Za-z0-9_-]{6,}/g, '[key]').replace(/[\u0000-\u001f]/g, ' ').slice(0, 200);
}

function cree({ dossier, fournisseur, urlPublique, journal, maintenant, pollMs, maxMs, parJour }) {
  const temps = () => (maintenant ? maintenant() : Date.now());
  const POLL = pollMs != null ? Math.max(1, Number(pollMs)) : Math.max(200, Number(process.env.STUDIO_VIDEO_POLL_MS || 5000));
  const MAX = maxMs != null ? Number(maxMs) : Math.max(1000, Number(process.env.ESSAI_MONTAGE_MAX_MS || 15 * 60 * 1000));
  const PLAFOND = parJour != null ? Number(parJour) : PAR_JOUR;
  const MESURE = { lances: 0, refusXai: 0, repris: 0, finis: 0, echecs: 0, delais: 0, sansCout: 0, coutUsd: 0, secondesClip: 0 };
  /* les essais EN COURS seulement ; un essai fini vit dans le journal */
  const EN_COURS = new Map();
  let brutes = [];
  try {
    brutes = fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { /* pas encore de journal */ }
  /* `lignes` : les essais FINIS, une ligne par identifiant. Une ligne 'sent'
     sans ligne finale est un essai qu'xAI a accepte (et facture) avant un
     redemarrage : il repart EN_COURS avec son request_id, pour qu'il compte
     dans le jour et que fin() journalise son cout et son statut reels. */
  const lignes = brutes.filter((l) => l.statut !== 'sent');
  const finis = new Set(lignes.map((l) => l.id));
  const aReprendre = new Map();
  for (const l of brutes) {
    if (l.statut === 'sent' && ID.test(String(l.id || '')) && l.addr && l.rid && !finis.has(l.id)) aReprendre.set(l.id, l);
  }
  /* Un clip reste d'un essai interrompu par un redemarrage : personne ne le lira plus. */
  try { for (const f of fs.readdirSync(dossier)) if (NOM.test(f)) fs.unlinkSync(path.join(dossier, f)); }
  catch (e) { /* pas encore de dossier */ }

  const efface = (job) => { if (job.nom) try { fs.unlinkSync(path.join(dossier, job.nom)); } catch (e) { /* deja parti */ } };
  const ecrit = (l) => {
    try {
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.appendFileSync(journal, JSON.stringify(l) + '\n');
    } catch (e) { console.error('[essai-montage] journal : ' + e.message); }
  };

  function compteJour(addr, t) {
    const j = jour(t);
    let n = lignes.filter((l) => l.addr === addr && jour(l.t) === j).length;
    for (const x of EN_COURS.values()) if (x.addr === addr && jour(x.t) === j) n++;
    return n;
  }

  /* Ce que la page lit d'un essai, en cours ou journalise. */
  function vueEssai(e) {
    const statut = e.statut;
    const status = statut === 'pending' ? 'pending' : statut === 'done' ? 'done' : 'failed';
    const raison = statut === 'timeout' ? 'the edit took longer than ' + (MAX >= 60000 ? Math.round(MAX / 60000) + ' min' : Math.round(MAX / 1000) + ' s') + ' — stopped waiting'
      : statut === 'failed' ? 'xAI could not edit this video' + (e.erreur ? ' (' + e.erreur + ')' : '') : null;
    return { id: e.id, t: e.t, sens: e.sens, prompt: e.prompt, dureeS: e.dureeS, octets: e.octets, status, statut,
             progress: statut === 'pending' ? (e.progress || 0) : (statut === 'done' ? 100 : null),
             coutUsd: e.coutUsd == null ? null : e.coutUsd, usdParSeconde: e.usdParSeconde == null ? null : e.usdParSeconde,
             secondes: e.secondes == null ? null : e.secondes, url: e.url || null, erreur: e.erreur || null,
             dureeSortieS: e.dureeSortieS == null ? null : e.dureeSortieS, raison };
  }

  /* Fini, rate ou trop long : le clip part TOUJOURS, puis une ligne au journal. */
  function fin(job, statut, v) {
    efface(job);
    EN_COURS.delete(job.id);
    const brut = v && v.usage ? v.usage.cost_in_usd_ticks : null;
    const ticks = brut == null ? NaN : Number(brut);
    const coutUsd = Number.isFinite(ticks) && ticks >= 0 ? ticks / 1e10 : null;
    const url = statut === 'done' && v.video && /^https:\/\//i.test(String(v.video.url || '')) ? String(v.video.url).slice(0, 2000) : null;
    let erreur = v && v.erreur ? String(v.erreur).slice(0, 200) : null;
    if (statut === 'done' && !url) { statut = 'failed'; erreur = erreur || 'xAI answered done without an https video URL'; }
    const sortie = v && v.video && Number(v.video.duration) > 0 ? Number(v.video.duration) : null;
    const l = { t: job.t, id: job.id, addr: job.addr, sens: job.sens, prompt: job.prompt.slice(0, 200), dureeS: job.dureeS,
                octets: job.octets, statut, coutUsd, usdParSeconde: coutUsd == null ? null : coutUsd / job.dureeS,
                secondes: arrondi((temps() - job.t) / 1000, 1), url, erreur, dureeSortieS: sortie };
    /* repris apres un redemarrage : son attente compte le temps d'arret du serveur */
    if (job.repris) l.repris = true;
    if (statut === 'done') MESURE.finis++; else if (statut === 'timeout') MESURE.delais++; else MESURE.echecs++;
    if (coutUsd == null) MESURE.sansCout++; else MESURE.coutUsd += coutUsd;
    MESURE.secondesClip += job.dureeS;
    lignes.push(l);
    ecrit(l);
    return l;
  }

  /** Un pas de suivi : interroge xAI, conclut si c'est fini ou trop long. */
  async function avance(job) {
    if (job.statut !== 'pending') return job;
    let v = null;
    try { v = await fournisseur.litVideo(job.rid); } catch (e) { v = null; }
    if (job.statut !== 'pending') return job;
    if (v && v.status === 'done') { job.statut = 'done'; fin(job, 'done', v); }
    else if (v && (v.status === 'failed' || v.status === 'expired')) { job.statut = 'failed'; fin(job, 'failed', v); }
    else if (temps() - job.t > MAX) { job.statut = 'timeout'; fin(job, 'timeout', v); }
    else if (v && Number.isFinite(Number(v.progress))) job.progress = Math.max(0, Math.min(99, Number(v.progress)));
    return job;
  }

  function suit(job) {
    const tour = async () => {
      await avance(job);
      if (job.statut === 'pending') setTimeout(tour, POLL).unref();
    };
    setTimeout(tour, POLL).unref();
  }

  /* Les essais envoyes avant le redemarrage : leur clip vient d'etre efface (xAI
     l'a deja lu, ou l'edition echouera) ; leur suivi reprend, meme delai MAX
     compte depuis leur envoi — un essai deja trop vieux est interroge une fois
     (son cout, s'il est fini) avant d'etre clos en « timeout ». */
  for (const l of aReprendre.values()) {
    const job = { id: l.id, t: Number(l.t) || temps(), addr: l.addr, sens: l.sens, prompt: String(l.prompt || ''),
                  dureeS: Number(l.dureeS) || 0, octets: Number(l.octets) || 0, nom: null, rid: String(l.rid),
                  statut: 'pending', progress: 0, repris: true };
    EN_COURS.set(job.id, job);
    MESURE.repris++;
    suit(job);
  }

  /**
   * Lance UN essai pour `addr` (l'adresse de la SESSION, jamais celle d'un corps).
   * Les controles dans l'ordre : adresse, taille, MP4, longueur, sens et prompt,
   * un essai a la fois, plafond du jour, fournisseur allume.
   */
  async function lance({ addr, octets, sens, prompt }) {
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    const buf = Buffer.isBuffer(octets) ? octets : Buffer.alloc(0);
    if (buf.length > OCTETS_MAX) return { ok: false, code: 413, raison: 'the clip is ' + (buf.length / 1048576).toFixed(1) + ' MB — ' + (OCTETS_MAX / 1048576) + ' MB max' };
    const d = dureeMp4(buf);
    if (d == null) return { ok: false, code: 400, raison: 'not an MP4 video (or its length could not be read)' };
    /* juste au-dessus du plafond, un chiffre de plus : « 8.701 s », pas « 8.7 s » */
    if (d > DUREE_MAX_S) return { ok: false, code: 400, raison: 'the clip is ' + (d < DUREE_MAX_S + 0.05 ? d.toFixed(3) : d.toFixed(1)) + ' s long — ' + DUREE_MAX_S + ' s max for a video edit (xAI limit)' };
    if (!SENS_LISTE.includes(sens)) return { ok: false, code: 400, raison: 'pick a direction: reel, anime or libre' };
    let texte = SENS[sens];
    if (sens === 'libre') {
      texte = String(prompt == null ? '' : prompt).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!texte || texte.length > PROMPT_MAX) return { ok: false, code: 400, raison: 'describe the restyle in 1 to ' + PROMPT_MAX + ' characters' };
    }
    for (const j of EN_COURS.values()) if (j.addr === addr) return { ok: false, code: 429, raison: 'one test at a time — wait for the current one' };
    const t = temps();
    if (compteJour(addr, t) >= PLAFOND) return { ok: false, code: 429, raison: PLAFOND + ' tests per day — come back tomorrow (UTC)' };
    if (!fournisseur || !fournisseur.actif()) return { ok: false, code: 503, raison: 'video editing is not switched on yet (Grok Imagine)' };
    const nom = crypto.randomBytes(24).toString('hex') + '.mp4';
    try { fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(path.join(dossier, nom), buf); }
    catch (e) { console.error('[essai-montage] ' + e.message); return { ok: false, code: 500, raison: 'the server could not store the clip' }; }
    /* Pose AVANT l'appel : xAI peut lire le clip pendant la requete, et un
       second envoi simultane doit deja trouver cet essai en cours. */
    const job = { id: crypto.randomBytes(12).toString('hex'), t, addr, sens, prompt: texte, dureeS: arrondi(d, 3),
                  octets: buf.length, nom, rid: null, statut: 'pending', progress: 0 };
    EN_COURS.set(job.id, job);
    try {
      job.rid = await fournisseur.editeVideo({ api: API, prompt: texte, url: urlPublique(nom) });
      if (!job.rid) throw new Error('no request_id');
    } catch (e) {
      /* refuse par xAI : rien d'envoye ne tourne, le clip part, le jour n'est pas entame */
      efface(job); EN_COURS.delete(job.id); MESURE.refusXai++;
      return { ok: false, code: 502, raison: 'xAI refused the edit: ' + erreurPropre(e) };
    }
    MESURE.lances++;
    /* Accepte par xAI, donc facture : ecrit TOUT DE SUITE, pour survivre a un
       redemarrage (plafond du jour et cout mesure). Reste une fenetre : un
       arret PENDANT la requete ci-dessus, avant que le request_id revienne. */
    ecrit({ t: job.t, id: job.id, addr: job.addr, sens: job.sens, prompt: job.prompt.slice(0, 200), dureeS: job.dureeS,
            octets: job.octets, rid: String(job.rid), statut: 'sent' });
    suit(job);
    return { ok: true, id: job.id, status: 'pending', dureeS: job.dureeS };
  }

  /** L'etat d'un essai, pour SON adresse seulement. */
  function etat(id, addr) {
    const k = String(id || '');
    if (addr && ID.test(k)) {
      const j = EN_COURS.get(k);
      if (j && j.addr === addr) return Object.assign({ ok: true }, vueEssai(j));
      for (let i = lignes.length - 1; i >= 0; i--) if (lignes[i].id === k && lignes[i].addr === addr) return Object.assign({ ok: true }, vueEssai(lignes[i]));
    }
    return { ok: false, code: 404, raison: 'unknown test' };
  }

  /** Ce que voit le proprietaire : le reste du jour, les bornes, ses essais. */
  function vue(addr) {
    const enCours = [...EN_COURS.values()].filter((j) => j.addr === addr).map(vueEssai);
    const passes = lignes.filter((l) => l.addr === addr).slice(-HISTO).reverse().map(vueEssai);
    return { reste: Math.max(0, PLAFOND - compteJour(addr, temps())), parJour: PLAFOND, dureeMaxS: DUREE_MAX_S,
             octetsMax: OCTETS_MAX, sens: SENS_LISTE.slice(), essais: enCours.concat(passes) };
  }

  /** Le clip d'un essai EN COURS, par son nom (48 hexa) : rien d'autre ne sort. */
  function fichier(nom) {
    const n = String(nom || '');
    if (!NOM.test(n)) return null;
    let enCours = false;
    for (const j of EN_COURS.values()) if (j.nom === n) enCours = true;
    if (!enCours) return null;
    try { return { octets: fs.readFileSync(path.join(dossier, n)), type: 'video/mp4' }; }
    catch (e) { return null; }
  }

  return { lance, etat, vue, fichier, avance, MESURE, EN_COURS };
}

module.exports = { dureeMp4, cree, DUREE_MAX_S, OCTETS_MAX, PAR_JOUR, SENS, SENS_LISTE, API, PROMPT_MAX, VIDEO_PREFIXE, NOM };
