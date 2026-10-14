'use strict';
/* ============================================================================
 * SWOGE SWAP — LE MOTEUR DE LA VIDEO ENTIERE OUVERT AUX JOUEURS (swap.js, 14/10/2026)
 *
 * Ce qui DOIT tenir :
 *   1. Le prix montre = pire cas Kling × SWAP_MARGE, au cent superieur, 720p ;
 *      les bornes de l'environnement (marge, Mo, secondes, file, plafond du jour).
 *   2. N'importe quelle adresse (pas seulement le proprietaire) televerse, avec la
 *      case cochee — sans elle, rien n'est lu ; au-dela de la taille ou de la
 *      duree : refuse.
 *   3. Seuls nos personnages : une image ou un texte envoyes quand meme sont
 *      REFUSES avant tout appel ; le texte de Kling est celui de la maison.
 *   4. Le credit : reserve au lancement (durable), credit trop bas = 402 sans
 *      appel ni debit ; regle sur les morceaux livres ; un morceau rate a une
 *      relance gratuite, puis garde l'image d'origine et n'est pas facture ;
 *      rien de livre = tout rendu ; annuler dans la file = tout rendu.
 *   5. Une passe par adresse ; SWAP_PARALLELE passes chez Kling, les autres en
 *      file avec leur rang ; le plafond du jour refuse sans debit.
 *   6. Le resultat et l'etat ne sortent que pour l'adresse qui l'a lance.
 *   7. Un redemarrage garde la reserve d'une passe vivante, rend une reserve
 *      orpheline ; une passe vivante rafraichit sa reserve.
 *   8. Le proprietaire : rien ne change (ses vues n'ont aucun champ public).
 * Kling est simule (aucun appel reel), ffmpeg est le vrai, le credit est le vrai
 * module credits.js sur un dossier jetable.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const SW = require('./swap');
const KE = require('./kling_entier');
const K = require('./kling');
const Credits = require('./credits');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const proche = (a, b, e) => Math.abs(a - b) <= e;

const ffmpegOk = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const duree = (f) => Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', f]).toString()).format.duration);

function fabrique(f, plans) {
  const srcs = ['testsrc2', 'mandelbrot', 'rgbtestsrc', 'testsrc', 'smptehdbars'];
  const args = ['-v', 'error', '-y'];
  plans.forEach((d, k) => args.push('-f', 'lavfi', '-t', String(d), '-i', srcs[k % srcs.length] + '=size=720x1280:rate=25'));
  const tot = plans.reduce((a, b) => a + b, 0);
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=' + tot);
  args.push('-filter_complex', plans.map((_, k) => '[' + k + ':v]').join('') + 'concat=n=' + plans.length + ':v=1:a=0[v]', '-map', '[v]', '-map', plans.length + ':a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f);
  execFileSync('ffmpeg', args);
  return f;
}

/* Kling simule (celui de kling_entier.test.js) : il lit le morceau a son URL publique et le rend tel quel. */
function faux(M) {
  const F = { envois: [], taches: {}, externes: {}, cdn: [] };
  F.kling = {
    actif: () => true,
    lanceEdition: async (q) => {
      const nom = q.videoUrl.split('/').pop();
      const f = M().fichier(nom);
      F.envois.push(Object.assign({}, q, { lu: !!f }));
      const id = 'T' + F.envois.length;
      F.taches[id] = { statut: 'processing', octets: f ? f.octets : null, nom, dureeS: q.dureeS };
      if (q.externe) F.externes[q.externe] = id;
      return { ok: true, id, externe: q.externe, modele: 'kling-o1', resolution: q.resolution, audio: q.audio, dureeS: q.dureeS, estimationUsd: K.prixEdition(q.resolution, q.dureeS), images: q.images.map(() => 'url') };
    },
    etat: async (id) => {
      const t = F.taches[id]; if (!t) return { ok: false, code: 404 };
      if (t.statut === 'succeeded') return { ok: true, id, statut: 'succeeded', url: 'https://p2-kling.klingai.com/r/' + id + '.mp4', duree: t.dureeS, facturation: [{ type: 'unit', montant: '1', devise: 'video' }] };
      if (t.statut === 'failed') return { ok: true, id, statut: 'failed', message: 'content risk', facturation: null };
      return { ok: true, id, statut: 'processing' };
    },
    etatExterne: async (x) => (F.externes[x] ? F.kling.etat(F.externes[x]) : { ok: false, code: 404, raison: 'unknown task' }),
  };
  F.fetchCdn = async (u) => {
    F.cdn.push(u);
    const id = /\/r\/(T\d+)\.mp4$/.exec(u); const t = id && F.taches[id[1]];
    if (!t || !t.octets) return { status: 404, ok: false, headers: { get: () => null } };
    return { status: 200, ok: true, headers: { get: (h) => (h === 'content-length' ? String(t.octets.length) : null) }, arrayBuffer: async () => t.octets };
  };
  /* finit les taches en cours dont le morceau source passe le filtre */
  F.finit = (statut, quoi) => { for (const t of Object.values(F.taches)) if (t.statut === 'processing' && (!quoi || quoi(t))) t.statut = statut; };
  return F;
}

