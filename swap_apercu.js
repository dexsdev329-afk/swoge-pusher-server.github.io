'use strict';
/* ==========================================================================
 * SWOGE SWAP — L'IMAGE DE DEPART FAITE PAR OPENAI, AVANT DE PAYER LA VIDEO (15 octobre 2026)
 *
 * Ce que le proprietaire a valide (sa video « presque parfaite » du 15/10) :
 *   1. on prend le plan de la video ;
 *   2. on REFAIT cette image avec son personnage a la place de la personne visee
 *      (il le faisait a la main dans ChatGPT) ;
 *   3. Kling ANIME cette image d'apres le mouvement de la video (« Animate my
 *      still », first_frame + feature_video, kling_entier.js mode 'anime') ;
 *   4. le son d'origine est remis par-dessus, meme duree.
 * Ce module fait l'etape 2, pour le public (swap.js, routes /studio/swap/<id>/apercu*)
 * et pour le proprietaire (server.js, /studio/kling/entier/<id>/apercu*). L'image est
 * rendue en APERCU : le joueur la regarde, « Regenerate » (payant, prix affiche) ou
 * « Use this picture », qui la donne a Kling comme premiere image.
 *
 * ---- L'APPEL (SDK openai 7.34.0, resources/images.d.ts et internal/uploads.js, lus le 15/10/2026) ----
 *   POST /v1/images/edits, multipart/form-data :
 *     model, prompt (32 000 signes au plus), image[] = le plan, image[] = le personnage
 *     (« image: Uploadable | Array<Uploadable> », jusqu'a 16 images ; un tableau part en
 *     champs `image[]` repetes, dans l'ordre — addFormValue du SDK), size, quality,
 *     n = 1, output_format = png ; input_fidelity = high pour gpt-image-1* seulement
 *     (« For gpt-image-2, omit this parameter »). Reponse : data[0].b64_json et `usage`
 *     (input_tokens, input_tokens_details.{text_tokens,image_tokens}, output_tokens).
 *   La cle : OPENAI_API_KEY, la meme que x_post.js et studio_openai.js ; jamais ecrite
 *   dans un journal, une reponse ou un message d'erreur. OPENAI_BASE_URL change l'hote (essais).
 *
 * ---- LE MODELE : gpt-image-2 par defaut (SWAP_IMAGE_MODELE pour en changer) ----
 *   - c'est deja le defaut de ChatGPT Image dans le Studio (STUDIO_OPENAI_IMAGE, 26/09) ;
 *   - le SDK dit de lui : « arbitrary resolutions … WIDTHxHEIGHT … divisible by 16 …
 *     aspect ratio between 1:3 and 3:1 » : on demande donc le rapport EXACT de la video
 *     (720×1280 → 864×1536), sans rien recadrer ;
 *   - gpt-image-1.5 (celui des posts X, mesure le 18/09) n'a que 1024×1024, 1536×1024 et
 *     1024×1536 : on prend la plus proche du rapport puis on recadre au centre.
 *   Dans tous les cas l'image rendue est ramenee aux cotes EXACTES de la video envoyee a Kling
 *   (recadrage centre au bon rapport, puis mise a l'echelle).
 *   NON MESURE : la fidelite de gpt-image-2 a un personnage de reference sans input_fidelity
 *   (le parametre n'existe pas pour lui) ; si le personnage derive, essayer
 *   SWAP_IMAGE_MODELE=gpt-image-1.5 (input_fidelity high) et comparer sur le meme plan.
 *
 * ---- LE PRIX (grille OpenAI relue le 26/09, studio_media.js PRIX_OPENAI, par million de jetons) ----
 *   gpt-image-2 : texte 5 $, image d'entree 8 $, sortie 30 $. Pire cas reserve AVANT l'appel :
 *   12 000 jetons de sortie (la reserve du Studio, ×1,74 la mesure du 18/09 : 6 893 jetons pour
 *   une 1536×1024 « high » en gpt-image-1.5), 2 000 de texte, 12 000 d'entree PAR image (2) :
 *   12 000×30 + 2 000×5 + 24 000×8 = 0,562 $ chez OpenAI → × SWAP_MARGE (2) = 1,13 $ au joueur.
 *   La facture lit `usage` × marge, au cent superieur, jamais plus que la reserve ; un echec
 *   est rendu en entier. ESTIMATION, PAS UNE MESURE : aucune image gpt-image-2 a deux images
 *   d'entree n'a encore ete facturee sur ce compte ; le vrai cout s'ecrit au journal (`usage`,
 *   `coutUsd`) a chaque image.
 *
 * ---- LES BORNES ----
 *   Public : 6 images par passe (APERCUS_MAX), une a la fois par passe, 4 en vol pour tout le
 *   service ; la depense engagee compte dans le plafond du jour de SWOGE Swap
 *   (SWAP_PLAFOND_JOUR_USD, kling_entier.js), corrigee sur le cout lu. Proprietaire : 30 images
 *   par jour UTC (son compte OpenAI, ≈ 17 $ au pire). Garde 48 h.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const K = require('./kling');
const ST = require('./swoge_texte');
const { PRIX_OPENAI } = require('./studio_media');

const MODELE_DEFAUT = 'gpt-image-2';
const QUALITE = 'high';
const RESERVE = { sortie: 12000, texte: 2000, entreeParImage: 12000 };
/* un modele absent de la grille : le plus cher connu (comme studio_media.js) */
const PRIX_INCONNU = { t: 5, i: 10, o: 40 };
const APERCUS_MAX = 6;
const EN_VOL_MAX = 4;
const PROPRIO_JOUR_MAX = 30;
const GARDE_MS = 48 * 3600e3;
const DELAI_MS = 240000;
const QUI_MAX = 80;
const CLE = /^[a-z]{1,8}_[0-9a-f]{24}$/;
/* les tailles fixes des modeles GPT image (SDK) */
const TAILLES_FIXES = [[1024, 1024], [1536, 1024], [1024, 1536]];
/* l'image du personnage SWOGE envoyee a OpenAI : le meme « Swole Doge » que Kling
   (img/site/swoge_meme_ref.jpg, copie octet pour octet dans references/) */
