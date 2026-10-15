'use strict';
/* ============================================================================
 * SWOGE SWAP V2 — L'IMAGE DE DEPART FAITE PAR OPENAI (swap_apercu.js, 15/10/2026 soir)
 *
 * Ce qui DOIT tenir :
 *   1. La taille demandee : le rapport EXACT de la video avec gpt-image-2 (taille libre,
 *      multiples de 16, 1:3–3:1 — SDK openai 7.34.0) ; la taille fixe la plus proche avec
 *      gpt-image-1.5, puis un recadrage CENTRE ; l'image rendue a toujours les cotes exactes
 *      de la video envoyee a Kling.
 *   2. La consigne : remplacer SEULEMENT la personne visee (gauche / centre / droite / seule /
 *      decrite), meme pose, meme place, meme taille, meme cadrage, meme lumiere, meme decor,
 *      les autres personnes et tout le reste inchanges ; SWOGE decrit, ou le personnage du
 *      joueur jamais avec le visage d'une personne reelle ; une description nettoyee et bornee.
 *   3. La requete : POST /v1/images/edits en multipart, la cle en Bearer, image[] = le plan
 *      (image 0 du morceau 1, aux cotes de la video) PUIS le personnage (le meme de SWOGE octet
 *      pour octet, ou l'image ACCEPTEE du joueur) ; model, size, quality high, n 1, png ;
 *      input_fidelity high pour gpt-image-1.5 seulement.
 *   4. L'argent (vrai credits.js) : le prix montre = pire cas × SWAP_MARGE ; reserve AVANT
 *      l'appel ; credit trop bas = 402 sans appel ; la facture lit `usage` × marge au cent,
 *      jamais plus que la reserve ; un refus d'OpenAI rend tout ; plafond du jour partage avec
 *      Kling ; 6 images par video au plus.
 *   5. La porte : une image de joueur non acceptee n'atteint jamais OpenAI.
 *   6. Le proprietaire : sans paiement, 30 (ici 2) images par jour, puis 429.
 *   7. « Animate » : l'apercu choisi est la premiere image chez Kling ; une image de la page
 *      est refusee ; le prix de la video est reserve.
 *   8. Le redemarrage : l'apercu se relit (reprise de la page) ; une image coupee en vol est
 *      rendue au demarrage.
 *   9. La cle OpenAI n'apparait nulle part (journal, reponses, messages).
 * OpenAI et Kling sont simules ; ffmpeg et credits.js sont les vrais.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const SA = require('./swap_apercu');
const SW = require('./swap');
const K = require('./kling');
const ST = require('./swoge_texte');
const Credits = require('./credits');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const fin = () => { console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe')); process.exit(rates ? 1 : 0); };
const ffmpegOk = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const CLE = 'sk-cle-openai-secrete-123';

/* Une image d'une couleur (ou trois bandes verticales : gauche, centre, droite). */
function image(l, h, couleur, bandes) {
  const f = path.join(os.tmpdir(), 'sa_' + Math.random().toString(16).slice(2) + '.png');
  const src = bandes ? 'color=c=' + couleur + ':s=' + l + 'x' + h + ',drawbox=x=0:y=0:w=' + bandes + ':h=' + h + ':color=blue:t=fill,drawbox=x=' + (l - bandes) + ':y=0:w=' + bandes + ':h=' + h + ':color=blue:t=fill'
    : 'color=c=' + couleur + ':s=' + l + 'x' + h;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', f]);
  const b = fs.readFileSync(f); fs.unlinkSync(f); return b;
}
/* la couleur d'un pixel (x, y) d'une image */
function pixel(octets, x, y) {
  const f = path.join(os.tmpdir(), 'sp_' + Math.random().toString(16).slice(2) + '.jpg');
  fs.writeFileSync(f, octets);
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', 'crop=1:1:' + x + ':' + y, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  fs.unlinkSync(f); return [b[0], b[1], b[2]];
}
const rouge = (c) => c[0] > 180 && c[1] < 80 && c[2] < 80;
const bleu = (c) => c[2] > 180 && c[0] < 80 && c[1] < 80;
function clip(f, d, l, h) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-t', String(d), '-i', 'testsrc2=size=' + l + 'x' + h + ':rate=30', '-f', 'lavfi', '-t', String(d), '-i', 'sine=frequency=440',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  return f;
}

