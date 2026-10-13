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
 *      les planches font 8 colonnes x 4 lignes de 256, la fiche dit tout ce
 *      que sprite_lab.html et le jeu lisent ; la foulee mesuree est celle du
 *      guide a 25 % pres ; aucun magenta ne reste ;
 *   2. un defaut fabrique par controle fait tomber CE controle :
 *        miroir (SW = SE retourne, decale en phase), taille entre directions
 *        (NW 1,3 fois plus grand que sa pose), jambes (pieds figes), sol
 *        (ombre collee), boucle (foulee qui derive), glisse (la figure
 *        traverse son emplacement) ;
 *   3. la bande de poses (compose.js) passe ses controles P sur la toile du
 *      mannequin, et le guide place l'arme du bon cote dans chaque vue (une
 *      vraie rotation : SW et NE de signes opposes, pas un miroir de SE).
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fabrique } = require('./outils/planches/fabrique_essai');
const { finis, indexe } = require('./outils/planches/chaine');
const { compose } = require('./outils/planches/compose');
const G = require('./outils/planches/guide');
const M = require('./outils/planches/media');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const echoue = (f, id) => f.qc.controles.filter((c) => c.id === id && !c.ok);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-chaine-'));

(async () => {
  console.log('-- 1. le vrai mannequin, 5 actions x 4 directions --');
  const vrai = await fabrique({ dossier: path.join(tmp, 'vrai') });
  const sortie = path.join(tmp, 'vrai', 'iso');
  const f = await finis({ nom: 'mannequin', pose: vrai.pose, clips: vrai.clips, sortie });
  const rate = f.qc.controles.filter((c) => !c.ok);
  ok(f.qc.verdict === 'ok', 'tous les controles passent (' + f.qc.controles.length + ' controles)' + (rate.length ? ' — tombes : ' + rate.map((c) => c.id + ':' + (c.action || '') + ':' + (c.dir || '') + '=' + c.valeur).join(' ') : ''));
  ok(f.format === 'swoge-planche-iso/1' && f.case === 256 && f.n === 8 && f.dirs.join() === 'se,sw,nw,ne', 'fiche : format, case 256, 8 images, directions nommees SE SW NW NE');
  ok(Object.keys(f.actions).join() === 'idle,walk,run,attack,jump', 'les 5 actions, dans l ordre');
  for (const [a, x] of Object.entries(f.actions)) {
    const im = await M.lisImage(path.join(sortie, x.f));
    ok(im.w === 8 * 256 && im.h === 4 * 256 && /\.webp$/.test(x.f), a + ' : ' + x.f + ' fait 2048 x 1024 (8 colonnes x 4 directions)');
  }
  ok(f.actions.idle.boucle && f.actions.walk.boucle && !f.actions.attack.boucle && !f.actions.jump.boucle, 'idle, walk, run bouclent ; attack et jump se jouent une fois');
  const ref = G.reference().pas_cycle_sur_corps;
  const attendu = { walk: ref.walk * f.corps, run: ref.run * f.corps };
  for (const a of ['walk', 'run']) ok(Math.abs(f.actions[a].pas / attendu[a] - 1) <= 0.25, a + ' : foulee mesuree ' + f.actions[a].pas + ' case/cycle contre ' + attendu[a].toFixed(3) + ' au guide (25 % pres)');
  ok(f.actions.walk.ips >= 6 && f.actions.walk.ips <= 10 && f.actions.run.ips > f.actions.walk.ips, 'la course tourne plus vite que la marche (' + f.actions.walk.ips + ' / ' + f.actions.run.ips + ' i/s)');
  ok(f.k > 1 && f.sol === 0.88 && f.corps === 0.5, 'ancre au sol 0,88, corps 0,5, facteur de dessin k = ' + f.k);
  /* aucun magenta : pas un pixel opaque a moins de 100 de la cle */
  let roses = 0;
  for (const x of Object.values(f.actions)) {
    const im = await M.lisImage(path.join(sortie, x.f));
    for (let i = 0; i < im.w * im.h; i++) if (im.data[i * 4 + 3] > 128 && Math.hypot(im.data[i * 4] - 255, im.data[i * 4 + 1], im.data[i * 4 + 2] - 255) < 100) roses++;
  }
  ok(roses === 0, 'aucun pixel opaque proche du magenta dans les planches [' + roses + ']');
  ok(f.sources.clips.length === 5 && f.sources.clips.every((c) => c.fps === 24 && /^[0-9a-f]{64}$/.test(c.sha256)), 'les sources sont tracees (sha256, 24 i/s)');
  const idx = indexe(sortie);
  ok(idx.length === 1 && idx[0].nom === 'mannequin' && idx[0].verdict === 'ok' && fs.existsSync(path.join(sortie, 'index.json')), 'index.json liste la planche (GitHub Pages ne liste pas les dossiers)');

  console.log('\n-- 2. un defaut fabrique par controle --');
  const cas = [
    ['miroir', { miroir: true }, 'miroir', (c) => c.dir === 'sw/se'],
    ['taille entre directions', { echelle: { nw: 1.3 } }, 'taille_dirs', () => true],
    ['jambes figees', { jambesFigees: true }, 'jambes', () => true],
    ['sol colle (ombre)', { ombre: true }, 'sol', () => true],
    ['boucle qui ne se ferme pas', { derive: true }, 'boucle_clip', () => true],
    ['glisse', { glisse: true }, 'glisse', () => true],
  ];
  for (const [nom, defaut, id, filtre] of cas) {
    const d = await fabrique({ dossier: path.join(tmp, id), actions: ['walk'], defauts: { walk: defaut } });
    const fd = await finis({ nom: 'defaut', pose: d.pose, clips: d.clips, sortie: path.join(tmp, id, 'iso') });
    const t = echoue(fd, id).filter(filtre);
    ok(fd.qc.verdict === 'a_revoir' && t.length > 0, nom + ' : `' + id + '` tombe (' + t.map((c) => (c.dir || c.action) + '=' + c.valeur + ' / seuil ' + c.seuil).join(', ') + ')');
    /* et ce controle tenait sur le vrai mannequin */
    ok(echoue(f, id).length === 0, nom + ' : `' + id + '` passait sur le vrai mannequin');
  }

  console.log('\n-- 3. la bande de poses et le guide --');
  const toile = path.join(tmp, 'toile.png');
  M.ecrisPng(G.toilePoses(), toile);
  const p = await compose(toile, path.join(tmp, 'bande.png'));
  ok(p.verdict === 'ok' && p.emplacements.length === 4, 'compose : 4 figures, sans sol, pas de miroir, cle ' + p.cle + ' (' + p.controles.map((c) => c.id + '=' + c.valeur).join(' ') + ')');
  const b = await M.lisImage(path.join(tmp, 'bande.png'));
  ok(b.w === 2000 && b.h === 800 && /^[0-9a-f]{64}$/.test(p.sha256), 'la bande fait 2000 x 800 (5:2), et son sha256 est donne pour demandes.json');
  const mr = G.reference().main_droite_moins_tronc_sur_corps;
  ok(mr.sw < -0.1 && mr.ne > 0.1 && Math.abs(mr.se + mr.sw) > 0.1, 'guide : la main de l arme change de cote entre SW et NE, et SW n est pas SE retourne (' + JSON.stringify(mr) + ')');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