const REF_SWOGE = path.join(__dirname, 'references', 'swoge_meme_ref.jpg');

const executer = (bin, args, ms) => new Promise((res, rej) => execFile(bin, args, { timeout: ms || 120000, maxBuffer: 16 * 1024 * 1024 },
  (e, out, err) => (e ? rej(Object.assign(e, { err: String(err || '').slice(-300) })) : res(String(out || '')))));
const propre = (m) => String(m || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 240);
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);
const arrondi6 = (x) => Math.round(x * 1e6) / 1e6;

const prixDe = (modele) => PRIX_OPENAI[modele] || PRIX_INCONNU;
/** Le pire cas chez OpenAI d'un apercu a `nImages` images d'entree (dollars, avant marge). */
function pireCasUsd(modele, nImages) {
  const p = prixDe(modele);
  return arrondi6((RESERVE.sortie * p.o + RESERVE.texte * p.t + (nImages || 2) * RESERVE.entreeParImage * p.i) / 1e6);
}
/** Le cout lu dans `usage` (sans detail : toute l'entree au prix image, le plus cher), ou null. */
function coutUsd(modele, usage) {
  if (!usage || !Number.isFinite(Number(usage.output_tokens))) return null;
  const p = prixDe(modele), d = usage.input_tokens_details || {};
  const entree = Number(usage.input_tokens) || 0;
  const texte = Number.isFinite(Number(d.text_tokens)) ? Number(d.text_tokens) : 0;
  const image = Number.isFinite(Number(d.image_tokens)) ? Number(d.image_tokens) : entree - texte;
  return arrondi6((texte * p.t + image * p.i + Number(usage.output_tokens) * p.o) / 1e6);
}

/** Le modele accepte-t-il une taille libre (gpt-image-2 et 2.5, d'apres le SDK) ? */
const tailleLibre = (modele) => /^gpt-image-2/.test(String(modele));

