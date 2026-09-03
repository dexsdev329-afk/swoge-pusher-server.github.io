'use strict';
/* SWOGE AI VIDEO
 *
 * Un seul service. Il recoit une video, la decoupe, envoie des grilles au
 * modele, et remonte le tout avec l'audio d'origine.
 *
 * ---- CE QUI GOUVERNE LA FORME DU SERVICE ----
 *
 * 1. Railway coupe une requete HTTP longue. Le travail ne peut donc PAS vivre
 *    dans le cycle requete/reponse : on rend un jobId tout de suite et le
 *    travail continue derriere. La page interroge l'etat.
 *
 * 2. Le disque de Railway est ephemere hors volume. Tout ce qui doit survivre
 *    a un redeploiement — l'etat du job, les grilles deja payees — vit sous
 *    /data. Une grille stylisee retrouvee sur le disque n'est jamais refaite :
 *    la refaire serait la repayer.
 *
 * 3. Un travail interrompu doit pouvoir reprendre. C'est la meme regle vue
 *    autrement : l'etat sur disque est la verite, la memoire n'est qu'un cache.
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const P = require('./pipeline.js');
const G = require('./gemini.js');

const RACINE = process.env.DATA_DIR || '/data';
const JOBS = path.join(RACINE, 'jobs');
const PORT = process.env.PORT || 3000;
const CONCURRENCE = 3;
const DUREE_MAX_S = 120;            /* v1 : deux minutes */
const GARDE_MS = 24 * 3600 * 1000;  /* on nettoie les travaux de plus de 24 h */

/* Le cout d'un appel, par resolution. Ce sont les seuls chiffres du service
   qui ne sont pas mesures : ils viennent de la grille tarifaire, et ils sont
   ecrits ICI pour qu'on sache ou les corriger le jour ou elle change. */
const COUT = { '1K': 0.134, '2K': 0.134, '4K': 0.24 };

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------- l'etat */
function dossier(id) { return path.join(JOBS, id); }
function fichierEtat(id) { return path.join(dossier(id), 'job.json'); }

async function litEtat(id) {
  try { return JSON.parse(await fsp.readFile(fichierEtat(id), 'utf8')); }
  catch (e) { return null; }
}
/* Ecriture atomique : un redeploiement au milieu d'un `writeFile` laisserait
   un JSON tronque, donc un job irrecuperable. Fichier temporaire, puis rename. */
async function ecritEtat(j) {
  const f = fichierEtat(j.id), tmp = f + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(j, null, 2));
  await fsp.rename(tmp, f);
}

/* ------------------------------------------------------------- la file */
const enCours = new Set();
const attente = [];

function pousse(id) { if (!enCours.has(id) && attente.indexOf(id) < 0) { attente.push(id); tire(); } }
function tire() {
  while (enCours.size < CONCURRENCE && attente.length) {
    const id = attente.shift();
    enCours.add(id);
    traite(id).catch(async (e) => {
      const j = await litEtat(id);
      if (j) { j.statut = 'echoue'; j.erreur = String(e.message || e); await ecritEtat(j); }
    }).finally(() => { enCours.delete(id); tire(); });
  }
}

