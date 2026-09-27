'use strict';
/* ============================================================================
 * LA DERNIERE IMAGE (derniere_image.js)
 * Une vraie video (fabriquee ici par ffmpeg) : sa derniere image revient en
 * JPEG ; une adresse hors des fournisseurs n'est pas telechargee ; sans ffmpeg
 * ou sur une video illisible, null — jamais une exception.
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require('./derniere_image');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

(async () => {
  let aFfmpeg = true;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { aFfmpeg = false; }
  const mp4 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'di-')), 'v.mp4');
  if (aFfmpeg) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'color=c=blue:size=320x240:rate=10:duration=1', '-filter_complex', '[0][1]concat=n=2:v=1', '-pix_fmt', 'yuv420p', mp4]);
  const lus = [];
  const fauxFetch = async (u) => { lus.push(u); return { ok: true, status: 200, arrayBuffer: async () => fs.readFileSync(mp4) }; };
  const d = D.cree({ fetch: fauxFetch });
  if (aFfmpeg) {
    const r = await d.derniere('https://vidgen.x.ai/abc.mp4');
    ok(/^data:image\/jpeg;base64,/.test(r || ''), 'une video de xAI : sa derniere image revient en JPEG');
    /* la video est rouge puis bleue : la derniere image doit etre BLEUE */
    const jpg = path.join(os.tmpdir(), 'di-' + process.pid + '.jpg');
    fs.writeFileSync(jpg, Buffer.from(r.split(',')[1], 'base64'));
    const px = execFileSync('ffmpeg', ['-v', 'error', '-i', jpg, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    ok(px[2] > 150 && px[0] < 80, 'et c est bien la DERNIERE (bleue), pas la premiere (rouge) : rgb ' + [...px].join(','));
    ok(!!(await d.derniere('https://v15-kling-fdl.klingai.com/bs2/x.mp4')), 'une video de Kling aussi');
  } else console.log('   (ffmpeg absent ici : les deux premieres verifications sautent)');
  const avant = lus.length;
  ok((await d.derniere('https://evil.example/x.mp4')) === null && (await d.derniere('http://vidgen.x.ai/x.mp4')) === null && lus.length === avant,
     'une autre adresse, ou du http, n est jamais telechargee');
  const sans = D.cree({ fetch: fauxFetch, ffmpeg: '/nulle/part/ffmpeg' });
  ok((await sans.derniere('https://vidgen.x.ai/abc.mp4')) === null && /ffmpeg missing/.test(sans.MESURE.dernierEchec), 'sans ffmpeg : null, et le motif est garde');
  const casse = D.cree({ fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('pas une video') }) });
  ok((await casse.derniere('https://vidgen.x.ai/abc.mp4')) === null && casse.MESURE.echecs === 1, 'une video illisible : null, compte en echec');
  const expire = D.cree({ fetch: async () => ({ ok: false, status: 403 }) });
  ok((await expire.derniere('https://vidgen.x.ai/abc.mp4')) === null && /HTTP 403/.test(expire.MESURE.dernierEchec), 'une video expiree (403) : null');
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
