'use strict';
/* /bugbounty — LA PORTE PUBLIQUE DU BUG BOUNTY + OSINT
 *
 * Les gardes de fond vivent dans bugbounty.js (bugbounty.test.js). Ce qui se
 * joue ICI est propre a la route :
 *   - la recon REFUSE (403) sans autorisation, AVANT de taper chez un tiers ;
 *   - une case au bon texte (attestation) la debloque, et l'attestation est journalisee ;
 *   - le pre-audit d'une source ne demande pas d'autorisation (on audite ce qu'on nous colle) ;
 *   - GET /bugbounty donne le texte exact de la case.
 * Le faux internet est pose AVANT server.js : aucun essai ne sort de la machine.
 */
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-route-'));
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

/* Le faux internet pour l'OSINT : la recon autorisee doit pouvoir aboutir
   sans sortir de la machine. */
const R = require('./osint');
const APPELS = [];
R._reseau(async (u) => {
  APPELS.push(String(u));
  if (String(u) === 'https://mine.io/') return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<title>Mine</title>' };
  return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
});
R._resolveur({ v4: async (d) => (d === 'mine.io' ? ['8.8.8.8'] : []), v6: async () => [], mx: async () => [], ns: async () => [], txt: async () => [] });

const bb = require('./bugbounty');

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const post = async (u, body) => {
    const r = await fetch('http://127.0.0.1:' + port + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { code: r.status, j: await r.json().catch(() => null) };
  };
  const get = async (u) => { const r = await fetch('http://127.0.0.1:' + port + u); return { code: r.status, j: await r.json().catch(() => null) }; };

  /* On intercepte UNIQUEMENT InternetDB (le reste — localhost — reste reel). */
  const vraiFetch = global.fetch;
  global.fetch = (u, o) => /internetdb\.shodan\.io/.test(String(u))
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ports: [22, 443], cpes: ['nginx'], vulns: [], hostnames: ['node.local'], tags: [] }) })
    : vraiFetch(u, o);

  console.log('-- GET /bugbounty donne le texte exact de la case --');
  let r = await get('/bugbounty');
  ok(r.code === 200 && r.j.attestationTexte === bb.ATTESTATION_TEXTE, 'la route rend le texte d attestation, au mot pres');

  console.log('\n-- la recon REFUSE sans autorisation, et ne tape chez personne --');
  APPELS.length = 0;
  r = await post('/bugbounty/recon', { cible: 'mine.io' });
  ok(r.code === 403 && /tick the authorization box/.test(r.j.raison) && r.j.attestationTexte === bb.ATTESTATION_TEXTE,
     'sans programme ni case : 403, et on redonne le texte a cocher');
  ok(APPELS.length === 0, 'et AUCUN appel reseau n est parti : on refuse avant de toucher la cible');

  console.log('\n-- une case au MAUVAIS texte ne debloque rien --');
  r = await post('/bugbounty/recon', { cible: 'mine.io', attestation: { autorise: true, texte: 'ok je sais' } });
  ok(r.code === 403 && /does not match/.test(r.j.raison), 'un texte approximatif : toujours 403');

  console.log('\n-- la case au BON texte debloque la recon (lecture seule) et journalise --');
  r = await post('/bugbounty/recon', { cible: 'mine.io', attestation: { autorise: true, texte: bb.ATTESTATION_TEXTE, qui: 'enzo' } });
  ok(r.code === 200 && r.j.ok && r.j.mode === 'attested' && r.j.releve, 'attestation exacte : 200, recon effectuee');
  ok(APPELS.some((u) => /mine\.io/.test(u)), 'et cette fois la recon a bien lu la cible (via osint.js)');
  const att = path.join(BAC, 'bugbounty', 'attestations.jsonl');
  ok(fs.existsSync(att) && /enzo/.test(fs.readFileSync(att, 'utf8')), 'l attestation est journalisee (qui, cible, texte)');

  console.log('\n-- un programme couvrant la cible autorise sans case --');
  APPELS.length = 0;
  r = await post('/bugbounty/recon', { cible: 'mine.io', programme: { nom: 'ACME', scope: ['*.mine.io', 'mine.io'] } });
  ok(r.code === 200 && r.j.mode === 'program', 'dans le scope d un programme : autorise (mode program)');

  console.log('\n-- le pre-audit d une source ne demande pas d autorisation --');
  r = await post('/bugbounty/preaudit', { source: 'contract T { address o; function setOwner(address a) public { o = a; } }' });
  ok(r.code === 200 && r.j.ok && r.j.classes.includes('access-control') && /not a verdict/.test(r.j.note),
     'une source collee est auditee (controle d acces trouve), et c est dit « pas un verdict »');
  r = await post('/bugbounty/preaudit', { source: 'x' });
  ok(r.code === 400, 'une source vide est refusee proprement');

  console.log('\n-- l exposition passive et le .onion : la meme garde, aucun reseau sans autorisation --');
  APPELS.length = 0;
  r = await post('/bugbounty/exposure', { ip: '8.8.8.8' });
  ok(r.code === 403 && /tick the authorization box/.test(r.j.raison), 'exposure sans autorisation : 403 (aucun appel a InternetDB)');
  r = await post('/bugbounty/onion', { url: 'http://abcdefghij234567abcdefghij234567abcdefghij234567abcdefgh.onion/' });
  ok(r.code === 403 && /tick the authorization box/.test(r.j.raison), 'onion sans autorisation : 403, avant tout');
  /* Avec attestation mais sans TOR_SOCKS, le .onion repond 503 « Tor non configure » (toujours pas de reseau). */
  r = await post('/bugbounty/onion', { url: 'http://abcdefghij234567abcdefghij234567abcdefghij234567abcdefgh.onion/', attestation: { autorise: true, texte: bb.ATTESTATION_TEXTE } });
  ok(r.code === 503 && /Tor is not configured/.test(r.j.raison), 'onion autorise mais sans demon Tor : 503, il le dit (rien ne sort)');

  console.log('\n-- mon exposition (mon IP, autorisee par construction) + type d appareil --');
  r = await get('/bugbounty/myexposure');
  ok(r.code === 200 && r.j.ok && r.j.mine === true && r.j.device && r.j.device.type, 'GET /myexposure : lit MON IP, rend l exposition et le type d appareil, sans attestation');
  global.fetch = vraiFetch;

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.message || e)); process.exit(1); });