/* ------------------------------------------------------------- le travail */
async function traite(id) {
  const j = await litEtat(id);
  if (!j || j.statut === 'fini') return;
  const d = dossier(id);
  const dFrames = path.join(d, 'frames');
  const dGrilles = path.join(d, 'grilles');
  const dStyle = path.join(d, 'stylisees');
  const dRendu = path.join(d, 'rendu');
  for (const x of [dFrames, dGrilles, dStyle, dRendu]) await fsp.mkdir(x, { recursive: true });

  j.statut = 'en cours'; j.erreur = null; await ecritEtat(j);

  /* 1 · les dimensions, lues et non supposees */
  if (!j.meta) {
    j.etape = 'lecture de la video';
    await ecritEtat(j);
    j.meta = await P.sonde(j.source);
    if (j.meta.duree > DUREE_MAX_S) {
      j.statut = 'echoue';
      j.erreur = 'Cette video dure ' + Math.round(j.meta.duree) + ' s. La version 1 s\'arrete a '
               + DUREE_MAX_S + ' s : au-dela, le nombre de grilles — et donc le cout — devient '
               + 'difficile a annoncer honnetement avant de commencer.';
      await ecritEtat(j);
      return;
    }
    await ecritEtat(j);
  }

  /* 2 · les frames */
  let frames = (await fsp.readdir(dFrames)).filter((f) => /^f_\d+\.png$/.test(f)).sort();
  if (!frames.length) {
    j.etape = 'extraction des images'; await ecritEtat(j);
    frames = await P.extraitFrames(j.source, dFrames);
  }
  j.frames = frames.length;
  j.grilles = Math.ceil(frames.length / (j.n * j.n));
  await ecritEtat(j);

  /* 3 · les grilles, une par une */
  const cote = j.resolution === '4K' ? 1024 : (j.resolution === '2K' ? 512 : 256);
  j.etape = 'stylisation';
  await ecritEtat(j);

  for (let g = 0; g < j.grilles; g++) {
    const fait = path.join(dStyle, 's_' + String(g).padStart(4, '0') + '.png');
    /* ---- LA REGLE QUI TIENT TOUT LE SERVICE ----
     * Une grille deja sur le disque a deja ete payee. On la saute, toujours,
     * y compris apres un redeploiement ou un « resume ». */
    if (fs.existsSync(fait)) { j.faites = Math.max(j.faites, g + 1); continue; }

    const lot = frames.slice(g * j.n * j.n, (g + 1) * j.n * j.n);
    const brut = path.join(dGrilles, 'g_' + String(g).padStart(4, '0') + '.png');
    if (!fs.existsSync(brut)) await P.composeGrille(lot, dFrames, brut, j.n, cote);

    let derniere = null;
    for (let essai = 0; essai < 4; essai++) {
      try {
        const buf = await G.stylise(brut, j.refs, j.n, j.style, j.resolution);
        await fsp.writeFile(fait, buf);
        j.cout = Math.round((j.cout + (COUT[j.resolution] || 0.134)) * 1000) / 1000;
        derniere = null;
        break;
      } catch (e) {
        derniere = e;
        /* Backoff exponentiel : 2 s, 4 s, 8 s. Reessayer tout de suite sur un
           service qui limite le debit, c'est se faire limiter plus longtemps. */
        if (essai < 3) await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, essai)));
      }
    }
    if (derniere) {
      j.statut = 'echoue';
      j.erreur = 'Grille ' + (g + 1) + '/' + j.grilles + ' : ' + derniere.message
               + ' — les grilles deja faites sont gardees, « Reprendre » ne refera que celles qui manquent.';
      await ecritEtat(j);
      return;
    }
    j.faites = g + 1;
    await ecritEtat(j);
  }

  /* 4 · redecoupage et remontage */
  j.etape = 'remontage'; await ecritEtat(j);
  let k = 0;
  for (let g = 0; g < j.grilles; g++) {
    const src = path.join(dStyle, 's_' + String(g).padStart(4, '0') + '.png');
    const reste = Math.min(j.n * j.n, frames.length - g * j.n * j.n);
    const cases = await P.decoupeGrille(src, dRendu, 'tmp_', j.n,
                                        j.meta.largeur, j.meta.hauteur, reste);
    for (const c of cases) {
      await fsp.rename(c, path.join(dRendu, 'r_' + String(++k).padStart(6, '0') + '.png'));
    }
  }
  const sortie = path.join(d, 'sortie.mp4');
  await P.remonte(dRendu, j.meta.fps, j.source, sortie, j.meta.audio);

  j.statut = 'fini'; j.etape = 'termine'; j.sortie = sortie;
  await ecritEtat(j);
}

/* ------------------------------------------------------------- les routes */
const televerse = multer({
  dest: path.join(RACINE, 'entrees'),
  limits: { fileSize: 512 * 1024 * 1024, files: 12 },
});

app.post('/api/jobs', televerse.fields([{ name: 'video', maxCount: 1 },
                                        { name: 'refs', maxCount: 10 }]), async (req, res) => {
  try {
    const v = ((req.files || {}).video || [])[0];
    if (!v) return res.status(400).json({ erreur: 'Aucune video recue.' });

    const n = Math.max(2, Math.min(4, parseInt(req.body.n, 10) || 4));
    const resolution = ['1K', '2K', '4K'].indexOf(req.body.resolution) >= 0 ? req.body.resolution : '2K';
    const id = crypto.randomUUID();
    const d = dossier(id);
    await fsp.mkdir(d, { recursive: true });

    const source = path.join(d, 'source' + (path.extname(v.originalname) || '.mp4'));
    await fsp.rename(v.path, source);

    const refs = [];
    for (const r of ((req.files || {}).refs || [])) {
      const dst = path.join(d, 'ref_' + refs.length + path.extname(r.originalname || '.png'));
      await fsp.rename(r.path, dst);
      refs.push({ chemin: dst, mime: r.mimetype });
    }

    const j = { id, statut: 'en attente', etape: 'en file', n, resolution,
                style: String(req.body.style || '').slice(0, 600),
                source, refs, frames: 0, grilles: 0, faites: 0, cout: 0,
                erreur: null, sortie: null, cree: Date.now() };
    await ecritEtat(j);
    pousse(id);
    res.json({ jobId: id });
  } catch (e) { res.status(500).json({ erreur: String(e.message || e) }); }
});

