'use strict';
/*
 * LE COMPTEUR DE VUES DE SWOGE TV.
 *
 * Commun a tous les joueurs, et borne : un identifiant de chaine par appel,
 * une forme stricte, mille chaines au plus. Rien par joueur, aucune adresse.
 * On demarre le serveur sur un volume vide, on compte, on relit.
 */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), assert = require('assert');
let n = 0; const ok = (c, m) => { n++; assert.ok(c, m); console.log('  ok   ' + m); };
(async () => {
  const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-tv-'));
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: bac, RPC_URL: '', ODDS_API_KEY: '', TG_BOT_TOKEN: '', ADMIN_KEY: 'k' }), stdio: ['ignore', 'pipe', 'pipe'] });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/health'); if (r.ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 250)); }
  try {
    let r = await fetch(base + '/tv/vues'); const j0 = await r.json();
    ok(r.status === 200 && j0.vues && Object.keys(j0.vues).length === 0, 'au depart, personne n a rien regarde');
    ok(r.headers.get('access-control-allow-origin') === '*', 'et la route se lit depuis le site');
    const poste = (id) => fetch(base + '/tv/vues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    for (let i = 0; i < 3; i++) await poste('RTFrance.fr');
    await poste('BFMTV.fr');
    r = await fetch(base + '/tv/vues'); const j1 = await r.json();
    ok(j1.vues['RTFrance.fr'] === 3 && j1.vues['BFMTV.fr'] === 1, 'trois vues et une vue, comptees en commun');
    const cles = Object.keys(j1.vues); ok(cles[0] === 'RTFrance.fr', 'la plus vue en tete');
    r = await poste('<script>alert(1)</script>'); ok(r.status === 400, 'un identifiant qui n a pas la forme d une chaine est refuse');
    r = await poste('x'); ok(r.status === 400, 'et un identifiant trop court aussi');
    ok(fs.existsSync(path.join(bac, 'tv_vues.json')), 'le compteur est sur le volume, il survit a un redemarrage');
    const brut = JSON.parse(fs.readFileSync(path.join(bac, 'tv_vues.json'), 'utf8'));
    ok(Object.values(brut).every((v) => typeof v === 'number'), 'et ne porte que des nombres — rien par joueur, aucune adresse');
    console.log(`\ntv_vues.test.js : ${n} verifications OK`);
  } finally { srv.kill('SIGTERM'); }
})().catch((e) => { console.log('  RATE ' + e.message); process.exit(1); });
