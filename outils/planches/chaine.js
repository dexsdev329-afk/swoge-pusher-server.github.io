'use strict';
/* ==========================================================================
 * PLANCHES — LA CHAINE : CLIPS -> PLANCHES ISO + FICHE JSON
 *
 *   pose (la bande que NOUS avons composee, fond cle)    clips (une action chacun)
 *        |  reperes par direction : pieds, torse, hauteur      |
 *        +---------------- une transformation par direction ---+
 *                          (echelle + ancre, calculee sur la POSE, appliquee a
 *                           toutes les actions : un clip qui grossit, glisse ou
 *                           change de taille d'une direction a l'autre n'est
 *                           PAS corrige — il est mesure et refuse)
 *   -> detourage cle -> case C x C (pieds a sol x C, torse au centre, corps = corps x C)
 *   -> choix des n images (choix.js) -> controles (controles.js)
 *   -> <sortie>/<nom>/<action>.webp : n colonnes x D lignes (une par direction)
 *   -> <sortie>/<nom>.json : la fiche que lisent le jeu et sprite_lab.html
 *
 * Pourquoi un fichier par action : une planche unique de 5 actions x 4
 * directions en cases de 256 ferait 2048 x 5120, soit 42 Mo decodes par
 * monstre sur telephone ; le jeu ne charge jamais jump (plan du 12/10/2026).
 * C'est deja la convention des joueurs (nexus.js:6835, un fichier par action).
 *
 * Corps a 0,50 de la case et sol a 0,88 : mesure du 12/10/2026 sur le
 * mannequin (toutes les images des 5 actions, 4 directions) — le haut du saut
 * monte a 1,60 hauteur de corps au-dessus des pieds, la pointe de l'arme
 * s'ecarte de 0,75 ; a 0,55 (le plan) le saut touchait le haut de la case.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./media');
const T = require('./traite');
const { choisis } = require('./choix');
const Q = require('./controles');

const DEFAUT = { C: 256, n: 8, corps: 0.5, sol: 0.88, dirs: ['se', 'sw', 'nw', 'ne'] };
/* Taille a l'ecran : dans les planches 4x4 actuelles, la figure (arme comprise)
   occupe 0,881 de la case en mediane — mesure du 12/10/2026 sur les 34 especes,
   16 cases chacune (min 0,516, max 0,969 ; pirate, piratesse 0,898, lieutenant,
   skeleton 0,883, rodeur 0,891). Pour garder la meme hauteur dans le jeu, la case
   iso se dessine k = 0,88 / corps fois plus grande que T (tailleDe). A juger a
   l'oeil sur sprite_lab.html (curseur de taille). */
const CORPS_ACTUEL = 0.88;
const ORDRE = ['idle', 'walk', 'run', 'attack', 'jump'];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const opaque = (img) => { for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 250) return false; return true; };

/** Les reperes de chaque direction sur une image de pose (bande de D emplacements, ou une seule figure). */
async function reperesPose(fichier, dirs, cle) {
  const img = await M.lisImage(fichier);
  const d = opaque(img) ? T.detoure(img.data, img.w, img.h, cle) : img.data;
  const lw = img.w / dirs.length, R = {};
  dirs.forEach((dir, i) => {
    const x0 = Math.round(i * lw), w = Math.round((i + 1) * lw) - x0, sub = new Uint8ClampedArray(w * img.h * 4);
    for (let y = 0; y < img.h; y++) sub.set(d.subarray((y * img.w + x0) * 4, (y * img.w + x0 + w) * 4), y * w * 4);
    const r = T.reperes(sub, w, img.h);
    if (!r) throw new Error('pose : aucune figure dans l emplacement ' + dir);
    R[dir] = Object.assign(r, { slot: x0, w, img: sub });   /* tx, pieds : dans le repere de l'emplacement */
  });
  return { w: img.w, h: img.h, R };
}

/**
 * finis({ nom, pose, clips:[{action, fichier, mode:'bande'|'d', dir?, pose?}], sortie, cle?, C?, n?, corps?, sol?, dirs? })
 * Rend la fiche (et l'ecrit). Les clips 'd' portent leur propre pose (une figure).
 */