/**
 * La taille demandee a OpenAI pour une video de l × h : { size, largeur, hauteur, exact }.
 * Taille libre : 1536 px sur le grand cote, l'autre au multiple de 16 le plus proche, le rapport
 * borne a 1:3–3:1 (SDK). Sinon : la taille fixe dont le rapport est le plus proche (log).
 */
function tailleSortie(modele, l, h) {
  l = Number(l); h = Number(h);
  if (!(l > 0 && h > 0)) return null;
  let r = l / h;
  if (tailleLibre(modele)) {
    r = Math.min(3, Math.max(1 / 3, r));
    const grand = 1536, petit = Math.max(16, Math.round(grand * Math.min(r, 1 / r) / 16) * 16);
    const L = r >= 1 ? grand : petit, H = r >= 1 ? petit : grand;
    return { size: L + 'x' + H, largeur: L, hauteur: H, exact: Math.abs(L / H - l / h) < 0.005 };
  }
  let best = TAILLES_FIXES[0];
  for (const t of TAILLES_FIXES) if (Math.abs(Math.log((t[0] / t[1]) / r)) < Math.abs(Math.log((best[0] / best[1]) / r))) best = t;
  return { size: best[0] + 'x' + best[1], largeur: best[0], hauteur: best[1], exact: Math.abs(best[0] / best[1] - r) < 0.005 };
}

/** Le recadrage centre d'une image L × H au rapport l : h (cotes paires) : { largeur, hauteur, x, y }. */
function recadrage(L, H, l, h) {
  const r = l / h;
  let cw = L, ch = H;
  if (L / H > r) cw = Math.min(L, 2 * Math.round(H * r / 2)); else ch = Math.min(H, 2 * Math.round(L / r / 2));
  return { largeur: cw, hauteur: ch, x: Math.floor((L - cw) / 2), y: Math.floor((H - ch) / 2) };
}

/**
 * Qui remplacer : un id de swoge_texte.CIBLES (gauche, centre, droite, seule — pas les caches),
 * ou 'decrit' avec une description courte (3 a QUI_MAX signes, nettoyee : ni guillemets, ni @,
 * ni caracteres de controle). Rend { ok, id, qui, autres, decrit? } ou { ok:false, raison }.
 */
