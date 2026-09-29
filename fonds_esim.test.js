'use strict';
/* fonds_esim.js : trois images de fond faites UNE fois par Kling, jamais refaites, un echec
   retente au prochain appel seulement, rien sans Kling, une reponse qui n'est pas une image
   jamais gardee ; la route ne sert que /esim/fond/1..9.jpg. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./fonds_esim');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

(async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'fonds-'));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20000, 7)]);
  let actif = false, rate = 1;
  const demandes = [];
  const kling = { actif: () => actif, image: async (q) => { demandes.push(q); if (rate-- > 0) return { ok: false, raison: 'Kling failed: busy' }; return { ok: true, url: 'https://cdn.kling/x.jpg', estimationUsd: 0.028 }; } };
  let reponse = jpeg;
  const S = F.cree({ kling, dossier, telecharge: async () => reponse, journal: () => {} });

  let r = await S.prepare();
  ok(r.faites === 0 && r.manquantes === 3 && demandes.length === 0, 'sans Kling : rien n est demande');
  actif = true;
  r = await S.prepare();
  ok(r.faites === 2 && r.manquantes === 1 && S.MESURE.echecs === 1, 'Kling rate une fois : deux images faites, la troisieme reste a faire');
  ok(demandes.every((q) => q.format === '16:9' && /No text, no letters, no logos/.test(q.prompt)), 'format 16:9, et la consigne : aucun texte ni logo');
  r = await S.prepare();
  ok(r.faites === 1 && r.manquantes === 0 && demandes.length === 4, 'au passage suivant, seule l image manquante est demandee');
  r = await S.prepare();
  ok(r.faites === 0 && demandes.length === 4, 'toutes faites : Kling n est plus jamais appele');
  ok(Math.abs(S.MESURE.depenseUsd - 0.084) < 1e-9, 'depense comptee : 3 x 0,028 $ = 0,084 $');
  ok(S.lis(1).equals(jpeg) && S.lis(0) === null && S.lis(4) === null && S.lis('1.5') === null && S.liste().join() === '1,2,3', 'lis(1..3) seulement');

  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fonds-'));
  reponse = Buffer.from('<html>error</html>');
  const S2 = F.cree({ kling: { actif: () => true, image: async () => ({ ok: true, url: 'https://x/y' }) }, dossier: d2, telecharge: async () => reponse, journal: () => {} });
  r = await S2.prepare();
  ok(r.faites === 0 && S2.liste().length === 0, 'une reponse qui n est pas une image n est jamais gardee');

  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  ok(/\/\^\\\/esim\\\/fond\\\/\[1-9\]\\\.jpg\$\//.test(srv) && /process\.env\.ESIM_FONDS !== '0' && require\.main === module/.test(srv), 'la route n accepte que /esim/fond/<chiffre>.jpg ; la fabrication seulement au vrai demarrage (ESIM_FONDS=0 coupe)');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
