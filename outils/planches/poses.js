'use strict';
/* ==========================================================================
 * PLANCHES — LES POSES ISO PAR OpenAI (gpt-image-2.5-sunburst), PLAFOND DUR
 *
 * Un appel = une image 2048 x 1024, fond transparent : le monstre redessine
 * sur les 4 vues de repos de NOTRE mannequin (guide.js, toilePoses), en
 * gardant pose, taille, place et orientation de chaque vue, l'arme dans la
 * main du membre CLAIR. Deux images jointes : la toile du mannequin et
 * l'ancienne planche du monstre (convertie en PNG). Rien d'AutoSprite.
 *
 * Lu le 12/10/2026 (developers.openai.com, copies dans verif_juge/) :
 *   - POST /v1/images/edits en multipart, plusieurs `image[]` (exemple curl du
 *     guide) ; size LxH multiples de 16, rapport 1:3 a 3:1, 3840 px au plus,
 *     655 360 a 8 294 400 px ; quality low..max ; background "transparent"
 *     avec output_format png ou webp ; input_fidelity a NE PAS envoyer ;
 *   - prix gpt-image-2.5-sunburst : image en entree 8 $/M jetons, texte 5 $/M,
 *     image en sortie 30 $/M ; « Use the response's usage to measure token
 *     consumption » — le cout des images d'ENTREE n'est pas publie.
 *
 * L'argent, dans l'ordre (plan du 12/10/2026) :
 *   1. depense = couts finaux + reserves des lignes « envoye » sans ligne
 *      finale ; depense + reserve de l'appel <= 2,50 $ (PLAFOND, constante),
 *      sinon refus SANS appel ;
 *   2. une ligne « envoye » {id, reserve} est ecrite AVANT l'appel ;
 *   3. la ligne finale porte usage, coutUsd, ms ;
 *   4. usage absent : le cout retenu est la reserve, et ARRET ;
 *      cout > reserve : ARRET ; plus de 12 000 jetons par image d'entree au
 *      premier appel (calibrage) : ARRET ; un fichier ARRET bloque tout appel ;
 *   5. un journal absent alors que le dossier des poses contient des images :
 *      refus (on aurait perdu la trace de ce qui a ete paye) ;
 *   6. pas de reponse (coupure, delai de 300 s), ou une reponse 5xx : OpenAI a
 *      peut-etre genere ET facture l'image — statut « inconnu », cout = reserve,
 *      et ARRET (revue du 13/10/2026 : la coupure etait journalisee a 0 $ et
 *      l'appel suivant permis). Seul un 4xx recu vaut 0 $ (sauf usage contraire).
 * Le journal et l'ARRET de la ligne de commande sont a un chemin FIXE
 * (~/.swoge-planches/), quel que soit --dossier ou --site : un --dossier neuf
 * repartait a 0 $ depense (revue du 13/10/2026, 2,45 $ dans A, 0 dans B).
 * La cle n'est lue que de l'environnement, jamais ecrite ni affichee.
 *
 *   node outils/planches/poses.js <monstre> [--n 2] [--site /home/user/SWOGE.github.io] [--dossier _planches]
 * ======================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const G = require('./guide');
const M = require('./media');

const PLAFOND = 2.50;                 /* $ — la part OpenAI des 10 $ du pilote (plan du 12/10/2026) */
const MODELE = 'gpt-image-2.5-sunburst';
const PRIX = { imageEntree: 8e-6, texteEntree: 5e-6, imageSortie: 30e-6 };   /* $ par jeton, lus le 12/10/2026 */
/* Reserve de depart : sortie 1180 jetons x n x 1,5 (calculatrice du guide, high,
   1024² ~ 1 756 jetons ; 2048x1024 annonce comme bande, valeur du plan), entree
   2 images x 12 000 jetons (le plafond de calibrage), texte 2 000 jetons. */
const reserveDepart = (n) => Math.round((1180 * n * 1.5 * PRIX.imageSortie + 2 * 12000 * PRIX.imageEntree + 2000 * PRIX.texteEntree) * 1e4) / 1e4;
const JETONS_IMAGE_MAX = 12000;

const CONSIGNE = [
  'Redraw the creature from the second image onto each of the four grey mannequins of the first image.',
  'Keep every mannequin\'s exact pose, size, position, ground line and facing direction: these are four true views of the same character, seen from the front-right, front-left, back-left and back-right in an isometric game camera.',
  'The light grey limbs are the character\'s RIGHT arm and leg; put the weapon in the right hand, where the orange stick is.',
  'Stylized 3D mobile-game rendering, clean shapes, consistent colours and proportions in all four views.',
  'Transparent background. No floor, no shadow, no text, no frame, no extra objects.',
].join(' ');

const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return null; } };

function cle() { return (process.env.OPENAI_API_KEY || '').trim(); }
function propre(m) {
  let s = String(m || '');
  const k = cle(); if (k) s = s.split(k).join('[key]');
  return s.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[key]').replace(/[\u0000-\u001f]/g, ' ').slice(0, 240);
}