/* OpenAI simule : relit le corps comme un serveur (le multipart encode par fetch, relu par formData) */
function faussesOpenai() {
  const O = { appels: [], reponse: null };
  O.fetch = async (url, o) => {
    const req = new Request(url, o);
    const type = req.headers.get('content-type') || '';
    const fd = await req.formData();
    const champs = {};
    for (const [k, v] of fd.entries()) (champs[k] = champs[k] || []).push(typeof v === 'string' ? v : { nom: v.name, type: v.type, octets: Buffer.from(await v.arrayBuffer()) });
    O.appels.push({ url: String(url), auth: req.headers.get('authorization'), type, champs });
    const r = typeof O.reponse === 'function' ? O.reponse(champs) : O.reponse;
    return new Response(JSON.stringify(r.corps), { status: r.statut || 200, headers: { 'content-type': 'application/json' } });
  };
  O.image = (l, h, couleur, bandes, usage) => ({ corps: { created: 1, data: [{ b64_json: image(l, h, couleur, bandes).toString('base64') }],
    usage: usage || { input_tokens: 3000, input_tokens_details: { text_tokens: 500, image_tokens: 2500 }, output_tokens: 7000, total_tokens: 10000 } } });
  return O;
}
/* Kling simule : « Animate » seulement */
function fauxKling() {
  const F = { envois: [] };
  F.kling = { actif: () => true,
    lanceAnime: async (q) => { F.envois.push(q); return { ok: true, id: 'A' + F.envois.length, estimationUsd: K.prixEdition(q.resolution, q.dureeS), anime: true }; },
    etat: async () => ({ ok: true, statut: 'processing' }), etatExterne: async () => ({ ok: false, code: 404 }) };
  return F;
}
async function attendPret(M, id, addr) {
  for (let k = 0; k < 400; k++) { const e = M.etat(id, addr); if (e.statut !== 'decoupe') return e; await M.attend(id); await new Promise((r) => setTimeout(r, 20)); }
  return M.etat(id, addr);
}