/* La sonde AVANT de lancer : la page doit pouvoir annoncer un nombre de
   grilles et un cout avant que le premier dollar soit engage. */
app.post('/api/estimation', televerse.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erreur: 'Aucune video recue.' });
    const m = await P.sonde(req.file.path);
    const n = Math.max(2, Math.min(4, parseInt(req.body.n, 10) || 4));
    const resolution = ['1K', '2K', '4K'].indexOf(req.body.resolution) >= 0 ? req.body.resolution : '2K';
    const frames = Math.max(1, Math.round(m.duree * m.fps));
    const grilles = Math.ceil(frames / (n * n));
    await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ...m, frames, grilles,
               cout: Math.round(grilles * (COUT[resolution] || 0.134) * 100) / 100,
               tropLongue: m.duree > DUREE_MAX_S, dureeMax: DUREE_MAX_S });
  } catch (e) { res.status(400).json({ erreur: String(e.message || e) }); }
});

app.get('/api/jobs/:id', async (req, res) => {
  const j = await litEtat(req.params.id);
  if (!j) return res.status(404).json({ erreur: 'Job inconnu.' });
  res.json({ id: j.id, statut: j.statut, etape: j.etape, frames: j.frames,
             grilles: j.grilles, faites: j.faites, cout: j.cout, erreur: j.erreur,
             n: j.n, resolution: j.resolution, pret: j.statut === 'fini' });
});

/* Les vignettes : la page montre ce qui est deja stylise, au fur et a mesure. */
app.get('/api/jobs/:id/grille/:g', async (req, res) => {
  const f = path.join(dossier(req.params.id), 'stylisees',
                      's_' + String(parseInt(req.params.g, 10)).padStart(4, '0') + '.png');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

app.get('/api/jobs/:id/result', async (req, res) => {
  const j = await litEtat(req.params.id);
  if (!j || j.statut !== 'fini' || !j.sortie || !fs.existsSync(j.sortie))
    return res.status(404).json({ erreur: 'Pas encore de resultat.' });
  res.sendFile(j.sortie);
});

app.post('/api/jobs/:id/resume', async (req, res) => {
  const j = await litEtat(req.params.id);
  if (!j) return res.status(404).json({ erreur: 'Job inconnu.' });
  j.statut = 'en attente'; j.erreur = null;
  await ecritEtat(j);
  pousse(j.id);
  res.json({ ok: true });
});

/* ---- LA PAGE ----
 * Elle s'appelle `swoge-ai-video.html` et non `index.html`, et la racine la
 * sert aussi : le domaine nu doit afficher le produit. */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'swoge-ai-video.html')));

/* ------------------------------------------------------------- l'entretien */
async function nettoie() {
  try {
    const l = await fsp.readdir(JOBS).catch(() => []);
    for (const id of l) {
      const j = await litEtat(id);
      if (j && Date.now() - (j.cree || 0) > GARDE_MS) {
        await fsp.rm(dossier(id), { recursive: true, force: true });
      }
    }
  } catch (e) { /* l'entretien ne doit jamais arreter le service */ }
}

/* Au demarrage, on remet en file ce qui n'etait pas fini : c'est ce qui rend
   un redeploiement indolore. Les grilles deja payees sont sur le disque. */
async function reprend() {
  const l = await fsp.readdir(JOBS).catch(() => []);
  for (const id of l) {
    const j = await litEtat(id);
    if (j && j.statut !== 'fini' && j.statut !== 'echoue') pousse(id);
  }
}

async function demarre() {
  await fsp.mkdir(JOBS, { recursive: true });
  await fsp.mkdir(path.join(RACINE, 'entrees'), { recursive: true });
  app.listen(PORT, () => console.log('[swoge-ai-video] ecoute sur ' + PORT
    + ' · donnees dans ' + RACINE + ' · modele ' + G.MODELE));
  await reprend();
  nettoie();
  setInterval(nettoie, 3600 * 1000).unref();
}

if (require.main === module) demarre();
module.exports = { app, traite, COUT, DUREE_MAX_S };