function cibleDe(id, qui) {
  if (id === 'decrit') {
    const t = String(qui == null ? '' : qui).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/["\u201c\u201d\u201e\u00ab\u00bb@<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 3) return { ok: false, raison: 'describe who to replace in a few words (for example: the man in the red cap)' };
    if (t.length > QUI_MAX) return { ok: false, raison: 'the description is ' + t.length + ' characters — ' + QUI_MAX + ' at most' };
    return { ok: true, id: 'decrit', qui: 'ONLY the person described as: ' + t, autres: ST.AUTRES, decrit: t };
  }
  const c = ST.CIBLES.find((x) => x.id === id && !x.cache);
  if (!c) return { ok: false, raison: 'pick who to replace: left, center, right, the only person, or describe them' };
  return { ok: true, id: c.id, qui: c.qui, autres: c.autres };
}

const SWOGE = 'The character is SWOGE, the Swole Doge of image 2: a 3D Shiba Inu with a small Doge head on a thick neck, an enormous muscular furry upper body with huge arms, and short thin legs.'
  + ' Thick fluffy cream-beige fur everywhere, one uniform colour; no bare human skin anywhere. Furry dog paws with dark pads and small dark claws instead of human hands. Plain black gym shorts.'
  + ' The round friendly Doge face of image 2 (cream-white cheeks, small dark eyes, black nose, smile), not a realistic wolf-like Shiba.';
const LIBRE = 'The character keeps its exact look from image 2: face, colours, proportions, outfit and art style. It never gets the face of a real person.';

/** La consigne envoyee a OpenAI : remplacer SEULEMENT la personne visee ; tout le reste ne bouge pas. */
function consigne(cible, perso) {
  return [
    'Image 1 is a frame from a video. Image 2 shows a character.',
    'Edit image 1: replace ' + cible.qui + ' with the character from image 2.',
    'The character takes exactly the same pose, the same place and the same size in the frame as the replaced person, seen from the same camera angle, with the same framing, lighting, shadows and colour grading as image 1.',
    perso === 'swoge' ? SWOGE : LIBRE,
    'Nothing is kept from the replaced person: no hair, skin, face, clothes or accessories.',
    cible.autres ? 'Every other person stays exactly as they are: same face, body, clothes and pose.' : '',
    'Everything else in image 1 stays exactly the same: background, objects, framing and camera. Do not add, move or remove anything else. Photorealistic like the video frame. No text, no watermark, no border.',
  ].filter(Boolean).join(' ');
}

/**
 * deps : { dossier, journal?, cle() (la cle OpenAI, lue a l'appel), fetch?, base?, modele?,
 *          ffmpeg?, maintenant?, parJour? (proprietaire : images par jour UTC), enVolMax? }
 */
function cree(deps) {
  const dossier = deps.dossier;
  const temps = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const ffmpeg = deps.ffmpeg || 'ffmpeg';
  const cle = () => String((deps.cle ? deps.cle() : process.env.OPENAI_API_KEY) || '').trim();
  const base = () => String(deps.base || process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
  const prendre = () => deps.fetch || globalThis.fetch;
  const modele = () => String(deps.modele || process.env.SWAP_IMAGE_MODELE || MODELE_DEFAUT).trim();
  const ENVOL = deps.enVolMax > 0 ? Number(deps.enVolMax) : EN_VOL_MAX;
  const note = (o) => { try { if (deps.journal) deps.journal(Object.assign({ apercu: true }, o)); } catch (e) { /* jamais bloquant */ } };
  const JOBS = new Map();
  const TRAVAUX = new Map();
  const rep = (c) => path.join(dossier, c);
  const fJour = () => path.join(dossier, 'jour.json');

  function ecrit(J) {
    try {
      fs.mkdirSync(rep(J.cle), { recursive: true });
      const f = path.join(rep(J.cle), 'job.json'), t = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(t, JSON.stringify(J)); fs.renameSync(t, f);
    } catch (e) { console.error('[apercu] etat non ecrit : ' + e.message); }
  }
  function lisJour() { try { const j = JSON.parse(fs.readFileSync(fJour(), 'utf8')); return j.jour === jourDe(temps()) ? j : { jour: jourDe(temps()), images: 0 }; } catch (e) { return { jour: jourDe(temps()), images: 0 }; } }
  function ajouteJour(n) { const j = lisJour(); j.images += n; try { fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(fJour() + '.tmp', JSON.stringify(j)); fs.renameSync(fJour() + '.tmp', fJour()); } catch (e) { /* jamais bloquant */ } }

  /* au demarrage : une image « en cours » est perdue (l'appel HTTP est mort avec le processus) ;
     sa reserve est rendue par reprendReserves (le credit est relu a ce moment-la) */
  function relit() {
    let noms = [];
    try { noms = fs.readdirSync(dossier); } catch (e) { return; }
    for (const n of noms) {
      if (!CLE.test(n)) continue;
      let J = null;
      try { J = JSON.parse(fs.readFileSync(path.join(rep(n), 'job.json'), 'utf8')); } catch (e) { J = null; }
      if (!J || J.cle !== n || temps() - Number(J.t) > GARDE_MS) { try { fs.rmSync(rep(n), { recursive: true, force: true }); } catch (e) { /* rien */ } continue; }
      for (const c of J.candidats || []) if (c.statut === 'en_cours') { c.statut = 'echec'; c.message = 'interrupted by a server restart — try again'; c.interrompu = true; }
      JOBS.set(n, J); ecrit(J);
    }
  }

  const enVol = () => [...JOBS.values()].reduce((a, J) => a + J.candidats.filter((c) => c.statut === 'en_cours').length, 0);

  /**
   * Une image de depart pour la passe `q.cle` de `addr` (la SESSION). q : { cle, chemin (le
   * morceau 1, MP4), cotes { largeur, hauteur } (celles envoyees a Kling), cible, qui?,
   * perso: { id: 'swoge' } | { id: 'libre', octets (Buffer JPEG/PNG deja ACCEPTE par la porte), sha },
   * paie? { reserve(usd, info) → jeton|null, regle(jeton, usd), prixClient(usd), solde?() },
   * jour? { plein(usd), ajoute(usd, jour) } }. Sans `paie` : le proprietaire (plafond du jour).
   * Rend tout de suite { ok, apercu } ; l'appel a OpenAI tourne en fond (la page suit par etat()).
   */
  async function demande(addr, q) {
    q = q || {};
    if (!addr) return { ok: false, code: 401, raison: 'sign in with your wallet first' };
    if (!CLE.test(String(q.cle || ''))) return { ok: false, code: 400, raison: 'unknown video' };
    const c = cibleDe(q.cible, q.qui);
    if (!c.ok) return { ok: false, code: 400, raison: c.raison };
    const perso = q.perso && q.perso.id === 'libre' ? 'libre' : 'swoge';
    let persoOctets;
    try { persoOctets = perso === 'libre' ? q.perso.octets : fs.readFileSync(REF_SWOGE); } catch (e) { persoOctets = null; }
    const dimPerso = Buffer.isBuffer(persoOctets) ? K.dimensionsImage(persoOctets) : null;
    if (!dimPerso) return { ok: false, code: 400, raison: perso === 'libre' ? 'your character picture is gone — upload it again' : 'the SWOGE picture is missing on the server' };
    const cotes = q.cotes || {};
    if (!(cotes.largeur > 0 && cotes.hauteur > 0)) return { ok: false, code: 400, raison: 'unknown video size' };
    let J = JOBS.get(q.cle);
    if (J && J.addr !== addr) return { ok: false, code: 404, raison: 'unknown video' };
    if (J && J.candidats.some((x) => x.statut === 'en_cours')) return { ok: false, code: 409, raison: 'a picture is already being made — wait for it' };
    if (J && J.candidats.length >= APERCUS_MAX) return { ok: false, code: 429, raison: APERCUS_MAX + ' pictures per video at most — use one of them, or upload the video again' };
    if (!cle()) return { ok: false, code: 503, raison: 'picture making is not switched on yet (OPENAI_API_KEY)' };
    if (enVol() >= ENVOL) return { ok: false, code: 503, raison: 'the picture maker is busy — try again in a minute' };
    if (!q.paie && lisJour().images + 1 > (deps.parJour > 0 ? deps.parJour : PROPRIO_JOUR_MAX)) return { ok: false, code: 429, raison: 'daily cap reached: ' + (deps.parJour > 0 ? deps.parJour : PROPRIO_JOUR_MAX) + ' pictures per day (UTC)' };
    const m = modele();
    const pire = pireCasUsd(m, 2);
    /* le plan : l'image 0 du morceau 1, une fois par passe (deja aux cotes envoyees a Kling) */
    if (!J) {
      fs.mkdirSync(rep(q.cle), { recursive: true });
      try { await executer(ffmpeg, ['-v', 'error', '-y', '-i', q.chemin, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', path.join(rep(q.cle), 'plan.png')], 60000); }
      catch (e) { try { fs.rmSync(rep(q.cle), { recursive: true, force: true }); } catch (x) { /* rien */ } return { ok: false, code: 400, raison: 'ffmpeg could not read the first frame of the video: ' + propre(e.err || e.message) }; }
      J = { cle: q.cle, addr, t: temps(), cotes: { largeur: cotes.largeur, hauteur: cotes.hauteur }, candidats: [] };
      JOBS.set(q.cle, J);
    }
    /* l'argent AVANT l'appel : le plafond du jour, puis la reserve (rendue a un echec) */
    let paiement = null;
    if (q.paie) {
      const usd = q.paie.prixClient(pire);
      if (q.jour && q.jour.plein(pire)) { note({ cle: q.cle, refus: 'plafond-jour', pireUsd: pire }); return { ok: false, code: 429, raison: q.jour.message || 'daily limit reached — try again tomorrow. You were not charged.' }; }
      const jeton = q.paie.reserve(usd, { genre: 'swap-apercu', cle: q.cle, addr, usd, t0: temps() });
      if (!jeton) {
        const solde = q.paie.solde ? q.paie.solde() : null;
        note({ cle: q.cle, refus: 'credit', prixUsd: usd, soldeUsd: solde });
        return { ok: false, code: 402, raison: 'your dollar credit is too low: $' + usd.toFixed(2) + ' needed' + (solde != null ? ', you have $' + Number(solde).toFixed(2) : '') + ' — top it up first',
          prixUsd: usd, soldeUsd: solde, manqueUsd: solde != null ? Math.ceil((usd - solde) * 100 - 1e-9) / 100 : null };
      }
      if (q.jour) q.jour.ajoute(pire);
      paiement = { jeton, usd, jour: jourDe(temps()), engageUsd: pire, regle: null };
    } else ajouteJour(1);
    const k = J.candidats.length;
    const cand = { k, statut: 'en_cours', t: temps(), modele: m, cible: c.id, decrit: c.decrit || null, perso, sha: perso === 'libre' ? String(q.perso.sha || '') : null,
                   fichier: null, message: null, usage: null, coutUsd: null, paiement };
    J.candidats.push(cand); ecrit(J);
    note({ cle: q.cle, k, lance: true, modele: m, cible: c.id, perso, reserveUsd: paiement ? paiement.usd : null, pireUsd: pire });
    const tache = genere(J, cand, c, persoOctets, dimPerso, q).catch((e) => console.error('[apercu] ' + (e && e.message))).finally(() => TRAVAUX.delete(q.cle + ':' + k));
    TRAVAUX.set(q.cle + ':' + k, tache);
    return { ok: true, apercu: vue1(J, !!q.paie) };
  }

  async function genere(J, cand, c, persoOctets, dimPerso, q) {
    const t0 = temps();
    const dPlan = path.join(rep(J.cle), 'plan.png');
    const taille = tailleSortie(cand.modele, J.cotes.largeur, J.cotes.hauteur);
    const finit = (statut, o) => {
      Object.assign(cand, o, { statut, secondes: Math.round((temps() - t0) / 100) / 10 });
      /* le reglement : le cout lu × marge au cent superieur, jamais plus que la reserve ; un echec rend tout */
      if (cand.paiement && !cand.paiement.regle && q.paie) {
        const du = statut === 'pret' ? Math.min(cand.paiement.usd, cand.coutUsd != null ? q.paie.prixClient(cand.coutUsd) : cand.paiement.usd) : 0;
        q.paie.regle(cand.paiement.jeton, du);
        cand.paiement.regle = { usd: du, renduUsd: Math.round((cand.paiement.usd - du) * 100) / 100, t: temps() };
        /* le plafond du jour : ce qui est vraiment parti chez OpenAI, a la place du pire cas */
        if (q.jour) q.jour.ajoute(arrondi6((statut === 'pret' ? (cand.coutUsd != null ? cand.coutUsd : cand.paiement.engageUsd) : 0) - cand.paiement.engageUsd), cand.paiement.jour);
      }
      ecrit(J);
      note({ cle: J.cle, k: cand.k, statut, message: cand.message, modele: cand.modele, size: taille && taille.size, usage: cand.usage, coutUsd: cand.coutUsd,
             factureUsd: cand.paiement && cand.paiement.regle ? cand.paiement.regle.usd : null, secondes: cand.secondes });
    };
    let r, j;
    try {
      const fd = new FormData();
      fd.append('model', cand.modele);
      fd.append('prompt', consigne(c, cand.perso));
      /* l'ordre compte : image 1 = le plan, image 2 = le personnage (la consigne les nomme ainsi) */
      fd.append('image[]', new Blob([fs.readFileSync(dPlan)], { type: 'image/png' }), 'frame.png');
      fd.append('image[]', new Blob([persoOctets], { type: dimPerso.format === 'png' ? 'image/png' : 'image/jpeg' }), 'character.' + (dimPerso.format === 'png' ? 'png' : 'jpg'));
      fd.append('size', taille.size);
      fd.append('quality', QUALITE);
      fd.append('n', '1');
      fd.append('output_format', 'png');
      if (/^gpt-image-1/.test(cand.modele)) fd.append('input_fidelity', 'high');
      r = await prendre()(base() + '/v1/images/edits', { method: 'POST', headers: { authorization: 'Bearer ' + cle() }, body: fd, signal: AbortSignal.timeout(deps.delaiMs || DELAI_MS) });
      j = await r.json().catch(() => null);
    } catch (e) {
      return finit('echec', { message: 'OpenAI did not answer: ' + propre(e && (e.name === 'TimeoutError' ? 'timed out' : e.message)) + ' — you were not charged' });
    }
    if (!r.ok || !j) {
      const msg = j && j.error && j.error.message;
      /* le message d'OpenAI tel quel (un refus de contenu se lit), jamais la cle */
      return finit('echec', { message: propre('OpenAI refused (HTTP ' + r.status + ')' + (msg ? ': ' + String(msg).split(cle()).join('[key]') : '')) + ' — you were not charged' });
    }
    const b64 = j.data && j.data[0] && j.data[0].b64_json;
    cand.usage = j.usage || null;
    cand.coutUsd = coutUsd(cand.modele, j.usage);
    if (!b64) return finit('echec', { message: 'OpenAI answered without a picture — you were not charged' });
    /* ramener l'image aux cotes EXACTES de la video : recadrage centre au bon rapport, puis echelle */
    const brut = path.join(rep(J.cle), 'brut_' + cand.k + '.png');
    const nom = 'cand_' + cand.k + '.jpg';
    try {
      const o = Buffer.from(b64, 'base64');
      const d = K.dimensionsImage(o);
      if (!d) throw new Error('not a PNG or JPEG');
      fs.writeFileSync(brut, o);
      const rc = recadrage(d.largeur, d.hauteur, J.cotes.largeur, J.cotes.hauteur);
      await executer(ffmpeg, ['-v', 'error', '-y', '-i', brut, '-vf', 'crop=' + rc.largeur + ':' + rc.hauteur + ':' + rc.x + ':' + rc.y + ',scale=' + J.cotes.largeur + ':' + J.cotes.hauteur + ':flags=lanczos,setsar=1',
        '-frames:v', '1', '-q:v', '2', '-f', 'image2', path.join(rep(J.cle), nom + '.part')], 60000);
      fs.renameSync(path.join(rep(J.cle), nom + '.part'), path.join(rep(J.cle), nom));
      const v = K.referenceEdition(fs.readFileSync(path.join(rep(J.cle), nom)).toString('base64'));
      if (!v.ok) throw new Error(v.raison);
      cand.recu = d.largeur + 'x' + d.hauteur;
    } catch (e) {
      try { fs.unlinkSync(path.join(rep(J.cle), nom + '.part')); } catch (x) { /* rien */ }
      return finit('echec', { message: 'the picture could not be fitted to the video: ' + propre(e.err || e.message) + ' — you were not charged' });
    } finally { try { fs.unlinkSync(brut); } catch (x) { /* rien */ } }
    return finit('pret', { fichier: nom, largeur: J.cotes.largeur, hauteur: J.cotes.hauteur });
  }

  /* ---- ce qui sort ---- */
  function vue1(J, pub) {
    return { cle: J.cle, cotes: J.cotes.largeur + 'x' + J.cotes.hauteur, max: APERCUS_MAX, enCours: J.candidats.some((c) => c.statut === 'en_cours'),
      candidats: J.candidats.map((c) => Object.assign({ k: c.k, statut: c.statut === 'pret' ? 'ready' : c.statut === 'en_cours' ? 'making' : 'failed', message: c.message, cible: c.cible, decrit: c.decrit, personnage: c.perso,
        largeur: c.largeur || null, hauteur: c.hauteur || null, secondes: c.secondes || null },
        pub ? { prixUsd: c.paiement ? c.paiement.usd : null, factureUsd: c.paiement && c.paiement.regle ? c.paiement.regle.usd : null } : { modele: c.modele, coutUsd: c.coutUsd })) };
  }
  function etat(cleJ, addr, pub) {
    const J = JOBS.get(String(cleJ || ''));
    if (!J || J.addr !== addr) return { ok: true, apercu: null };
    return { ok: true, apercu: vue1(J, pub) };
  }
  /** L'image k, pour SON adresse seulement. */
  function fichier(cleJ, addr, k) {
    const J = JOBS.get(String(cleJ || ''));
    if (!J || J.addr !== addr) return null;
    const c = J.candidats[Number(k)];
    if (!c || c.statut !== 'pret' || !c.fichier) return null;
    try { return { octets: fs.readFileSync(path.join(rep(J.cle), c.fichier)), type: 'image/jpeg' }; } catch (e) { return null; }
  }
  /** L'image k prete pour Kling : { ok, base64, format, largeur, hauteur, cible, perso, sha } ou un refus. */
  function choisie(cleJ, addr, k) {
    const J = JOBS.get(String(cleJ || ''));
    if (!J || J.addr !== addr) return { ok: false, code: 400, raison: 'create the preview picture first' };
    if (k == null || !/^\d{1,2}$/.test(String(k))) return { ok: false, code: 400, raison: 'pick one of your preview pictures' };
    const c = J.candidats[Number(k)];
    if (!c || c.statut !== 'pret') return { ok: false, code: 400, raison: 'this preview picture is not ready' };
    let b;
    try { b = fs.readFileSync(path.join(rep(J.cle), c.fichier)); } catch (e) { return { ok: false, code: 410, raison: 'this preview picture is gone — make it again' }; }
    const v = K.referenceEdition(b.toString('base64'));
    if (!v.ok) return { ok: false, code: 400, raison: 'preview picture: ' + v.raison };
    return { ok: true, base64: v.image, format: v.source, largeur: v.largeur, hauteur: v.hauteur, cible: c.cible, decrit: c.decrit, perso: c.perso, sha: c.sha, k: c.k };
  }

  /**
   * Au demarrage (public) : chaque reserve durable « swap-apercu » encore ouverte. Une image finie
   * mais pas reglee (arret entre les deux) : reglee a son prix ; tout le reste : rendu.
   */
  function reprendReserves(durables, paie) {
    const b = { reglees: 0, rendues: 0 };
    for (const d of durables || []) {
      if (!d || !d.info || d.info.genre !== 'swap-apercu') continue;
      const J = JOBS.get(String(d.info.cle || ''));
      const c = J && J.candidats.find((x) => x.paiement && x.paiement.jeton === d.id);
      if (c && c.paiement.regle) { paie.regle(d.id, c.paiement.regle.usd); b.reglees++; continue; }
      if (c && c.statut === 'pret' && c.coutUsd != null) {
        const du = Math.min(c.paiement.usd, paie.prixClient(c.coutUsd));
        paie.regle(d.id, du); c.paiement.regle = { usd: du, renduUsd: Math.round((c.paiement.usd - du) * 100) / 100, t: temps() }; ecrit(J); b.reglees++; continue;
      }
      paie.regle(d.id, 0);
      if (c) { c.paiement.regle = { usd: 0, renduUsd: c.paiement.usd, t: temps() }; ecrit(J); }
      b.rendues++;
      note({ paiement: 'rendu-demarrage', reserve: d.id, cle: d.info.cle || null });
    }
    return b;
  }

  function menage() {
    for (const J of [...JOBS.values()]) if (temps() - Number(J.t) > GARDE_MS && !J.candidats.some((c) => c.statut === 'en_cours')) { JOBS.delete(J.cle); try { fs.rmSync(rep(J.cle), { recursive: true, force: true }); } catch (e) { /* rien */ } }
  }

  relit();
  return { demande, etat, fichier, choisie, reprendReserves, menage, JOBS, actif: () => !!cle(), modele, prixPireUsd: () => pireCasUsd(modele(), 2),
    attend: async (cleJ) => { await Promise.all([...TRAVAUX.entries()].filter(([x]) => !cleJ || x.startsWith(cleJ + ':')).map(([, p]) => p)); } };
}

module.exports = { cree, consigne, cibleDe, tailleSortie, recadrage, pireCasUsd, coutUsd, tailleLibre, MODELE_DEFAUT, QUALITE, RESERVE, APERCUS_MAX, PROPRIO_JOUR_MAX, QUI_MAX, REF_SWOGE, CLE };