(async () => {
  console.log('-- 1. la taille, le recadrage, le prix (calcul) --');
  {
    const a = SA.tailleSortie('gpt-image-2', 720, 1280), b = SA.tailleSortie('gpt-image-2', 1920, 1080), c = SA.tailleSortie('gpt-image-2', 1080, 1080);
    ok(a.size === '864x1536' && a.exact && b.size === '1536x864' && b.exact && c.size === '1536x1536' && c.exact, 'gpt-image-2 : le rapport EXACT (720×1280 → 864×1536, 1920×1080 → 1536×864, carre → 1536×1536)');
    const d = SA.tailleSortie('gpt-image-2', 700, 2160);
    ok(d.size === '512x1536' && d.largeur % 16 === 0 && d.hauteur / d.largeur <= 3, 'un rapport au-dela de 1:3 est borne a 1:3 (SDK), multiples de 16 : ' + d.size);
    const e = SA.tailleSortie('gpt-image-1.5', 720, 1280), f = SA.tailleSortie('gpt-image-1.5', 1280, 720), g = SA.tailleSortie('gpt-image-1.5', 1000, 1000);
    ok(e.size === '1024x1536' && !e.exact && f.size === '1536x1024' && g.size === '1024x1024' && g.exact, 'gpt-image-1.5 : la taille fixe la plus proche (portrait 1024×1536, paysage 1536×1024, carre)');
    const r = SA.recadrage(1024, 1536, 720, 1280);
    ok(r.largeur === 864 && r.hauteur === 1536 && r.x === 80 && r.y === 0 && Math.abs(r.largeur / r.hauteur - 720 / 1280) < 0.001, 'recadrage centre au rapport 9:16 dans 1024×1536 : 864×1536 a x = 80');
    ok(SA.pireCasUsd('gpt-image-2', 2) === 0.562 && SW.prixClient(SA.pireCasUsd('gpt-image-2', 2), 2) === 1.13, 'pire cas gpt-image-2, 2 images : 0,562 $ chez OpenAI → 1,13 $ au joueur (marge 2)');
    const u = { input_tokens: 3000, input_tokens_details: { text_tokens: 500, image_tokens: 2500 }, output_tokens: 7000 };
    ok(SA.coutUsd('gpt-image-2', u) === 0.2325 && SW.prixClient(0.2325, 2) === 0.47 && SA.coutUsd('gpt-image-2', null) === null, 'le cout lu : 500×5 + 2 500×8 + 7 000×30 = 0,2325 $ → 0,47 $ au joueur ; sans usage : null');
    ok(SA.coutUsd('modele-inconnu', u) === (500 * 5 + 2500 * 10 + 7000 * 40) / 1e6, 'un modele absent de la grille : facture au plus cher connu');
  }

  console.log('\n-- 2. la consigne --');
  {
    const g = SA.consigne(SA.cibleDe('gauche'), 'swoge');
    ok(/^Image 1 is a frame from a video\. Image 2 shows a character\. Edit image 1: replace ONLY the person on the LEFT side of the frame with the character from image 2\./.test(g), 'gauche : remplacer SEULEMENT la personne de gauche par le personnage de l image 2');
    ok(/exactly the same pose, the same place and the same size in the frame/.test(g) && /same camera angle, with the same framing, lighting, shadows and colour grading/.test(g)
       && /Every other person stays exactly as they are/.test(g) && /Everything else in image 1 stays exactly the same: background, objects, framing and camera/.test(g)
       && /Nothing is kept from the replaced person/.test(g) && /No text, no watermark/.test(g), 'meme pose, place, taille, cadrage, lumiere, decor ; les autres et tout le reste inchanges');
    ok(/cream-beige fur everywhere/.test(g) && /Furry dog paws/.test(g) && /not a realistic wolf-like Shiba/.test(g) && !/real person/.test(g), 'SWOGE decrit (fourrure, pattes, visage Doge)');
    const s = SA.consigne(SA.cibleDe('seule'), 'libre');
    ok(/replace the only person with/.test(s) && !/Every other person/.test(s) && /never gets the face of a real person/.test(s) && !/Doge/.test(s), 'seule personne + personnage du joueur : pas de phrase sur les autres ; jamais le visage d une personne reelle');
    const dd = SA.cibleDe('decrit', '  the man "in" the\nred @cap <b> ');
    ok(dd.ok && dd.decrit === 'the man in the red cap b' && /replace ONLY the person described as: the man in the red cap b with/.test(SA.consigne(dd, 'swoge')), 'une description : guillemets, @, <> et retours retires [' + dd.decrit + ']');
    ok(!SA.cibleDe('decrit', 'ab').ok && !SA.cibleDe('decrit', 'x'.repeat(81)).ok && SA.cibleDe('decrit', 'x'.repeat(80)).ok, 'description : 3 a 80 signes');
    ok(!SA.cibleDe('tous').ok && !SA.cibleDe('chante').ok && !SA.cibleDe(undefined).ok && ['gauche', 'centre', 'droite', 'seule'].every((x) => SA.cibleDe(x).ok), 'les quatre positions seulement (tous, chante, rien : refuses)');
  }

  if (!ffmpegOk) { console.log('ffmpeg absent : la suite reelle est sautee'); fin(); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-apercu-'));
  const V = clip(path.join(tmp, 'v.mp4'), 6, 720, 1280);
  let t = Date.parse('2026-10-15T18:00:00Z');
  const lignes = [];
  let ntx = 0;
  const credit = (dossier) => Credits.cree({ dossier, maintenant: () => t });
  const recharge = (C, a, usd) => C.ajoute(a, usd, { transaction: '0x' + String(++ntx).padStart(64, '0') });
  const A = '0xjoueur_a', B = '0xjoueur_b';
  const SHA_OK = 'a'.repeat(64), PERSO = image(600, 800, 'green');
  const garde = { actif: () => true, verifie: async () => ({ ok: false }), image: (id) => (id === SHA_OK ? { base64: PERSO.toString('base64'), format: 'png' } : null) };
  const fabrique = (dossier, C, O, F, env, o) => SW.cree(Object.assign({ dossier, kling: F.kling, site: 'https://site.example', moi: 'https://srv.example', credits: C, garde,
    journal: (x) => lignes.push(x), maintenant: () => t, pollMs: 1e9, env: Object.assign({}, env || {}), fetchOpenai: O.fetch, cleOpenai: () => CLE }, o || {}));

  console.log('\n-- 3. la requete a OpenAI, le prix, la facture --');
  const d1 = fs.mkdtempSync(path.join(tmp, 'd1-')), C1 = credit(d1);
  const O1 = faussesOpenai(), F1 = fauxKling();
  const M1 = fabrique(d1, C1, O1, F1);
  recharge(C1, A, 10); recharge(C1, B, 0.5);
  const v1 = M1.vue(A);
  ok(v1.apercu && v1.apercu.prixUsd === 1.13 && v1.apercu.max === 6 && v1.apercu.actif === true, 'la vue publique : un apercu 1,13 $ au plus, 6 par video');
  const r1 = await M1.cree(A, fs.createReadStream(V), fs.statSync(V).size, { droits: true, anime: true });
  const e1 = await attendPret(M1, r1.id, A);
  ok(e1.statut === 'pret' && e1.morceaux.length === 1 && e1.anime && e1.anime.clip && M1.vue(A).passeAnime === r1.id, 'video de 6 s en « Animate » : un clip, prete ; passeAnime pour la reprise');
  const sansCible = await M1.apercu(r1.id, A, {});
  ok(!sansCible.ok && sansCible.code === 400 && O1.appels.length === 0 && C1.soldeUsd(A) === 10, 'sans cible : 400, rien chez OpenAI, rien reserve');
  const autre = await M1.apercu(r1.id, B, { cible: 'gauche' });
  ok(!autre.ok && autre.code === 404 && O1.appels.length === 0, 'la passe d une autre adresse : 404');
  /* B : sa propre video, credit de 0,50 $ */
  const rB = await M1.cree(B, fs.createReadStream(V), fs.statSync(V).size, { droits: true, anime: true });
  await attendPret(M1, rB.id, B);
  const pauvre = await M1.apercu(rB.id, B, { cible: 'gauche' });
  ok(!pauvre.ok && pauvre.code === 402 && /\$1\.13 needed, you have \$0\.50/.test(pauvre.raison) && pauvre.manqueUsd === 0.63 && O1.appels.length === 0 && C1.soldeUsd(B) === 0.5,
     'credit de 0,50 $ : 402 (1,13 $ requis, manque 0,63 $), rien chez OpenAI, rien debite');

  O1.reponse = O1.image(864, 1536, 'red');
  const a1 = await M1.apercu(r1.id, A, { cible: 'gauche' });
  ok(a1.ok && a1.apercu.candidats.length === 1 && a1.apercu.candidats[0].statut === 'making' && a1.apercu.candidats[0].prixUsd === 1.13 && C1.soldeUsd(A) === 8.87,
     'Create preview : en cours, 1,13 $ reserves AVANT la reponse (credit 8,87 $)');
  await M1.apercuModule.attend();
  const q = O1.appels[0];
  const ch = q ? q.champs : {};
  ok(O1.appels.length === 1 && q.url === 'https://api.openai.com/v1/images/edits' && q.auth === 'Bearer ' + CLE && /^multipart\/form-data; boundary=/.test(q.type), 'POST /v1/images/edits, multipart, la cle en Bearer');
  ok(ch.model[0] === 'gpt-image-2' && ch.size[0] === '864x1536' && ch.quality[0] === 'high' && ch.n[0] === '1' && ch.output_format[0] === 'png' && !ch.input_fidelity && !ch.image,
     'model gpt-image-2, size 864x1536 (rapport exact), quality high, n 1, png ; pas d input_fidelity (gpt-image-2) ; un tableau = image[]');
  const imgs = ch['image[]'] || [];
  const dPlan = imgs[0] ? K.dimensionsImage(imgs[0].octets) : null;
  ok(imgs.length === 2 && dPlan && dPlan.format === 'png' && dPlan.largeur === 720 && dPlan.hauteur === 1280 && imgs[0].type === 'image/png',
     'image[] 1 = le plan : PNG 720×1280, l image 0 du morceau envoye a Kling');
  ok(imgs[1] && imgs[1].octets.equals(fs.readFileSync(SA.REF_SWOGE)) && imgs[1].type === 'image/jpeg' && fs.readFileSync(SA.REF_SWOGE).length === 164449,
     'image[] 2 = le personnage : le meme « Swole Doge » octet pour octet (references/swoge_meme_ref.jpg)');
  ok(ch.prompt[0] === SA.consigne(SA.cibleDe('gauche'), 'swoge'), 'la consigne envoyee est celle du serveur, cible a gauche');
  const ea = M1.apercuEtat(r1.id, A).apercu, c0 = ea.candidats[0];
  const img0 = M1.apercuFichier(r1.id, A, 0);
  const d0 = img0 ? K.dimensionsImage(img0.octets) : null;
  ok(c0.statut === 'ready' && c0.factureUsd === 0.47 && C1.soldeUsd(A) === 9.53 && d0 && d0.format === 'jpeg' && d0.largeur === 720 && d0.hauteur === 1280 && rouge(pixel(img0.octets, 360, 640)),
     'prete : 0,47 $ factures (usage lu × 2, au cent) sur 1,13 reserves, credit 9,53 $ ; JPEG aux cotes EXACTES 720×1280');
  ok(M1.apercuFichier(r1.id, B, 0) === null && M1.apercuEtat(r1.id, B).apercu === null, 'l image et l etat : a la session qui l a faite seulement');

  console.log('\n-- 4. Regenerate : un refus d OpenAI rend tout ; une seule a la fois --');
  O1.reponse = { statut: 400, corps: { error: { message: 'Your request was rejected by the safety system. key ' + CLE } } };
  const a2 = await M1.apercu(r1.id, A, { cible: 'gauche' });
  const pendant = C1.soldeUsd(A);
  const deux = await M1.apercu(r1.id, A, { cible: 'gauche' });
  await M1.apercuModule.attend();
  ok(a2.ok && pendant === 8.4 && !deux.ok && deux.code === 409 && O1.appels.length === 2, 'Regenerate : 1,13 $ reserves (8,40 $ pendant l appel) ; un second clic pendant ce temps : 409, sans second appel');
  const c1 = M1.apercuEtat(r1.id, A).apercu.candidats[1];
  ok(c1.statut === 'failed' && /OpenAI refused \(HTTP 400\): Your request was rejected by the safety system/.test(c1.message) && /not charged/.test(c1.message) && c1.message.indexOf(CLE) < 0 && c1.factureUsd === 0 && C1.soldeUsd(A) === 9.53,
     'refus d OpenAI : son message tel quel (sans la cle), tout rendu (credit 9,53 $)');
  O1.reponse = () => { throw new Error('reseau coupe'); };
  await M1.apercu(r1.id, A, { cible: 'droite' }); await M1.apercuModule.attend();
  const c2 = M1.apercuEtat(r1.id, A).apercu.candidats[2];
  ok(c2.statut === 'failed' && /OpenAI did not answer/.test(c2.message) && C1.soldeUsd(A) === 9.53, 'OpenAI injoignable : echec dit, tout rendu');

  console.log('\n-- 5. le personnage du joueur : la porte d abord --');
  const avant = O1.appels.length;
  const nonVu = await M1.apercu(r1.id, A, { image: 'b'.repeat(64), cible: 'droite' });
  const url = await M1.apercu(r1.id, A, { image: 'https://ex.com/x.png', cible: 'droite' });
  const autrePerso = await M1.apercu(r1.id, A, { personnage: 'zorro', cible: 'droite' });
  ok(!nonVu.ok && nonVu.code === 400 && /not checked/.test(nonVu.raison) && !url.ok && !autrePerso.ok && O1.appels.length === avant && C1.soldeUsd(A) === 9.53,
     'une image non acceptee par la porte (sha inconnu, URL) ou un personnage inconnu : 400, rien chez OpenAI, rien debite');
  O1.reponse = O1.image(864, 1536, 'red');
  const lib = await M1.apercu(r1.id, A, { image: SHA_OK, cible: 'decrit', qui: 'the drummer' });
  await M1.apercuModule.attend();
  const ql = O1.appels[O1.appels.length - 1].champs;
  ok(lib.ok && ql['image[]'][1].octets.equals(PERSO) && ql['image[]'][1].type === 'image/png' && /described as: the drummer/.test(ql.prompt[0]) && /never gets the face of a real person/.test(ql.prompt[0]),
     'image acceptee : envoyee en image 2 telle quelle, la cible decrite, la phrase « jamais le visage d une personne reelle »');
  ok(M1.apercuEtat(r1.id, A).apercu.candidats[3].personnage === 'libre', 'l apercu garde le personnage choisi (libre)');

  console.log('\n-- 6. « Animate » : seulement un apercu du serveur --');
  const prix = M1.etat(r1.id, A).prixUsdParResolution['720p'];
  ok(prix === 1.52 && F1.envois.length === 0, 'le prix de la video : 6 s entamees × 0,126 × 2 = 1,52 $ (le serveur)');
  const page = await M1.lance(r1.id, A, { still: 'data:image/png;base64,' + image(720, 1280, 'blue').toString('base64'), confirmeUsd: prix, apercu: 0 });
  const rate = await M1.lance(r1.id, A, { apercu: 1, confirmeUsd: prix });
  ok(!page.ok && page.code === 400 && !rate.ok && rate.code === 400 && F1.envois.length === 0 && C1.soldeUsd(A) === 9.06,
     'une image de la page, ou un apercu rate : 400, rien chez Kling, rien reserve');
  const go = await M1.lance(r1.id, A, { apercu: 0, confirmeUsd: prix });
  const env = F1.envois[0] || {};
  ok(go.ok && go.statut === 'en_cours' && F1.envois.length === 1 && rouge(pixel(Buffer.from(env.premiere, 'base64'), 360, 640)) && env.images.length === 2 && /^https:\/\/site\.example\/img\/site\/swoge_meme_ref\.jpg$/.test(env.images[0])
     && env.prompt === ST.texteAnime('images', '') && Math.round(C1.soldeUsd(A) * 100) === Math.round((9.06 - 1.52) * 100),
     'apercu 0 : la premiere image chez Kling (rouge), SWOGE en refer_image, le texte du serveur ; 1,52 $ reserves');
  ok(go.choix && go.choix.apercu === 0 && go.choix.cible === 'gauche' && go.choix.personnage === 'swoge', 'la passe garde l apercu, la cible et le personnage');

  console.log('\n-- 7. bornes : 6 par video, plafond du jour partage --');
  {
    const d2 = fs.mkdtempSync(path.join(tmp, 'd2-')), C2 = credit(d2);
    const O2 = faussesOpenai(); O2.reponse = { statut: 500, corps: { error: { message: 'boom' } } };
    const M2 = fabrique(d2, C2, O2, fauxKling());
    recharge(C2, A, 20);
    const r = await M2.cree(A, fs.createReadStream(V), fs.statSync(V).size, { droits: true, anime: true });
    await attendPret(M2, r.id, A);
    for (let k = 0; k < 6; k++) { await M2.apercu(r.id, A, { cible: 'seule' }); await M2.apercuModule.attend(); }
    const sept = await M2.apercu(r.id, A, { cible: 'seule' });
    ok(O2.appels.length === 6 && !sept.ok && sept.code === 429 && /6 pictures per video/.test(sept.raison) && C2.soldeUsd(A) === 20, 'la 7e image : 429, sans appel ; les six rates rendus (credit 20 $)');
    const d3 = fs.mkdtempSync(path.join(tmp, 'd3-')), C3 = credit(d3);
    const O3 = faussesOpenai(); O3.reponse = O3.image(864, 1536, 'red');
    const M3 = fabrique(d3, C3, O3, fauxKling(), { SWAP_PLAFOND_JOUR_USD: '0.5' });
    recharge(C3, A, 20);
    const r3 = await M3.cree(A, fs.createReadStream(V), fs.statSync(V).size, { droits: true, anime: true });
    await attendPret(M3, r3.id, A);
    const plein = await M3.apercu(r3.id, A, { cible: 'seule' });
    ok(!plein.ok && plein.code === 429 && /spending limit for today/.test(plein.raison) && O3.appels.length === 0 && C3.soldeUsd(A) === 20, 'plafond du jour 0,50 $ < pire cas 0,562 $ : 429, rien chez OpenAI, rien debite');
  }

  console.log('\n-- 8. le proprietaire : sans paiement, plafond par jour --');
  {
    const O4 = faussesOpenai(); O4.reponse = O4.image(1024, 1536, 'red', 80);
    const dP = fs.mkdtempSync(path.join(tmp, 'p-'));
    const P = SA.cree({ dossier: dP, fetch: O4.fetch, cle: () => CLE, modele: 'gpt-image-1.5', parJour: 2, journal: (x) => lignes.push(x), maintenant: () => t });
    const src = path.join(tmp, 'seg.mp4'); clip(src, 4, 720, 1280);
    const ka = 'kling_' + 'c'.repeat(24);
    const p1 = await P.demande('0xproprio', { cle: ka, chemin: src, cotes: { largeur: 720, hauteur: 1280 }, cible: 'seule', perso: { id: 'swoge' } });
    await P.attend();
    const ch4 = O4.appels[0].champs;
    const fi = P.fichier(ka, '0xproprio', 0);
    ok(p1.ok && ch4.size[0] === '1024x1536' && ch4.input_fidelity[0] === 'high' && ch4.model[0] === 'gpt-image-1.5', 'gpt-image-1.5 : 1024×1536 (la plus proche) et input_fidelity high');
    const dfi = fi && K.dimensionsImage(fi.octets);
    ok(dfi && dfi.largeur === 720 && dfi.hauteur === 1280 && rouge(pixel(fi.octets, 2, 640)) && rouge(pixel(fi.octets, 717, 640)),
       'recadrage CENTRE puis echelle : 720×1280 exact, les bandes bleues des bords (80 px) parties');
    ok(P.etat(ka, '0xproprio', false).apercu.candidats[0].coutUsd === SA.coutUsd('gpt-image-1.5', { input_tokens: 3000, input_tokens_details: { text_tokens: 500, image_tokens: 2500 }, output_tokens: 7000 }) && P.etat(ka, '0xproprio', false).apercu.candidats[0].prixUsd === undefined,
       'proprietaire : le cout OpenAI lu est montre, aucun prix joueur');
    await P.demande('0xproprio', { cle: ka, chemin: src, cotes: { largeur: 720, hauteur: 1280 }, cible: 'seule', perso: { id: 'swoge' } }); await P.attend();
    const p3 = await P.demande('0xproprio', { cle: ka, chemin: src, cotes: { largeur: 720, hauteur: 1280 }, cible: 'seule', perso: { id: 'swoge' } });
    ok(!p3.ok && p3.code === 429 && /2 pictures per day/.test(p3.raison) && O4.appels.length === 2, 'proprietaire : 2 images par jour ici (30 par defaut), la 3e : 429 sans appel');
    const sansCle = SA.cree({ dossier: fs.mkdtempSync(path.join(tmp, 'k-')), fetch: O4.fetch, cle: () => '' });
    const nk = await sansCle.demande('0xproprio', { cle: ka, chemin: src, cotes: { largeur: 720, hauteur: 1280 }, cible: 'seule', perso: { id: 'swoge' } });
    ok(!nk.ok && nk.code === 503 && /OPENAI_API_KEY/.test(nk.raison) && O4.appels.length === 2, 'sans cle : 503, dit, aucun appel');
  }

  console.log('\n-- 9. le redemarrage --');
  {
    const d5 = fs.mkdtempSync(path.join(tmp, 'd5-')), C5 = credit(d5);
    const O5 = faussesOpenai(); let lache = null;
    O5.reponse = O5.image(864, 1536, 'red');
    const M5 = fabrique(d5, C5, O5, fauxKling());
    recharge(C5, A, 10);
    const r = await M5.cree(A, fs.createReadStream(V), fs.statSync(V).size, { droits: true, anime: true });
    await attendPret(M5, r.id, A);
    await M5.apercu(r.id, A, { cible: 'centre' }); await M5.apercuModule.attend();
    /* la seconde ne repond jamais : le processus « meurt » pendant l'appel */
    const O5b = { fetch: () => new Promise((res) => { lache = res; }) };
    const M5b = fabrique(d5, C5, O5b, fauxKling());
    await M5b.apercu(r.id, A, { cible: 'centre' });
    const avantArret = C5.soldeUsd(A);
    M5.arrete(); M5b.arrete();
    const C6 = credit(d5);
    const M6 = fabrique(d5, C6, faussesOpenai(), fauxKling());
    const b = M6.reprendReserves(C6.durables());
    const e6 = M6.apercuEtat(r.id, A).apercu;
    ok(avantArret === 8.4 && b.apercusRendus === 1 && C6.soldeUsd(A) === 9.53 && e6.candidats.length === 2 && e6.candidats[0].statut === 'ready' && e6.candidats[1].statut === 'failed' && /restart/.test(e6.candidats[1].message),
       'apres un redemarrage : l apercu pret se relit (reprise de la page) ; celui coupe en vol est rendu (9,53 $)');
    ok(M6.apercuFichier(r.id, A, 0) && M6.vue(A).passeAnime === r.id, 'l image et la passe se relisent apres le redemarrage');
    if (lache) lache(new Response('{}'));
  }

  console.log('\n-- 10. la cle --');
  const tout = JSON.stringify(lignes);
  ok(tout.indexOf(CLE) < 0 && lignes.some((x) => x.apercu && x.usage && x.coutUsd === 0.2325) && lignes.some((x) => x.apercu && x.refus === 'credit'),
     'la cle OpenAI n est dans aucune ligne du journal ; le journal porte usage, cout et refus');
  fin();
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
