'use strict';
/* ============================================================================
 * LA CHAINE DES PLANCHES ISO, DE BOUT EN BOUT, HORS LIGNE (0 $)
 *
 * De faux clips du mannequin (outils/planches/guide.js), encodes en H.264
 * 4:2:0 par ffmpeg sur fond magenta comme un vrai clip, traversent TOUTE la
 * chaine : decoupe des 4 emplacements, detourage, transformation tiree de la
 * pose, choix des images, controles, planches WebP et fiche JSON.
 *
 * Ce qu'elle DOIT tenir :
 *   1. le vrai mannequin (5 actions x 4 directions) passe TOUS les controles ;
 *      la planche du jeu fait 8 colonnes x 4 lignes de 256, sans perte (VP8L) ;
 *      la HD 16 colonnes x 4 lignes de 512 ; la fiche dit tout ce que
 *      sprite_lab.html et le jeu lisent, memoire decodee comprise ; la foulee
 *      mesuree est celle du guide a 25 % pres ; aucun magenta ne reste ;
 *      l'attaque est gardee a pas egaux de TEMPS ;
 *   2. un monstre SYMETRIQUE (meme couleur a droite et a gauche) en vraies vues
 *      passe aussi — baton fin et sabre : le controle du miroir ne doit pas
 *      envoyer ses vraies planches en reprise payante (revue du 13/10/2026) ;
 *   3. un defaut fabrique par controle fait tomber CE controle, et ce controle
 *      tenait sur le vrai mannequin : copie retournee (SW et NW, habit colore ;
 *      monstre symetrique au repos et a la lame), arme dans l'autre main, vue
 *      qui se tourne vers la camera, zoom pendant l'attaque, direction qui
 *      flotte (marche et attaque), ciseaux sur place, trainee grise opaque,
 *      et, vus sur TOUT le clip couleur par couleur : le baton qui change de main
 *      en marchant (le cas de la revue), la lame qui change de main en courant,
 *      SW = SE et NW = NE retournes en marchant pour un monstre symetrique,
 *      ombre qui clignote, taille qui saute de 12 % ou de 30 %, jambes figees,
 *      ombre collee, boucle qui derive, glissade, franges de chrominance ;
 *   4. la bande de poses (compose.js) passe ses controles P sur la toile du
 *      mannequin, symetrique compris ; une toile dont SW est SE retourne, ou NW
 *      est NE retourne, tombe a P6 ; le guide place l'arme du bon cote dans
 *      chaque vue (une vraie rotation : SW et NE de signes opposes).
 * Ce qui n'est PAS tenu, mesure et ecrit (controles.js, SEUILS) : une copie
 * retournee de NW ou NE en course ou dans un geste pour un monstre symetrique,
 * et l'arme qui change de main pendant le coup.
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fabrique } = require('./outils/planches/fabrique_essai');
const { finis, indexe } = require('./outils/planches/chaine');
const { compose, P6_MIROIR } = require('./outils/planches/compose');
const { choisis } = require('./outils/planches/choix');
const G = require('./outils/planches/guide');
const M = require('./outils/planches/media');
const T = require('./outils/planches/traite');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const echoue = (f, id) => f.qc.controles.filter((c) => c.id === id && !c.ok);
const tombes = (f) => f.qc.controles.filter((c) => !c.ok).map((c) => c.id + ':' + (c.action || '') + ':' + (c.dir || '') + '=' + c.valeur).join(' ');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-chaine-'));

(async () => {
  console.log('-- 1. le vrai mannequin, 5 actions x 4 directions, planche du jeu et HD --');
  const vrai = await fabrique({ dossier: path.join(tmp, 'vrai') });
  const sortie = path.join(tmp, 'vrai', 'iso');
  const f = await finis({ nom: 'mannequin', pose: vrai.pose, clips: vrai.clips, sortie });
  ok(f.qc.verdict === 'ok', 'tous les controles passent (' + f.qc.controles.length + ' controles)' + (f.qc.verdict === 'ok' ? '' : ' — tombes : ' + tombes(f)));
  ok(f.format === 'swoge-planche-iso/1' && f.case === 256 && f.n === 8 && f.dirs.join() === 'se,sw,nw,ne', 'fiche : format, case 256, 8 images, directions nommees SE SW NW NE');
  ok(Object.keys(f.actions).join() === 'idle,walk,run,attack,jump', 'les 5 actions, dans l ordre');
  for (const [a, x] of Object.entries(f.actions)) {
    const im = await M.lisImage(path.join(sortie, x.f)), b = fs.readFileSync(path.join(sortie, x.f));
    ok(im.w === 8 * 256 && im.h === 4 * 256 && /\.webp$/.test(x.f) && b.toString('latin1', 12, 16) === 'VP8L' && x.mo === 8.4 && x.n === 8 && x.case === 256,
       a + ' : ' + x.f + ' fait 2048 x 1024, WebP SANS perte (' + b.toString('latin1', 12, 16) + '), ' + x.ko + ' Ko, ' + x.mo + ' Mo decodes');
    const h = x.hd && await M.lisImage(path.join(sortie, x.hd.f));
    ok(h && h.w === 16 * 512 && h.h === 4 * 512 && x.hd.n === 16 && x.hd.case === 512 && x.hd.mo === 67.1,
       a + ' HD : ' + (x.hd && x.hd.f) + ' fait ' + (h ? h.w + ' x ' + h.h : '?') + ' (16 colonnes de 512 : figure de 256 px), ' + (x.hd && x.hd.ko) + ' Ko, ' + (x.hd && x.hd.mo) + ' Mo decodes');
  }
  /* la figure de la HD fait deux fois celle du jeu (revue du 13/10/2026 : 128 px contre 225-229 aujourd'hui) */
  const hdw = await M.lisImage(path.join(sortie, f.actions.idle.hd.f)), c0 = new Uint8ClampedArray(512 * 512 * 4);
  for (let y = 0; y < 512; y++) c0.set(hdw.data.subarray((y * hdw.w) * 4, (y * hdw.w + 512) * 4), y * 512 * 4);
  const bh = T.bbox(T.masque(c0, 512, 512), 512, 512);
  ok(bh && bh.h >= 225, 'la figure HD (repos SE) fait ' + (bh && bh.h) + ' px de haut : au moins les 225 px des planches actuelles');
  ok(f.actions.idle.boucle && f.actions.walk.boucle && !f.actions.attack.boucle && !f.actions.jump.boucle, 'idle, walk, run bouclent ; attack et jump se jouent une fois');
  ok(f.actions.idle.hd.ips === 2 * f.actions.idle.ips && f.actions.walk.hd.ips === 2 * f.actions.walk.ips, 'la HD joue deux fois plus d images au meme rythme (repos ' + f.actions.idle.hd.ips + ' i/s, marche ' + f.actions.walk.hd.ips + ')');
  const ref = G.reference().pas_cycle_sur_corps;
  const attendu = { walk: ref.walk * f.corps, run: ref.run * f.corps };
  for (const a of ['walk', 'run']) ok(Math.abs(f.actions[a].pas / attendu[a] - 1) <= 0.25, a + ' : foulee mesuree ' + f.actions[a].pas + ' case/cycle contre ' + attendu[a].toFixed(3) + ' au guide (25 % pres)');
  ok(f.actions.walk.ips >= 6 && f.actions.walk.ips <= 10 && f.actions.run.ips > f.actions.walk.ips, 'la course tourne plus vite que la marche (' + f.actions.walk.ips + ' / ' + f.actions.run.ips + ' i/s)');
  ok(f.k > 1 && f.sol === 0.88 && f.corps === 0.5, 'ancre au sol 0,88, corps 0,5, facteur de dessin k = ' + f.k);
  /* aucun magenta : pas un pixel opaque a moins de 100 de la cle */
  let roses = 0;
  for (const x of Object.values(f.actions)) for (const fi of [x.f, x.hd.f]) {
    const im = await M.lisImage(path.join(sortie, fi));
    for (let i = 0; i < im.w * im.h; i++) if (im.data[i * 4 + 3] > 128 && Math.hypot(im.data[i * 4] - 255, im.data[i * 4 + 1], im.data[i * 4 + 2] - 255) < 100) roses++;
  }
  ok(roses === 0, 'aucun pixel opaque proche du magenta dans les planches, HD comprise [' + roses + ']');
  ok(f.sources.clips.length === 5 && f.sources.clips.every((c) => c.fps === 24 && /^[0-9a-f]{64}$/.test(c.sha256)), 'les sources sont tracees (sha256, 24 i/s)');
  const idx = indexe(sortie);
  ok(idx.length === 1 && idx[0].nom === 'mannequin' && idx[0].verdict === 'ok' && fs.existsSync(path.join(sortie, 'index.json')), 'index.json liste la planche (GitHub Pages ne liste pas les dossiers)');
  /* la grille commune (outils/planches/grille.js) : les memes mesures que sur les exemples AutoSprite */
  const Gr = require('./outils/planches/grille');
  const gj = await Gr.mesure(path.join(sortie, f.actions.walk.f), 8, 4), gh = await Gr.mesure(path.join(sortie, f.actions.walk.hd.f), 16, 4);
  ok(gj.case === 256 && gj.cases === 32 && gj.vides === 0 && gj.au_bord === 0 && gj.figure_px.med >= 115 && gj.figure_px.med <= 140 && gj.memoire_mo === 8.4
     && gh.case === 512 && gh.cases === 64 && gh.au_bord === 0 && gh.figure_px.med >= 2 * gj.figure_px.med - 4 && gh.memoire_mo === 67.1,
     'grille commune (marche) : figure ' + gj.figure_px.med + ' px dans 256 (jeu), ' + gh.figure_px.med + ' px dans 512 (HD), 0 case au bord, ' + gj.memoire_mo + ' / ' + gh.memoire_mo + ' Mo');

  /* l'attaque a pas egaux de TEMPS (revue du 13/10/2026 : 42 a 458 ms d'ecart reel, tous joues a 161 ms) */
  const att = vrai.clips.find((c) => c.action === 'attack'), s = await M.sonde(att.fichier);
  const V = await M.images(att.fichier, { x: 0, y: 0, w: s.w / 4, h: s.h });
  const P = await require('./outils/planches/chaine').reperesPose(vrai.pose, ['se', 'sw', 'nw', 'ne'], T.CLES.magenta), r = P.R.se, sv = s.w / P.w;
  const Fa = V.frames.map((fr) => T.place(T.detoure(fr, V.w, V.h, T.CLES.magenta), V.w, V.h, 0.5 * 256 / (r.h * sv), r.tx * sv, r.pied * sv, 256, 0.88).data);
  const ia = choisis('attack', Fa, Fa.map((d) => T.moitie(d, 256, 256)), 256, 24, 'se', 8, 0.88);
  const ecarts = ia.idx.slice(1).map((j, k) => j - ia.idx[k]), pasIdeal = (ia.b - ia.a) / 7;
  ok(ecarts.every((e) => Math.abs(e - pasIdeal) <= 1 + 0.5 * pasIdeal) && Math.abs(1 / ia.ips - pasIdeal / 24) < 1e-6,
     'attaque : images ' + ia.idx.join(',') + ' — ecarts ' + ecarts.join(',') + ' images (pas ' + pasIdeal.toFixed(2) + ', l impact garde), jouees a ' + ia.ips.toFixed(2) + ' i/s = leur vrai rythme');

  /* 17/10 : un repos qui ne boucle sur aucune fenetre (lot sonde du pirate : couture 2,39-2,70,
     seuil 1,8) passe en ALLER-RETOUR — la couture devient un pas d'image comme les autres */
  {
    const C = 64, h = 32, L = 49, Fd = [], Fdh = [];
    for (let i = 0; i < L; i++) {
      const d = new Uint8ClampedArray(C * C * 4), dh = new Uint8ClampedArray(h * h * 4);
      const x0 = 10 + Math.floor(i / 2);   /* un carre qui derive sans revenir : aucune boucle possible */
      for (let y = 20; y < 50; y++) for (let x = x0; x < x0 + 16; x++) { const o = (y * C + x) * 4; d[o] = 200; d[o + 3] = 255; }
      for (let y = 10; y < 25; y++) for (let x = x0 >> 1; x < (x0 >> 1) + 8; x++) { const o = (y * h + x) * 4; dh[o] = 200; dh[o + 3] = 255; }
      Fd.push(d); Fdh.push(dh);
    }
    const ir = choisis('idle', Fd, Fdh, C, 24, 'se', 8, 0.88, 16);
    const ecart = (a, b) => T.ecart(Fdh[a], Fdh[b], h * h);
    const pas = ir.idx.map((j, k) => ecart(j, ir.idx[(k + 1) % 8])), moy = pas.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
    ok(ir.allerRetour && ir.idx.join() === '0,12,24,36,48,36,24,12' && ir.idxHD.length === 16 && ir.idxHD[8] === 48 && ir.idxHD[15] === ir.idxHD[1],
       'repos qui ne boucle pas : aller-retour sur tout le clip (' + ir.idx.join(',') + '), HD aussi (16 images, retour au milieu)');
    ok(pas[7] / moy <= 1.05 && Math.abs(ir.ipsHD / ir.ips - 2) < 1e-9, 'la couture 7 -> 0 vaut un pas moyen (' + (pas[7] / moy).toFixed(2) + ', seuil 1,8) ; la HD joue deux fois plus d images au meme rythme');
  }

  console.log('\n-- 2. un monstre symetrique en vraies vues passe --');
  const parPalette = { null: f };
  for (const pal of ['sym', 'sabre']) {
    const d = await fabrique({ dossier: path.join(tmp, 'vrai_' + pal), palette: pal });
    const fs2 = await finis({ nom: 'sym', pose: d.pose, clips: d.clips, sortie: path.join(tmp, 'vrai_' + pal, 'iso'), hd: false });
    ok(fs2.qc.verdict === 'ok', (pal === 'sym' ? 'baton fin de la couleur du torse' : 'sabre (lame claire)') + ', 5 actions x 4 directions : tous les controles passent ('
       + fs2.qc.controles.length + ')' + (fs2.qc.verdict === 'ok' ? '' : ' — tombes : ' + tombes(fs2)));
    parPalette[pal] = fs2;
  }

  console.log('\n-- 3. un defaut fabrique par controle --');
  const cas = [
    ['SW = SE retourne et decale (habit colore)', { walk: { miroir: 'sw' } }, null, 'direction', (c) => c.dir === 'sw'],
    ['NW = NE retourne et decale (habit colore)', { walk: { miroir: 'nw' } }, null, 'direction', (c) => c.dir === 'nw'],
    ['monstre symetrique : SW = SE retourne (lame)', { idle: { miroir: 'sw' }, walk: { miroir: 'sw' } }, 'sabre', 'arme_cote', (c) => c.dir === 'sw'],
    ['monstre symetrique : NW = NE retourne au repos (baton)', { idle: { miroir: 'nw' } }, 'sym', 'miroir', (c) => c.dir === 'nw' && c.action === 'idle'],
    ['l arme passe dans la main gauche (lame)', { idle: { armeGauche: { sw: true } }, walk: { armeGauche: { sw: true } } }, 'sabre', 'arme_cote', (c) => c.dir === 'sw'],
    ['l arme change de main au repos, 1 image sur 2', { idle: { armeGauche: { sw: true } } }, 'sabre', 'arme_image', (c) => c.dir === 'sw'],
    /* deuxieme passage du 13/10/2026 : les deux cas de la revue que le banc laissait passer,
       vus sur TOUT le clip, couleur par couleur (cote, cote_presence, arme_saut) */
    ['le baton passe dans la main gauche la moitie du cycle en marchant (habit colore, SE : le cas de la revue)', { walk: { armeGauche: { se: true } } }, null, 'arme_saut', (c) => c.dir === 'se' && c.action === 'walk'],
    ['monstre symetrique (baton) : SW = SE retourne en marchant (le cas de la revue)', { walk: { miroir: 'sw' } }, 'sym', 'cote', (c) => c.dir === 'sw' && c.action === 'walk'],
    ['monstre symetrique (baton) : NW = NE retourne en marchant (la lame cachee de dos se montre)', { walk: { miroir: 'nw' } }, 'sym', 'cote_presence', (c) => c.dir === 'nw' && c.action === 'walk'],
    ['monstre symetrique (sabre) : la lame change de main en courant', { run: { armeGauche: { se: true } } }, 'sabre', 'arme_saut', (c) => c.dir === 'se' && c.action === 'run'],
    ['NE se tourne vers la camera au milieu du clip', { walk: { tourne: { ne: 'se' } } }, null, 'direction', (c) => c.dir === 'ne'],
    ['zoom de camera x1,30 pendant l attaque (NW)', { attack: { echelle: { nw: 1.3 } } }, null, 'taille_pose', (c) => c.dir === 'nw' && c.action === 'attack'],
    ['NE marche 12 % au-dessus du sol', { walk: { dy: { ne: -0.12 } } }, null, 'appui', (c) => c.dir === 'ne'],
    ['NE attaque 25 % au-dessus du sol', { attack: { dy: { ne: -0.25 } } }, null, 'appui', (c) => c.dir === 'ne' && c.action === 'attack'],
    ['ciseaux sur place (la jambe droite toujours devant)', { walk: { jambesSansAlterner: true } }, null, 'foulee', () => true],
    ['ciseaux sur place : la jambe de devant ne change pas de cote', { walk: { jambesSansAlterner: true } }, null, 'alternance', () => true],
    ['trainee grise opaque derriere la tete (SE)', { walk: { tache: { se: true } } }, null, 'residus', (c) => c.dir === 'se'],
    ['ombre qui clignote, 3 images sur 8 (SE)', { walk: { ombreClignote: { se: [80, 70, 20] } } }, null, 'sol', (c) => c.dir === 'se'],
    ['NW 12 % plus grand que sa pose', { walk: { echelle: { nw: 1.12 } } }, null, 'taille_dirs', () => true],
    ['NW 30 % plus grand que sa pose', { walk: { echelle: { nw: 1.3 } } }, null, 'taille_dirs', () => true],
    ['jambes figees', { walk: { jambesFigees: true } }, null, 'jambes', () => true],
    ['sol colle (ombre)', { walk: { ombre: true } }, null, 'sol', () => true],
    ['boucle qui ne se ferme pas', { walk: { derive: true } }, null, 'boucle_clip', () => true],
    ['la figure traverse son emplacement', { walk: { glisse: true } }, null, 'derive', () => true],
    ['franges de chrominance (sans la reprise du bord)', { walk: {} }, null, 'franges', () => true, { chroma: false }],
  ];
  for (const [nom, defauts, pal, id, filtre, opts] of cas) {
    const dos = path.join(tmp, 'd' + n);
    const d = await fabrique({ dossier: dos, actions: Object.keys(defauts), defauts, palette: pal || undefined });
    const fd = await finis(Object.assign({ nom: 'defaut', pose: d.pose, clips: d.clips, sortie: path.join(dos, 'iso'), hd: false }, opts || {}));
    const t = echoue(fd, id).filter(filtre);
    ok(fd.qc.verdict === 'a_revoir' && t.length > 0, nom + ' : `' + id + '` tombe (' + t.map((c) => (c.dir || c.action) + '=' + c.valeur + ' / seuil ' + c.seuil).join(', ') + ')');
    /* et ce controle tenait sur le vrai mannequin du meme habit (5 actions, section 1 ou 2), et y est MESURE */
    const vu = parPalette[pal || null].qc.controles.filter((c) => c.id === id);
    ok(vu.length > 0 && echoue(parPalette[pal || null], id).length === 0, nom + ' : `' + id + '` passait sur le vrai mannequin' + (pal ? ' (' + pal + ')' : '') + ' (' + vu.length + ' lignes)');
    fs.rmSync(dos, { recursive: true, force: true });
  }

  console.log('\n-- 4. la bande de poses et le guide --');
  const toile = path.join(tmp, 'toile.png');
  M.ecrisPng(G.toilePoses(), toile);
  const p = await compose(toile, path.join(tmp, 'bande.png'));
  ok(p.verdict === 'ok' && p.emplacements.length === 4, 'compose : 4 figures, sans sol, pas de miroir, cle ' + p.cle + ' (' + p.controles.map((c) => c.id + '=' + c.valeur).join(' ') + ')');
  const b = await M.lisImage(path.join(tmp, 'bande.png'));
  ok(b.w === 2000 && b.h === 800 && /^[0-9a-f]{64}$/.test(p.sha256), 'la bande fait 2000 x 800 (5:2), et son sha256 est donne pour demandes.json');
  for (const pal of ['sym', 'sabre']) {
    const ts = path.join(tmp, 'toile_' + pal + '.png'); M.ecrisPng(G.toilePoses(2048, 1024, pal), ts);
    const ps = await compose(ts, path.join(tmp, 'bande_' + pal + '.png'));
    const p6 = ps.controles.filter((c) => c.id === 'P6_miroir');
    ok(ps.verdict === 'ok' && p6.every((c) => c.ok), 'poses d un monstre symetrique (' + pal + ') en vraies vues : P6 passe (' + p6.map((c) => c.dir + '=' + c.valeur).join(' ') + ' / ' + P6_MIROIR + ')');
  }
  for (const copie of ['sw', 'nw']) {
    for (const pal of ['guide', 'sym']) {
      const tm = path.join(tmp, 'toile_miroir_' + copie + pal + '.png'); M.ecrisPng(G.toileMiroir(2048, 1024, copie, pal), tm);
      const pm = await compose(tm, path.join(tmp, 'bande_miroir_' + copie + pal + '.png'));
      const t6 = pm.controles.filter((c) => c.id === 'P6_miroir' && !c.ok);
      ok(pm.verdict === 'a_revoir' && t6.length === 1 && t6[0].dir === copie + '/' + G.MIROIR_DE[copie],
         'poses (' + pal + ') dont ' + copie.toUpperCase() + ' est ' + G.MIROIR_DE[copie].toUpperCase() + ' retourne : P6 tombe AVANT tout clip paye (' + t6.map((c) => c.dir + '=' + c.valeur).join(' ') + ')');
    }
  }
  const mr = G.reference().main_droite_moins_tronc_sur_corps;
  ok(mr.sw < -0.1 && mr.ne > 0.1 && Math.abs(mr.se + mr.sw) > 0.1, 'guide : la main de l arme change de cote entre SW et NE, et SW n est pas SE retourne (' + JSON.stringify(mr) + ')');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