async function finis(o) {
  const p = Object.assign({}, DEFAUT, o);
  const { C, n, corps, sol, dirs } = p;
  const cle = T.CLES[p.cle || 'magenta'] || p.cle;
  const t0 = Date.now();
  const bande = p.pose ? await reperesPose(p.pose, dirs, cle) : null;
  /* l'ancienne planche 4x4 du meme monstre : la reference du halo (controles.js) */
  let haloRef = null;
  if (p.ancienne) {
    try {
      const a = await M.lisImage(p.ancienne), c4 = Math.floor(a.w / 4), v = [];
      for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) {
        const d = new Uint8ClampedArray(c4 * c4 * 4);
        for (let y = 0; y < c4; y++) d.set(a.data.subarray(((r * c4 + y) * a.w + col * c4) * 4, ((r * c4 + y) * a.w + col * c4 + c4) * 4), y * c4 * 4);
        v.push(Q.halo(d, c4));
      }
      haloRef = v.reduce((x, y) => x + y, 0) / v.length;
    } catch (e) { haloRef = null; }
  }
  const L = {}, controles = [], sources = [], clipsLus = [];
  let pasWalk = null, pasRun = null;
  const poseCase = {};    /* la pose de chaque direction, dans la case : reference de couleur */

  for (const c of p.clips) {
    const s = await M.sonde(c.fichier);
    const parDir = c.mode === 'd' ? [c.dir] : dirs;
    const ref = c.mode === 'd' ? await reperesPose(c.pose, [c.dir], cle) : bande;
    if (!ref) throw new Error('pose manquante pour ' + c.action);
    /* la video garde-t-elle le format de la pose ? (une bande letterboxee fausserait tout) */
    const ecartFormat = Math.abs((s.w / s.h) / (ref.w / ref.h) - 1);
    controles.push({ id: 'format', action: c.action, valeur: Math.round(ecartFormat * 1000) / 1000, seuil: 0.02, sens: '<=', n: 1, ok: ecartFormat <= 0.02 });
    const sv = s.w / ref.w;
    sources.push({ action: c.action, mode: c.mode || 'bande', dir: c.dir || null, sha256: sha(c.fichier), w: s.w, h: s.h, fps: Math.round(s.fps * 1000) / 1000, images: s.n, dureeS: Math.round(s.n / s.fps * 100) / 100 });
    parDir.forEach((dir, i) => {
      const r = ref.R[dir];
      if (!poseCase[dir] && c.mode !== 'd') {
        const pc = T.place(r.img, r.w, ref.h, corps * C / r.h, r.tx, r.pied, C, sol);
        poseCase[dir] = pc.data;
      }
      clipsLus.push({ c, dir, i, r, sv, s, nDirs: parDir.length });
    });
  }

  for (const { c, dir, i, r, sv, s, nDirs } of clipsLus) {
    const lw = s.w / nDirs, x0 = Math.round(i * lw), w = Math.round((i + 1) * lw) - x0;
    const V = await M.images(c.fichier, { x: x0, y: 0, w, h: s.h });
    const k = corps * C / (r.h * sv), ax = r.tx * sv, ay = r.pied * sv;
    const F = [], Fh = [], coupesF = [], sortieF = [];
    for (const f of V.frames) {
      const d = T.detoure(f, V.w, V.h, cle);
      /* la figure touche-t-elle le bord gauche, droit ou haut de son emplacement ? (elle en sort) */
      let touche = false;
      for (let y = 0; y < V.h && !touche; y++) touche = d[(y * V.w) * 4 + 3] > T.ALPHA || d[(y * V.w + V.w - 1) * 4 + 3] > T.ALPHA;
      for (let x = 0; x < V.w && !touche; x++) touche = d[x * 4 + 3] > T.ALPHA;
      const pl = T.place(d, V.w, V.h, k, ax, ay, C, sol);
      F.push(pl.data); Fh.push(T.moitie(pl.data, C, C));
      coupesF.push(pl.coupes); sortieF.push(touche ? 1 : 0);
    }
    const info = choisis(c.action, F, Fh, C, V.fps, dir, n);
    const G = info.idx.map((j) => F[j]);
    /* ce qui compte : les images GARDEES (une figure qui deborde ailleurs dans le clip n'entre pas dans la planche) */
    const coupes = info.idx.reduce((a, j) => a + coupesF[j], 0), sortie = info.idx.reduce((a, j) => a + sortieF[j], 0);
    const res = Q.ligne(c.action, dir, G, C, info, poseCase[dir] || null, coupes, sortie, sol, F[0], haloRef);
    controles.push(...res.controles);
    L[c.action] = L[c.action] || {};
    L[c.action][dir] = { F: G, Fh, Fg: info.idx.map((j) => Fh[j]), mesures: res.mesures, info };
    if (c.action === 'walk' && info.pasCase) (pasWalk = pasWalk || []).push(info.pasCase);
    if (c.action === 'run' && info.pasCase) (pasRun = pasRun || []).push(info.pasCase);
  }
  controles.push(...Q.planche(L, C, dirs));

  /* les planches : une par action, n colonnes x D lignes, dans l'ordre de `dirs` */
  const actions = {};
  const dossier = path.join(p.sortie, p.nom);
  fs.mkdirSync(dossier, { recursive: true });
  const webp = await M.webpDispo();
  for (const action of ORDRE.concat(Object.keys(L).filter((a) => !ORDRE.includes(a)))) {
    if (!L[action]) continue;
    if (dirs.some((d) => !L[action][d])) continue;      /* une action n'existe que complete */
    const img = M.image(n * C, dirs.length * C);
    dirs.forEach((dir, r) => L[action][dir].F.forEach((d, col) => {
      for (let y = 0; y < C; y++) img.data.set(d.subarray(y * C * 4, (y + 1) * C * 4), ((r * C + y) * n * C + col * C) * 4);
    }));
    let f = webp ? await M.ecrisWebp(img, path.join(dossier, action + '.webp'), 90) : null;
    if (!f) f = M.ecrisPng(img, path.join(dossier, action + '.png'));
    const infos = dirs.map((d) => L[action][d].info);
    const moy = (k) => { const v = infos.map((x) => x[k]).filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    actions[action] = { f: p.nom + '/' + path.basename(f), ips: Math.round(moy('ips') * 10) / 10, boucle: !!infos[0].boucle };
    if (action === 'walk' || action === 'run') actions[action].pas = Math.round(moy('pasCase') * 1000) / 1000;
  }
  const echecs = controles.filter((c) => !c.ok);
  const fiche = {
    format: 'swoge-planche-iso/1', v: p.v || 1, nom: p.nom, case: C, n, dirs, sol, corps,
    k: Math.round(CORPS_ACTUEL / corps * 100) / 100,
    actions,
    qc: { verdict: echecs.length ? 'a_revoir' : 'ok', echecs: echecs.map((c) => c.id + (c.action ? ':' + c.action : '') + (c.dir ? ':' + c.dir : '')), controles },
    sources: { pose: p.pose ? sha(p.pose) : null, ancienne: p.ancienne ? path.basename(p.ancienne) : null, halo_ancienne: haloRef == null ? null : Math.round(haloRef * 1000) / 1000, clips: sources },
    cout_usd: p.coutUsd == null ? null : p.coutUsd,
    secondes: Math.round((Date.now() - t0) / 100) / 10,
  };
  fs.writeFileSync(path.join(p.sortie, p.nom + '.json'), JSON.stringify(fiche, null, 1));
  return fiche;
}

/** L'index des planches presentes (GitHub Pages ne liste pas les dossiers). */
function indexe(sortie, extra) {
  const l = [];
  for (const f of fs.readdirSync(sortie).sort()) {
    if (!/^[a-z_0-9]{1,32}\.json$/.test(f) || f === 'index.json') continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(sortie, f), 'utf8'));
      if (j.format !== 'swoge-planche-iso/1') continue;
      l.push(Object.assign({ nom: j.nom, fiche: f, actions: Object.keys(j.actions), verdict: j.qc.verdict }, (extra || {})[j.nom] || {}));
    } catch (e) { /* une fiche illisible n'entre pas dans l'index */ }
  }
  fs.writeFileSync(path.join(sortie, 'index.json'), JSON.stringify({ format: 'swoge-planches-index/1', planches: l }, null, 1));
  return l;
}

module.exports = { finis, indexe, reperesPose, DEFAUT, ORDRE, CORPS_ACTUEL };