/* le journal de la ligne de commande : un seul, ou que soient les images */
const DOSSIER_ARGENT = () => path.join(os.homedir(), '.swoge-planches');

function cree({ dossier, base, maintenant, plafond, argent }) {
  const temps = () => (maintenant ? maintenant() : Date.now());
  /* `argent` : le dossier du journal et de l'ARRET (par defaut celui des poses, pour les essais) */
  const A = argent || dossier;
  const JOURNAL = path.join(A, 'journal_openai.jsonl'), ARRET = path.join(A, 'ARRET'), POSES = path.join(dossier, 'poses');
  const BASE = () => String(base || process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
  /* un plafond passe (essais) ne peut que BAISSER les 2,50 $ */
  const PLAF = plafond != null ? Math.min(Number(plafond) || 0, PLAFOND) : PLAFOND;

  function etat() {
    const L = jsonl(JOURNAL);
    const par = new Map();
    for (const l of L || []) par.set(l.id, Object.assign({}, par.get(l.id) || {}, l));
    let depense = 0, maxMesure = {}; const vus = [...par.values()];
    for (const x of vus) {
      if (x.statut === 'envoye') depense += Number(x.reserve) || 0;
      else { depense += Number.isFinite(Number(x.coutUsd)) ? Number(x.coutUsd) : (Number(x.reserve) || 0);
             if (x.statut === 'fini' && Number.isFinite(Number(x.coutUsd))) maxMesure[x.n] = Math.max(maxMesure[x.n] || 0, Number(x.coutUsd)); }
    }
    return { journal: L, depense: Math.round(depense * 1e4) / 1e4, maxMesure, appels: vus.length };
  }
  const reserve = (n, e) => (e.maxMesure[n] ? Math.round(1.5 * e.maxMesure[n] * 1e4) / 1e4 : reserveDepart(n));
  const arrete = (raison) => { fs.mkdirSync(A, { recursive: true }); fs.writeFileSync(ARRET, new Date(temps()).toISOString() + ' ' + raison + '\n'); };
  const ecrit = (l) => {
    fs.mkdirSync(A, { recursive: true });
    const fd = fs.openSync(JOURNAL, 'a');
    try { fs.writeSync(fd, JSON.stringify(l) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };

  /** Le cout d'une reponse, d'apres son usage ; null si l'usage manque. */
  function cout(u) {
    if (!u || !Number.isFinite(Number(u.output_tokens))) return null;
    const d = u.input_tokens_details || {};
    if (!Number.isFinite(Number(d.image_tokens))) return null;
    const texte = Number.isFinite(Number(d.text_tokens)) ? Number(d.text_tokens) : Math.max(0, Number(u.input_tokens || 0) - Number(d.image_tokens));
    return Math.round((Number(d.image_tokens) * PRIX.imageEntree + texte * PRIX.texteEntree + Number(u.output_tokens) * PRIX.imageSortie) * 1e6) / 1e6;
  }

  /** Verifie TOUT ce qui peut refuser, sans rien envoyer. */
  function peut(n) {
    if (fs.existsSync(ARRET)) return { ok: false, raison: 'ARRET: ' + fs.readFileSync(ARRET, 'utf8').trim().slice(0, 160) };
    const e = etat();
    let images = []; try { images = fs.readdirSync(POSES).filter((f) => /\.png$/.test(f)); } catch (x) { images = []; }
    if (e.journal === null && images.length) return { ok: false, raison: 'journal missing while ' + POSES + ' holds ' + images.length + ' images: what was paid is unknown' };
    if (!cle()) return { ok: false, raison: 'OPENAI_API_KEY is not set' };
    const r = reserve(n, e);
    if (e.depense + r > PLAF + 1e-9) return { ok: false, raison: 'cap: ' + e.depense.toFixed(4) + ' $ spent or reserved + ' + r.toFixed(4) + ' $ for this call > ' + PLAF.toFixed(2) + ' $', depense: e.depense, reserve: r };
    return { ok: true, reserve: r, depense: e.depense, premier: !Object.keys(e.maxMesure).length };
  }

  /** Un appel : rend { ok, fichiers, coutUsd, usage } ou { ok:false, raison } — sans appel si refus. */
  async function appelle({ nom, n, toile, ancienne }) {
    if (!/^[a-z_]{1,32}$/.test(String(nom || ''))) return { ok: false, raison: 'bad monster name' };
    n = n === 2 ? 2 : 1;
    const p = peut(n);
    if (!p.ok) return p;
    const id = crypto.randomBytes(8).toString('hex'), t = temps();
    ecrit({ id, t, statut: 'envoye', nom, n, modele: MODELE, reserve: p.reserve });
    const fd = new FormData();
    fd.append('model', MODELE); fd.append('prompt', CONSIGNE); fd.append('n', String(n));
    fd.append('size', '2048x1024'); fd.append('quality', 'high'); fd.append('background', 'transparent'); fd.append('output_format', 'png');
    fd.append('image[]', new Blob([toile], { type: 'image/png' }), 'mannequin.png');
    fd.append('image[]', new Blob([ancienne], { type: 'image/png' }), nom + '.png');
    let j = null, statut = 0, erreur = null;
    try {
      const r = await fetch(BASE() + '/v1/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + cle() }, body: fd, signal: AbortSignal.timeout(300000) });
      statut = r.status;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!r.ok) erreur = 'OpenAI ' + r.status + (j && j.error && j.error.message ? ' - ' + j.error.message : '');
    } catch (e) { erreur = 'network: ' + (e && e.message); }
    const usage = j && j.usage || null;
    let c = cout(usage);
    if (erreur && !(statut >= 400 && statut < 500)) {
      /* pas de reponse, ou un 5xx : l'image a peut-etre ete generee et facturee. Cout
         inconnu = cout plein (la reserve), et ARRET : on relit la facturation OpenAI. */
      const fin = { id, t: temps(), statut: 'inconnu', nom, n, ms: temps() - t, usage, http: statut, coutUsd: c == null ? p.reserve : Math.max(c, p.reserve), sansUsage: c == null, erreur: propre(erreur) };
      const raison = 'no usable answer from OpenAI (' + fin.erreur.slice(0, 80) + '): it may have been billed, ' + fin.coutUsd + ' $ counted; check the OpenAI usage page, then delete this file';
      fin.arret = raison;
      ecrit(fin); arrete(raison);
      return { ok: false, raison: fin.erreur, coutUsd: fin.coutUsd, arret: raison };
    }
    const fin = { id, t: temps(), statut: erreur ? 'erreur' : 'fini', nom, n, ms: temps() - t, usage, http: statut };
    if (erreur) {
      /* une reponse 4xx : rien n'est facture si aucune image n'est rendue — sauf si l'usage dit le contraire */
      fin.coutUsd = c == null ? 0 : c; fin.erreur = propre(erreur);
      ecrit(fin);
      return { ok: false, raison: fin.erreur, coutUsd: fin.coutUsd };
    }
    const arrets = [];
    if (c == null) { c = p.reserve; fin.sansUsage = true; arrets.push('usage missing: cost taken as the reserve'); }
    fin.coutUsd = c;
    if (c > p.reserve + 1e-9) arrets.push('cost ' + c + ' $ > reserve ' + p.reserve + ' $');
    const it = usage && usage.input_tokens_details && Number(usage.input_tokens_details.image_tokens);
    if (p.premier && (!Number.isFinite(it) || it / 2 > JETONS_IMAGE_MAX)) arrets.push('calibration: ' + (Number.isFinite(it) ? it + ' image tokens for 2 input images' : 'no image_tokens') + ' (max ' + JETONS_IMAGE_MAX + ' per image)');
    const fichiers = [];
    fs.mkdirSync(POSES, { recursive: true });
    (j && j.data || []).forEach((d, i) => {
      if (!d || !d.b64_json) return;
      const f = path.join(POSES, nom + '_' + id + '_' + i + '.png');
      fs.writeFileSync(f, Buffer.from(d.b64_json, 'base64')); fichiers.push(f);
    });
    fin.fichiers = fichiers.map((f) => path.basename(f));
    if (arrets.length) fin.arret = arrets.join('; ');
    ecrit(fin);
    if (arrets.length) arrete(arrets.join('; '));
    return { ok: true, fichiers, coutUsd: c, usage, arret: arrets.length ? arrets.join('; ') : null };
  }

  return { appelle, peut, etat, cout, reserve: (n) => reserve(n, etat()), JOURNAL, ARRET, POSES, PLAFOND: PLAF };
}

/** Ce que construit la ligne de commande : les images dans `dossier`, l'argent a un chemin fixe. */
function creeCommande({ dossier, base }) { return cree({ dossier, base, argent: DOSSIER_ARGENT() }); }

if (require.main === module) {
  const a = process.argv.slice(2), nom = a[0];
  const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const site = opt('site', '/home/user/SWOGE.github.io'), dossier = path.resolve(opt('dossier', path.join(site, '_planches')));
  (async () => {
    const P = creeCommande({ dossier });
    const n = Number(opt('n', 1)) === 2 ? 2 : 1;
    const t = G.toilePoses(2048, 1024);
    const ancienne = await M.lisImage(path.join(site, 'img/nexus/monstres', nom + '.webp'));
    const r = await P.appelle({ nom, n, toile: M.png(t), ancienne: M.png(ancienne) });
    console.log(JSON.stringify(r));
    process.exit(r.ok && !r.arret ? 0 : 1);
  })().catch((e) => { console.error(propre(e && e.message)); process.exit(1); });
}

module.exports = { cree, creeCommande, DOSSIER_ARGENT, PLAFOND, MODELE, PRIX, CONSIGNE, reserveDepart, JETONS_IMAGE_MAX };