const flux = (f) => fs.createReadStream(f);
async function attend(M, id, addr, statuts, max) {
  for (let k = 0; k < (max || 400); k++) {
    const e = M.etat(id, addr);
    if (statuts.includes(e.statut)) return e;
    await M.attend(id); await M.tour(); await new Promise((r) => setTimeout(r, 25));
  }
  return M.etat(id, addr);
}

(async () => {
  console.log('-- 1. le prix et les bornes (calcul) --');
  {
    ok(SW.prixClient(1.764, 2) === 3.53 && SW.prixClient(4.032, 2) === 8.07 && SW.prixClient(0.882, 2) === 1.77 && SW.prixClient(1.26, 2) === 2.52 && SW.prixClient(7.938, 2) === 15.88,
       'pire cas × 2 au cent superieur : 1,764 → 3,53 ; 4,032 → 8,07 ; 1,26 → 2,52 (exact, pas 2,53) ; 7,938 → 15,88');
    const r0 = SW.reglages({});
    ok(r0.marge === 2 && r0.moMax === 60 && r0.dureeMaxS === 60 && r0.parallele === 2 && r0.plafondJourUsd === 50, 'defauts : marge 2, 60 Mo, 60 s, 2 passes, 50 $ par jour');
    const r1 = SW.reglages({ SWAP_MARGE: '0.5', SWAP_MO_MAX: '500', SWAP_DUREE_MAX_S: '2', SWAP_PARALLELE: '20', SWAP_PLAFOND_JOUR_USD: '-1' });
    ok(r1.marge === 2 && r1.moMax === 60 && r1.dureeMaxS === 60 && r1.parallele === 2 && r1.plafondJourUsd === 50, 'hors bornes (marge < 1, > 100 Mo, < 3 s, > 8 passes, plafond negatif) : les defauts');
    const r2 = SW.reglages({ SWAP_MARGE: '3', SWAP_MO_MAX: '20', SWAP_DUREE_MAX_S: '30', SWAP_PARALLELE: '4', SWAP_PLAFOND_JOUR_USD: '0' });
    ok(r2.marge === 3 && r2.moMax === 20 && r2.dureeMaxS === 30 && r2.parallele === 4 && r2.plafondJourUsd === 0, 'dans les bornes : pris tels quels (0 $ par jour ferme le service)');
    const p = SW.prompt(SW.PERSONNAGES[0], SW.CIBLES.find((c) => c.id === 'chante'));
    ok(/^Replace the person who is singing or talking in @video_1 with the character of @image_1 \(body: huge muscular shirtless Swole Doge/.test(p) && /face of @image_2/.test(p)
       && /Keep every other person, the camera, the background and the original audio unchanged\.$/.test(p), 'le texte de Kling : celui du proprietaire, la cible remplacee');
    const pt = SW.prompt(SW.PERSONNAGES[0], SW.CIBLES.find((c) => c.id === 'tous'));
    ok(/^Replace every person in @video_1/.test(pt) && /Keep the camera, the background/.test(pt) && pt.length <= K.TEXTE_MAX, 'tout le monde : « Keep the camera… », sous ' + K.TEXTE_MAX + ' signes');
    ok(SW.CIBLES.map((c) => c.id).join() === 'chante,gauche,droite,tous' && SW.PERSONNAGES[0].images.join() === '/img/site/swoge_swole_ref.jpg,/img/site/swoge_face_ref.jpg',
       'quatre cibles ; SWOGE = corps (image_1) puis visage (image_2)');
  }

  if (!ffmpegOk) { console.log('ffmpeg absent : la suite reelle est sautee'); console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe')); process.exit(rates ? 1 : 0); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-'));
  const V = { deux: fabrique(path.join(tmp, 'deux.mp4'), [7, 7]), long: fabrique(path.join(tmp, 'long.mp4'), [7, 7, 7]) };
  let t = Date.parse('2026-10-14T10:00:00Z');
  const lignes = [];
  const SITE = 'https://site.example';
  /* un credit neuf par essai, et un solde de depart sans x402 : ajoute() comme une recharge */
  let ntx = 0;
  const credit = (dossier) => Credits.cree({ dossier, maintenant: () => t });
  const recharge = (C, a, usd) => C.ajoute(a, usd, { transaction: '0x' + String(++ntx).padStart(64, '0') });
  const fabriqueM = (dossier, F, C, env, o) => SW.cree(Object.assign({ dossier, kling: F.kling, site: SITE, moi: 'https://srv.example', credits: C,
    journal: (x) => lignes.push(x), fetchCdn: F.fetchCdn, maintenant: () => t, pollMs: 1e9, env: Object.assign({}, env || {}) }, o || {}));
  const A = '0xjoueur_a', B = '0xjoueur_b', Cx = '0xjoueur_c';

  console.log('\n-- 2. le televersement : toute adresse, la case, les bornes --');
  const d1 = fs.mkdtempSync(path.join(tmp, 'd1-')), C1 = credit(d1);
  let M1 = null; const F1 = faux(() => M1); M1 = fabriqueM(d1, F1, C1, { SWAP_DUREE_MAX_S: '15' });
  let P1;
  {
    ok((await M1.cree(A, flux(V.deux))).code === 400 && (await M1.cree(A, flux(V.deux), null, { droits: false })).code === 400 && fs.readdirSync(d1).filter((x) => /^[0-9a-f]{24}$/.test(x)).length === 0,
       'sans la case cochee : 400, rien ecrit');
    ok((await M1.cree(A, flux(V.deux), 61 * 1048576, { droits: true })).code === 413, 'plus de 60 Mo annonces : 413 sans lire');
    const rl = await M1.cree(A, flux(V.long), null, { droits: true });
    const el = await attend(M1, rl.id, A, ['erreur', 'pret']);
    ok(el.statut === 'erreur' && /15 s at most/.test(el.message), 'plus long que SWAP_DUREE_MAX_S (15 s pour l essai) : refuse [' + el.message + ']');
    const r = await M1.cree(A, flux(V.deux), null, { droits: true });
    ok(r.ok && r.statut === 'decoupe', 'une adresse quelconque (pas le proprietaire) televerse');
    const e = await attend(M1, r.id, A, ['pret', 'erreur']);
    ok(e.statut === 'pret' && e.morceaux.length === 2 && e.prixUsd === 3.53 && e.prixPire === null && e.plafondUsd === undefined && e.morceaux.every((m) => m.estimationUsd === undefined),
       'plan : 2 morceaux de 7 s, prix montre 3,53 $ (1,764 $ × 2) ; aucun cout Kling dans la vue publique');
    P1 = M1.PASSES.get(r.id);
    ok(P1.droits && P1.droits.accepte === true && P1.droits.texte === SW.DROITS_TEXTE && e.droits === true && lignes.some((x) => x.swap && x.plan && x.entier === r.id && x.droits === true && x.prixUsd === 3.53),
       'la case est gardee avec la passe (texte et heure) et au journal du plan');
    ok(M1.etat(r.id, B).code === 404, 'l etat : 404 pour une autre adresse');
  }

  console.log('\n-- 3. seulement nos personnages, le prix confirme, le credit --');
  {
    const id = P1.id;
    const base = { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 };
    const r1 = await M1.lance(id, A, Object.assign({}, base, { images: ['https://evil.example/face.jpg'] }));
    const r2 = await M1.lance(id, A, Object.assign({}, base, { prompt: 'Replace the man with @image_1' }));
    const r3 = await M1.lance(id, A, Object.assign({}, base, { images: 'data:image/png;base64,AAAA' }));
    const r4 = await M1.lance(id, A, Object.assign({}, base, { resolution: '1080p' }));
    ok(r1.code === 400 && r2.code === 400 && r3.code === 400 && /not accepted/.test(r1.raison) && r4.code === 400, 'une image, un texte, une data-URL ou du 1080p envoyes quand meme : 400 [' + r1.raison + ']');
    ok((await M1.lance(id, A, Object.assign({}, base, { personnage: 'elon' }))).code === 400 && (await M1.lance(id, A, Object.assign({}, base, { cible: 'le-voisin' }))).code === 400, 'un personnage ou une cible hors liste : 400');
    const r5 = await M1.lance(id, A, Object.assign({}, base, { confirmeUsd: 1.764 }));
    ok(r5.code === 409 && /\$3\.53/.test(r5.raison), 'le pire cas Kling au lieu du prix montre : 409 [' + r5.raison + ']');
    recharge(C1, A, 2);
    const r6 = await M1.lance(id, A, base);
    ok(r6.code === 402 && /\$3\.53 needed, you have \$2\.00/.test(r6.raison) && r6.manqueUsd === 1.53 && C1.soldeUsd(A) === 2 && C1.etat().ouvertes === 0, 'credit de 2 $ : 402 (manque 1,53 $), rien reserve ni debite [' + r6.raison + ']');
    ok(F1.envois.length === 0 && M1.etat(id, A).statut === 'pret', 'aucun de ces refus n a appele Kling ; le plan attend toujours');
    ok((await M1.lance(id, B, base)).code === 404, 'lancer le plan d un autre : 404');
    recharge(C1, A, 10);
    const r7 = await M1.lance(id, A, base);
    ok(r7.ok && r7.statut === 'en_cours' && r7.paiement && r7.paiement.reserveUsd === 3.53 && proche(C1.soldeUsd(A), 12 - 3.53, 1e-9) && C1.etat().durables === 1,
       'credit de 12 $ : 3,53 $ reserves (reserve DURABLE), reste ' + C1.soldeUsd(A) + ' $');
    const d = C1.durables()[0];
    ok(d.info.genre === 'swap' && d.info.id === id && d.addr === A, 'la reserve porte sa passe (genre swap, id)');
    ok(F1.envois.length === 2 && F1.envois.every((q) => q.lu && q.resolution === '720p' && q.audio === 'original' && JSON.stringify(q.images) === JSON.stringify([SITE + '/img/site/swoge_swole_ref.jpg', SITE + '/img/site/swoge_face_ref.jpg'])
       && q.prompt === SW.prompt(SW.PERSONNAGES[0], SW.CIBLES[0])), 'Kling recoit les 2 morceaux, 720p, son d origine, le corps et le visage de SWOGE par URL, le texte de la maison');
    ok(lignes.some((x) => x.swap && x.paiement === 'reserve' && x.entier === id && x.prixUsd === 3.53 && x.personnage === 'swoge' && x.cible === 'chante'), 'journal : la reserve, le personnage, la cible');
  }

  console.log('\n-- 4. une passe par adresse ; la file --');
  const d2 = fs.mkdtempSync(path.join(tmp, 'd2-')), C2 = credit(d2);
  let M2 = null; const F2 = faux(() => M2); M2 = fabriqueM(d2, F2, C2, { SWAP_PARALLELE: '1' });
  let PA, PB, PC;
  {
    ok((await M1.cree(A, flux(V.deux), null, { droits: true })).code === 429, 'une seconde video pendant la premiere : 429');
    recharge(C2, A, 10); recharge(C2, B, 10); recharge(C2, Cx, 10);
    const ids = {};
    for (const a of [A, B, Cx]) { const r = await M2.cree(a, flux(V.deux), null, { droits: true }); ids[a] = r.id; await attend(M2, r.id, a, ['pret']); }
    const la = await M2.lance(ids[A], A, { personnage: 'swoge', cible: 'gauche', confirmeUsd: 3.53 });
    const lb = await M2.lance(ids[B], B, { personnage: 'swoge', cible: 'droite', confirmeUsd: 3.53 });
    const lc = await M2.lance(ids[Cx], Cx, { personnage: 'swoge', cible: 'tous', confirmeUsd: 3.53 });
    ok(la.statut === 'en_cours' && lb.statut === 'file' && lb.file === 1 && lc.statut === 'file' && lc.file === 2, 'SWAP_PARALLELE=1 : A chez Kling, B 1er en file, C 2e');
    ok(F2.envois.length === 2 && F2.envois.every((q) => /the person on the left of the frame/.test(q.prompt)) && proche(C2.soldeUsd(B), 6.47, 1e-9), 'seuls les morceaux de A partent ; B est deja reserve (place payee)');
    ok(M2.vue(B).enFile === 2 && M2.vue(B).occupees === 1, 'la page lit la file (2) et les places prises (1)');
    const ab = M2.abandonne(ids[Cx], Cx);
    ok(ab.ok && ab.statut === 'abandon' && proche(C2.soldeUsd(Cx), 10, 1e-9) && ab.paiement.renduUsd === 3.53, 'annuler dans la file : 3,53 $ rendus');
    F2.finit('succeeded'); t += 2000; await M2.tour();
    const ea = await attend(M2, ids[A], A, ['fini', 'incomplet']);
    await M2.tour();
    ok(ea.statut === 'fini' && M2.etat(ids[B], B).statut === 'en_cours' && F2.envois.length === 4 && F2.envois.slice(2).every((q) => /on the right/.test(q.prompt)), 'A fini : B sort de la file et part chez Kling');
    ok(lignes.some((x) => x.swap && x.sortieFile && x.entier === ids[B]), 'journal : la sortie de file');
    PA = M2.PASSES.get(ids[A]); PB = M2.PASSES.get(ids[B]); PC = ids[Cx];
    ok(proche(C2.soldeUsd(A), 6.47, 1e-9) && ea.paiement.factureUsd === 3.53 && ea.paiement.renduUsd === 0, 'A regle : tout livre, 3,53 $ factures, rien a rendre');
  }

  console.log('\n-- 5. le resultat, a son adresse seulement --');
  {
    const res = M2.resultat(PA.id, A);
    ok(res && /^swoge_swap_/.test(res.nom) && proche(duree(res.chemin), 14, 0.15) && M2.etat(PA.id, A).video === '/studio/swap/' + PA.id + '/video', 'le resultat : ' + (res && duree(res.chemin)) + ' s pour 14 s, annonce sous /studio/swap/<id>/video');
    ok(M2.resultat(PA.id, B) === null && M2.etat(PA.id, B).code === 404, 'une autre adresse : ni l etat ni le resultat');
    ok(Number(M2.etat(PA.id, A).expire) === Number(PA.t) + 48 * 3600e3, 'garde 48 h a partir de la fin');
  }

  console.log('\n-- 6. un morceau rate : une relance gratuite, puis l image d origine, rendue --');
  {
    /* B : le morceau 2 rate deux fois, le 1er reussit */
    const s2 = PB.segments[1].fichier;
    F2.finit('failed', (x) => x.nom === s2); F2.finit('succeeded'); t += 2000; await M2.tour();
    let e = M2.etat(PB.id, B);
    ok(e.statut === 'incomplet' && e.morceaux[1].statut === 'failed' && e.morceaux[1].rejouable && e.morceaux[1].relanceGratuite && e.morceaux[0].statut === 'done', 'le 2e rate : la passe attend, une relance gratuite offerte');
    const avantSolde = C2.soldeUsd(B), avantEnvois = F2.envois.length;
    const rr = await M2.relance(PB.id, B, 1);
    ok(rr.ok && F2.envois.length === avantEnvois + 1 && C2.soldeUsd(B) === avantSolde, 'la relance repart chez Kling, sans rien debiter de plus');
    F2.finit('failed'); t += 2000; await M2.tour();
    e = await attend(M2, PB.id, B, ['fini', 'erreur']);
    ok(e.statut === 'fini' && e.morceaux[1].statut === 'original' && /refunded/.test(e.morceaux[1].message), 'la relance rate aussi : la video se finit seule, la part 2 garde l image d origine');
    ok((await M2.relance(PB.id, B, 1)).code === 409, 'pas de seconde relance');
    const res = M2.resultat(PB.id, B);
    ok(res && proche(duree(res.chemin), 14, 0.15), 'le resultat recolle (un morceau de Kling, un d origine) : ' + (res && duree(res.chemin)) + ' s');
    /* livre : 7 s → 0,882 $ chez Kling × 2 = 1,77 $ ; rendu 3,53 - 1,77 = 1,76 $ */
    ok(e.paiement.factureUsd === 1.77 && e.paiement.renduUsd === 1.76 && proche(C2.soldeUsd(B), 10 - 1.77, 1e-9) && C2.etat().ouvertes === 0,
       'regle sur le morceau livre seul : 1,77 $ factures, 1,76 $ rendus, solde ' + C2.soldeUsd(B) + ' $');
    const lr = lignes.filter((x) => x.swap && x.entier === PB.id && x.paiement === 'regle')[0];
    ok(lr && lr.morceauxLivres === 1 && lr.morceaux === 2 && lr.depenseKlingUsd === 0.882 * 3 && lignes.some((x) => x.entier === PB.id && x.relance && x.gratuite),
       'journal : le reglement (1 morceau livre sur 2, 3 envois chez Kling), la relance gratuite');
  }

  console.log('\n-- 7. rien de livre : tout rendu ; « finir maintenant » --');
  {
    const d3 = fs.mkdtempSync(path.join(tmp, 'd3-')), C3 = credit(d3);
    let M3 = null; const F3 = faux(() => M3); M3 = fabriqueM(d3, F3, C3, {});
    recharge(C3, A, 5); recharge(C3, B, 5);
    const r = await M3.cree(A, flux(V.deux), null, { droits: true }); await attend(M3, r.id, A, ['pret']);
    await M3.lance(r.id, A, { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 });
    F3.finit('failed'); t += 2000; await M3.tour();
    await M3.relance(r.id, A, 0); await M3.relance(r.id, A, 1);
    F3.finit('failed'); t += 2000; await M3.tour();
    const e = await attend(M3, r.id, A, ['erreur', 'fini']);
    ok(e.statut === 'erreur' && /fully refunded/.test(e.message) && C3.soldeUsd(A) === 5 && e.paiement.factureUsd === 0, 'tout rate, relances comprises : erreur, les 3,53 $ rendus');
    /* B : un rate, le joueur finit sans relancer */
    const rb = await M3.cree(B, flux(V.deux), null, { droits: true }); await attend(M3, rb.id, B, ['pret']);
    await M3.lance(rb.id, B, { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 });
    const PBb = M3.PASSES.get(rb.id);
    F3.finit('failed', (x) => x.nom === PBb.segments[0].fichier); F3.finit('succeeded'); t += 2000; await M3.tour();
    ok(M3.termine(rb.id, A).code === 404, 'finir la video d un autre : 404');
    const tm = M3.termine(rb.id, B);
    const eb = await attend(M3, rb.id, B, ['fini', 'erreur']);
    ok(tm.ok && eb.statut === 'fini' && eb.morceaux[0].statut === 'original' && eb.paiement.factureUsd === 1.77 && proche(C3.soldeUsd(B), 5 - 1.77, 1e-9), '« Finish now » : la part ratee garde l image d origine, 1,77 $ factures');
    ok(M3.abandonne(rb.id, B).ok && !M3.PASSES.has(rb.id), 'supprimer un resultat fini');
  }

  console.log('\n-- 8. le plafond du jour --');
  {
    const d4 = fs.mkdtempSync(path.join(tmp, 'd4-')), C4 = credit(d4);
    let M4 = null; const F4 = faux(() => M4); M4 = fabriqueM(d4, F4, C4, { SWAP_PLAFOND_JOUR_USD: '3' });
    recharge(C4, A, 10); recharge(C4, B, 10);
    const ra = await M4.cree(A, flux(V.deux), null, { droits: true }); await attend(M4, ra.id, A, ['pret']);
    const rb = await M4.cree(B, flux(V.deux), null, { droits: true }); await attend(M4, rb.id, B, ['pret']);
    ok((await M4.lance(ra.id, A, { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 })).ok, 'plafond 3 $ : une passe de 1,764 $ chez Kling passe');
    const n0 = F4.envois.length;
    const lb = await M4.lance(rb.id, B, { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 });
    ok(lb.code === 429 && /spending limit for today/.test(lb.raison) && /not charged/.test(lb.raison) && C4.soldeUsd(B) === 10 && F4.envois.length === n0 && M4.etat(rb.id, B).statut === 'pret',
       'la seconde (1,764 + 1,764 > 3) : 429, rien reserve, rien chez Kling [' + lb.raison + ']');
    ok(M4.vue(B).ouvertAujourdhui === true && JSON.parse(fs.readFileSync(path.join(d4, 'jour.json'), 'utf8')).usd === 1.764, 'le jour engage 1,764 $ (sur le disque)');
    t += 24 * 3600e3;
    ok((await M4.lance(rb.id, B, { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 })).ok, 'le lendemain (UTC) : elle passe');
    const d5 = fs.mkdtempSync(path.join(tmp, 'd5-'));
    let M5 = null; const F5 = faux(() => M5); M5 = fabriqueM(d5, F5, credit(d5), { SWAP_PLAFOND_JOUR_USD: '0' });
    ok(M5.vue(A).ouvertAujourdhui === false, 'SWAP_PLAFOND_JOUR_USD=0 : ferme, la page le lit');
  }

  console.log('\n-- 9. le redemarrage --');
  {
    const d6 = fs.mkdtempSync(path.join(tmp, 'd6-')), C6 = credit(d6);
    let courant = null; const F6 = faux(() => courant);
    /* 90 min d'arret : au-dela des 20 min d'un morceau ; le suivi par morceau n'est pas l'objet ici */
    const LONG = { morceauMaxMs: 3 * 3600e3 };
    const Ma = fabriqueM(d6, F6, C6, {}, LONG); courant = Ma;
    recharge(C6, A, 10);
    const r = await Ma.cree(A, flux(V.deux), null, { droits: true }); await attend(Ma, r.id, A, ['pret']);
    await Ma.lance(r.id, A, { personnage: 'swoge', cible: 'chante', confirmeUsd: 3.53 });
    /* une reserve orpheline (sa passe a disparu) */
    const orphe = C6.soldeDurable('swoge swap').reserve(A, 1000000n * 10n ** 12n, { genre: 'swap', id: 'f'.repeat(24) });
    Ma.arrete();
    t += 90 * 60e3;
    const C6b = credit(d6);   /* le credit relu du disque : les deux reserves ont moins de 2 h */
    ok(C6b.etat().durables === 2 && proche(C6b.soldeUsd(A), 10 - 3.53 - 1, 1e-9), 'apres l arret : les deux reserves durables sont gardees (moins de 2 h)');
    const Mb = fabriqueM(d6, F6, C6b, {}, LONG); courant = Mb;
    const b = Mb.reprendReserves(C6b.durables());
    ok(b.gardees === 1 && b.rendues === 1 && proche(C6b.soldeUsd(A), 10 - 3.53, 1e-9) && C6b.etat().durables === 1 && orphe, 'reprise : la reserve de la passe vivante gardee, l orpheline rendue (1 $)');
    const avantT = C6b.durables()[0].t;
    await Mb.tour();
    ok(C6b.durables()[0].t > avantT, 'la passe vivante rafraichit sa reserve (elle ne sera pas rendue a 2 h)');
    F6.finit('succeeded'); t += 2000; await Mb.tour();
    const e = await attend(Mb, r.id, A, ['fini', 'incomplet']);
    ok(e.statut === 'fini' && proche(C6b.soldeUsd(A), 10 - 3.53, 1e-9) && C6b.etat().ouvertes === 0, 'la passe reprise se termine et se regle une fois (3,53 $)');
  }

  console.log('\n-- 10. le proprietaire ne change pas --');
  {
    const d7 = fs.mkdtempSync(path.join(tmp, 'd7-'));
    let M7 = null; const F7 = faux(() => M7);
    M7 = KE.cree({ dossier: d7, kling: F7.kling, urlPublique: (nom) => 'https://srv.example' + KE.VIDEO_PREFIXE + nom, imagesDefaut: [SITE + '/a.jpg', SITE + '/b.jpg'],
      journal: (x) => lignes.push(x), fetchCdn: F7.fetchCdn, maintenant: () => t, pollMs: 1e9 });
    const r = await M7.cree('0xowner', flux(V.deux));
    const e = await attend(M7, r.id, '0xowner', ['pret']);
    ok(r.ok && e.prixPire['720p'] === 1.764 && e.plafondUsd === 20 && !('prixUsd' in e) && !('paiement' in e) && !('droits' in e), 'le proprietaire : sans case, son plan au pire cas Kling, aucun champ public');
    const l = await M7.lance(r.id, '0xowner', { prompt: 'x', confirmeUsd: 1.764 });
    ok(l.ok && l.statut === 'en_cours' && F7.envois.length === 2 && F7.envois[0].prompt === 'x', 'il lance avec SON texte, sans credit ni file');
    ok(!lignes.some((x) => x.entier === r.id && x.swap), 'son journal ne porte pas la marque swap');
    ok(M7.vue('0xowner').octetsMax === 100 * 1048576 && M7.vue('0xowner').dureeEntierMaxS === 180, 'ses bornes : 100 Mo, 180 s');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
